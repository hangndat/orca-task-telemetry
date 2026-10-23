import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'vitest';
import { openReadOnlyTelemetryDb } from '../dist/db/read-only.js';
import { buildTraceReport, formatTraceReportText } from '../dist/reports/trace.js';
import { at, oidA, profile, setupTraceDb } from './helpers/trace-slice3-harness.mjs';

// Synthetic/redacted fixture, not live integration evidence.
function ctx(db) { return { db, profile: profile(), close() {} }; }

test('trace report dedupes Issue and PR usage while retaining repeated PR/commit paths and unknown cost', () => {
  const fixture = setupTraceDb();
  try {
    const report = buildTraceReport(ctx(fixture.db), '3');
    assert.equal(report.issueUsage.sessionCount, 3);
    assert.equal(report.issueUsage.snapshotCount, 2);
    assert.equal(report.issueUsage.missingSnapshotCount, 1);
    assert.deepEqual(report.issueUsage.cost, { amountUsd: null, kind: 'unknown',
      knownAmountUsd: 1.25, unknownSessionCount: 2 });
    assert.equal(report.pullRequests.length, 2);
    assert.ok(report.pullRequests.every(pr => pr.usage.sessionCount === 1));
    assert.ok(report.pullRequests.every(pr => pr.usage.cost.amountUsd === 1.25));
    assert.ok(report.pullRequests.every(pr => pr.commits.length === 2));
    assert.ok(report.pullRequests.every(pr => pr.commits.every(commit =>
      commit.sessionKeys.length === 1 && commit.usage.sessionCount === 1)));
    assert.deepEqual(report.pullRequests[0].sessions.map(s => s.sessionKey), ['codex:codeburn:s1']);
    assert.ok(report.issueSessions.every(s => s.orcaReference.status === 'unknown'));
    assert.equal(report.pullRequests[0].mergedAt, null);
    assert.equal(report.pullRequests[0].isDraft, true);
    assert.match(formatTraceReportText(report), /do not add path totals/);
    assert.match(formatTraceReportText(report), /Commit a{40}/);
    assert.equal(report.pullRequests[0].issueRelation.source, 'closingIssuesReferences');
  } finally { fixture.close(); }
});

test('stale and unknown relations remain visible with retained lastVerifiedAt; no PR link is explicit', () => {
  const fixture = setupTraceDb();
  try {
    fixture.db.prepare(`UPDATE issue_pull_relations SET status = 'unknown' WHERE pull_node_id = 'PR_7'`).run();
    fixture.db.prepare(`UPDATE pull_commits SET status = 'stale' WHERE pull_node_id = 'PR_7' AND oid = ?`).run(oidA);
    const report = buildTraceReport(ctx(fixture.db), 'https://github.com/o/r/issues/3');
    assert.equal(report.pullRequests[0].issueRelation.status, 'unknown');
    assert.equal(report.pullRequests[0].issueRelation.lastVerifiedAt, at);
    assert.equal(report.pullRequests[0].commits[0].relation.status, 'stale');
    assert.ok(report.warnings.some(w => w.includes('not current')));
    fixture.db.prepare('DELETE FROM session_commit_links').run();
    fixture.db.prepare('DELETE FROM session_pull_links').run();
    const noPr = buildTraceReport(ctx(fixture.db), 'I_1');
    assert.equal(noPr.pullRequests.length, 0);
    assert.equal(noPr.issueUsage.sessionCount, 3);
    assert.ok(noPr.warnings.some(w => w.includes('No manually linked PR')));
  } finally { fixture.close(); }
});

test('trace reporting uses read-only transaction and leaves DB bytes and WAL absent', async () => {
  const fixture = setupTraceDb();
  try {
    const before = readFileSync(fixture.dbPath);
    const handle = await openReadOnlyTelemetryDb(fixture.dbPath);
    try {
      assert.equal(buildTraceReport(ctx(handle.db), 'I_1').pullRequests.length, 2);
      assert.throws(() => handle.db.exec('DELETE FROM session_links'));
    } finally { handle.release(); }
    assert.deepEqual(readFileSync(fixture.dbPath), before);
    assert.equal(existsSync(`${fixture.dbPath}-wal`), false);
  } finally { fixture.close(); }
});

test('missing Issue and corrupt snapshot fail with structured errors', () => {
  const fixture = setupTraceDb();
  try {
    assert.throws(() => buildTraceReport(ctx(fixture.db), '404'), e => e.code === 'report_setup');
    fixture.db.prepare(`UPDATE usage_snapshots SET tokens_json = 'invalid' WHERE session_key = 'codex:codeburn:s1'`).run();
    assert.throws(() => buildTraceReport(ctx(fixture.db), '3'), e => e.code === 'db_schema_drift');
  } finally { fixture.close(); }
});
