import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'vitest';
import { openReadOnlyTelemetryDb } from '../dist/db/read-only.js';
import { buildTraceReport, formatTraceReportText } from '../dist/reports/trace.js';
import { at, oidA, oidB, profile, setupTraceDb } from './helpers/trace-slice3-harness.mjs';

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
    assert.deepEqual(report.pullRequests[0].sessions.map(s => s.sessionKey), ['codex:agent-top:s1']);
    assert.ok(report.issueSessions.every(s => s.orcaReference.status === 'unknown'));
    assert.equal(report.pullRequests[0].mergedAt, null);
    assert.equal(report.pullRequests[0].isDraft, true);
    assert.match(formatTraceReportText(report), /do not add path totals/);
    assert.match(formatTraceReportText(report), /Commit a{40}/);
    assert.equal(report.pullRequests[0].issueRelation.source, 'closingIssuesReferences');
  } finally { fixture.close(); }
});

test('redacted golden text and JSON keep provider tokens at each scope without adding repeated paths', () => {
  const fixture = setupTraceDb();
  try {
    const db = fixture.db;
    db.prepare(`INSERT INTO usage_sessions (session_key, provider, source, raw_id)
      VALUES ('claude:agent-top:c1', 'claude', 'agent-top', 'c1')`).run();
    db.prepare(`INSERT INTO usage_snapshots
      (session_key, observed_at, tokens_json, cost_amount_usd, cost_kind)
      VALUES ('claude:agent-top:c1', ?, ?, 0.5, 'estimated_api_equivalent')`)
      .run(at, JSON.stringify({ provider: 'claude', input: 7, output: 4,
        cacheRead: 1, cacheWrite: 2, reasoning: null }));
    db.prepare(`INSERT INTO session_links (session_key, issue_node_id, method, linked_at)
      VALUES ('claude:agent-top:c1', 'I_1', 'manual', ?)` ).run(at);
    db.prepare(`INSERT INTO session_pull_links
      (session_key, issue_node_id, pull_node_id, method, linked_at)
      VALUES ('claude:agent-top:c1', 'I_1', 'PR_7', 'manual', ?)` ).run(at);
    db.prepare(`INSERT INTO session_commit_links (session_key, pull_node_id, oid, method, linked_at)
      VALUES ('claude:agent-top:c1', 'PR_7', ?, 'manual', ?)` ).run(oidA, at);
    db.prepare(`INSERT INTO session_pull_links
      (session_key, issue_node_id, pull_node_id, method, linked_at)
      VALUES ('codex:agent-top:s3', 'I_1', 'PR_8', 'manual', ?)` ).run(at);
    db.prepare(`INSERT INTO session_commit_links (session_key, pull_node_id, oid, method, linked_at)
      VALUES ('codex:agent-top:s3', 'PR_8', ?, 'manual', ?)` ).run(oidB, at);

    const report = buildTraceReport(ctx(db), '3');
    const scopeUsage = [report.issueUsage, ...report.pullRequests.flatMap(pr =>
      [pr.usage, ...pr.commits.map(commit => commit.usage)])];
    const jsonGolden = scopeUsage.map(usage => ({
      sessions: usage.sessionCount, missing: usage.missingSnapshotCount,
      providers: usage.byProvider.map(p => [p.provider, p.sessionCount, p.missingSnapshotCount,
        p.knownTokens.input, p.knownTokens.output, p.knownTokens.cacheRead,
        p.knownTokens.cacheWrite, p.knownTokens.reasoning, p.tokensComplete]),
    }));
    assert.deepEqual(jsonGolden, [
      { sessions: 4, missing: 1, providers: [
        ['claude', 1, 0, 7, 4, 1, 2, null, true],
        ['codex', 3, 1, 20, 4, 6, 0, null, false]] },
      { sessions: 2, missing: 0, providers: [
        ['claude', 1, 0, 7, 4, 1, 2, null, true],
        ['codex', 1, 0, 10, 2, 3, 0, null, true]] },
      { sessions: 2, missing: 0, providers: [
        ['claude', 1, 0, 7, 4, 1, 2, null, true],
        ['codex', 1, 0, 10, 2, 3, 0, null, true]] },
      { sessions: 1, missing: 0, providers: [
        ['codex', 1, 0, 10, 2, 3, 0, null, true]] },
      { sessions: 2, missing: 1, providers: [
        ['codex', 2, 1, 10, 2, 3, 0, null, false]] },
      { sessions: 1, missing: 0, providers: [
        ['codex', 1, 0, 10, 2, 3, 0, null, true]] },
      { sessions: 2, missing: 1, providers: [
        ['codex', 2, 1, 10, 2, 3, 0, null, false]] },
    ]);
    assert.equal(report.issueUsage.byProvider.find(p => p.provider === 'codex').knownTokens.input, 20);
    const tokenLines = formatTraceReportText(report).split('\n').filter(line => line.includes(' known tokens:'));
    const claude = 'claude known tokens: in=7 out=4 cacheR=1 cacheW=2 reasoning=unknown; complete=true; sessions=1; missing snapshots=0';
    const codex = (input, complete, sessions, missing) =>
      `codex known tokens: in=${input} out=${input / 5} cacheR=${input * 3 / 10} cacheW=0 reasoning=unknown; complete=${complete}; sessions=${sessions}; missing snapshots=${missing}`;
    assert.deepEqual(tokenLines, [
      `  ${claude}`, `  ${codex(20, false, 3, 1)}`,
      `      ${claude}`, `      ${codex(10, true, 1, 0)}`,
      `      ${claude}`, `      ${codex(10, true, 1, 0)}`,
      `      ${codex(10, true, 1, 0)}`,
      `      ${codex(10, false, 2, 1)}`,
      `      ${codex(10, true, 1, 0)}`,
      `      ${codex(10, false, 2, 1)}`,
    ]);
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
    fixture.db.prepare(`UPDATE usage_snapshots SET tokens_json = 'invalid' WHERE session_key = 'codex:agent-top:s1'`).run();
    assert.throws(() => buildTraceReport(ctx(fixture.db), '3'), e => e.code === 'db_schema_drift');
  } finally { fixture.close(); }
});
