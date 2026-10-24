import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { buildOverheadReport, formatOverheadReportText } from '../dist/reports/overhead.js';
import { openTelemetryDatabase } from '../dist/db/index.js';
import {
  attempt,
  ctx,
  insertRunGraph,
  insertSession,
  isoMinus,
  linkRole,
  setupOverheadDb,
} from './helpers/overhead-harness.mjs';
import {
  appHomeInventory,
  initBareRepo,
  installDatasetInHome,
  linkAlphaSessions,
  runCliReport,
  writeReportsProfile,
} from './helpers/reports-harness.mjs';

const testDir = dirname(fileURLToPath(import.meta.url));
const cli = resolve(testDir, '../dist/cli.js');

const NOW = new Date('2026-10-24T12:00:00.000Z');

function freshAttempts(db, host, run) {
  attempt(db, { source: 'orca', hostId: host, runId: run, startedAt: isoMinus(NOW, 3700),
    completedAt: isoMinus(NOW, 3600), status: 'success' });
  attempt(db, { source: 'codeburn', provider: 'claude', startedAt: isoMinus(NOW, 3700),
    completedAt: isoMinus(NOW, 3600), status: 'success' });
  attempt(db, { source: 'codeburn', provider: 'codex', startedAt: isoMinus(NOW, 3700),
    completedAt: isoMinus(NOW, 3600), status: 'success' });
}

test('V14-01: one coordinator, two workers across two Dispatches, multi-provider — provider buckets, dispatch count, and overheadShare/overheadPerWorkerCost', () => {
  const fixture = setupOverheadDb();
  try {
    const { db } = fixture;
    insertRunGraph(db, 'host-a', 'run-1', ['dispatch-1', 'dispatch-2']);
    insertSession(db, { key: 'claude:codeburn:coord-c', provider: 'claude', rawId: 'coord-c',
      snapshot: { observedAt: isoMinus(NOW, 100), cost: 2.0 } });
    insertSession(db, { key: 'codex:codeburn:coord-x', provider: 'codex', rawId: 'coord-x',
      snapshot: { observedAt: isoMinus(NOW, 100), cost: 1.5, tokensOverride: { reasoning: 3 } } });
    insertSession(db, { key: 'claude:codeburn:w1', provider: 'claude', rawId: 'w1',
      snapshot: { observedAt: isoMinus(NOW, 100), cost: 1.0 } });
    insertSession(db, { key: 'codex:codeburn:w2', provider: 'codex', rawId: 'w2',
      snapshot: { observedAt: isoMinus(NOW, 100), cost: 0.5, tokensOverride: { reasoning: 2 } } });
    linkRole(db, { key: 'claude:codeburn:coord-c', role: 'coordinator', host: 'host-a', run: 'run-1' });
    linkRole(db, { key: 'codex:codeburn:coord-x', role: 'coordinator', host: 'host-a', run: 'run-1' });
    linkRole(db, { key: 'claude:codeburn:w1', role: 'worker', host: 'host-a', run: 'run-1', dispatch: 'dispatch-1' });
    linkRole(db, { key: 'codex:codeburn:w2', role: 'worker', host: 'host-a', run: 'run-1', dispatch: 'dispatch-2' });
    freshAttempts(db, 'host-a', 'run-1');

    const report = buildOverheadReport(ctx(db), 'host-a', 'run-1', NOW);

    assert.equal(report.hostId, 'host-a');
    assert.equal(report.runId, 'run-1');
    assert.equal(report.coverage, 'unknown');
    assert.equal(report.classifiedSessionCount, 4);
    assert.equal(report.unclassifiedSessionCount, null);

    assert.equal(report.coordinator.sessionCount, 2);
    assert.equal(report.coordinator.dispatchCount, null);
    assert.equal(report.coordinator.knownCostUsd, 3.5);
    assert.equal(report.coordinator.costUsd, 3.5);
    assert.equal(report.coordinator.unknownCostSessionCount, 0);
    const coordClaude = report.coordinator.byProvider.find((p) => p.provider === 'claude');
    const coordCodex = report.coordinator.byProvider.find((p) => p.provider === 'codex');
    assert.deepEqual(coordClaude.tokens, { input: 8, output: 4, cacheRead: 2, cacheWrite: 1, reasoning: null });
    assert.deepEqual(coordCodex.tokens, { input: 10, output: 5, cacheRead: 1, cacheWrite: 0, reasoning: 3 });

    assert.equal(report.workers.sessionCount, 2);
    assert.equal(report.workers.dispatchCount, 2);
    assert.equal(report.workers.knownCostUsd, 1.5);
    assert.equal(report.workers.costUsd, 1.5);

    assert.equal(report.overheadShare.unknownReason, null);
    assert.ok(Math.abs(report.overheadShare.value - 0.7) < 1e-9);
    assert.equal(report.overheadPerWorkerCost.unknownReason, null);
    assert.ok(Math.abs(report.overheadPerWorkerCost.value - 3.5 / 1.5) < 1e-9);

    assert.equal(report.sourceStatus.orca.status, 'success');
    assert.ok(report.sourceStatus.orca.ageSeconds >= 3600 - 1 && report.sourceStatus.orca.ageSeconds <= 3600 + 1);

    const text = formatOverheadReportText(report);
    assert.match(text, /Overhead report — host host-a \/ run run-1/);
    assert.match(text, /overheadShare: 0\.7000/);
    assert.match(text, /dispatches=2/);
  } finally {
    fixture.close();
  }
});

test('V14-02: cross-host raw Dispatch ID collision stays scoped per host/run, not merged', () => {
  const fixture = setupOverheadDb();
  try {
    const { db } = fixture;
    insertRunGraph(db, 'host-a', 'run-1', ['dispatch-1']);
    insertRunGraph(db, 'host-b', 'run-1', ['dispatch-1']);
    insertSession(db, { key: 'claude:codeburn:wa', provider: 'claude', rawId: 'wa',
      snapshot: { observedAt: isoMinus(NOW, 100), cost: 1.0 } });
    insertSession(db, { key: 'claude:codeburn:wb', provider: 'claude', rawId: 'wb',
      snapshot: { observedAt: isoMinus(NOW, 100), cost: 9.0 } });
    linkRole(db, { key: 'claude:codeburn:wa', role: 'worker', host: 'host-a', run: 'run-1', dispatch: 'dispatch-1' });
    linkRole(db, { key: 'claude:codeburn:wb', role: 'worker', host: 'host-b', run: 'run-1', dispatch: 'dispatch-1' });
    freshAttempts(db, 'host-a', 'run-1');
    freshAttempts(db, 'host-b', 'run-1');

    const reportA = buildOverheadReport(ctx(db), 'host-a', 'run-1', NOW);
    const reportB = buildOverheadReport(ctx(db), 'host-b', 'run-1', NOW);

    assert.equal(reportA.workers.sessionCount, 1);
    assert.equal(reportA.workers.knownCostUsd, 1.0);
    assert.equal(reportB.workers.sessionCount, 1);
    assert.equal(reportB.workers.knownCostUsd, 9.0);
    assert.equal(reportA.classifiedSessionCount, 1);
    assert.equal(reportB.classifiedSessionCount, 1);
  } finally {
    fixture.close();
  }
});

test('Run selector is explicit: an unknown (host, run) is a safe setup error, never a default/zero-filled report', () => {
  const fixture = setupOverheadDb();
  try {
    assert.throws(
      () => buildOverheadReport(ctx(fixture.db), 'host-missing', 'run-missing', NOW),
      (err) => err.code === 'report_setup' && err.exitCode === 3,
    );
  } finally {
    fixture.close();
  }
});

test('V14-05: missing snapshot, unknown cost, and known-zero cost are three distinct states, with reason precedence', () => {
  const fixture = setupOverheadDb();
  try {
    const { db } = fixture;
    insertRunGraph(db, 'host-a', 'run-1', ['dispatch-1']);

    // Coordinator session has no snapshot row at all.
    insertSession(db, { key: 'claude:codeburn:coord-missing', provider: 'claude', rawId: 'coord-missing' });
    linkRole(db, { key: 'claude:codeburn:coord-missing', role: 'coordinator', host: 'host-a', run: 'run-1' });
    insertSession(db, { key: 'claude:codeburn:w1', provider: 'claude', rawId: 'w1',
      snapshot: { observedAt: isoMinus(NOW, 100), cost: 1.0 } });
    linkRole(db, { key: 'claude:codeburn:w1', role: 'worker', host: 'host-a', run: 'run-1', dispatch: 'dispatch-1' });
    freshAttempts(db, 'host-a', 'run-1');

    const missingReport = buildOverheadReport(ctx(db), 'host-a', 'run-1', NOW);
    assert.equal(missingReport.coordinator.missingSnapshotCount, 1);
    assert.equal(missingReport.coordinator.costUsd, null);
    assert.equal(missingReport.coordinator.unknownCostSessionCount, 1);
    assert.equal(missingReport.overheadShare.unknownReason, 'missing_snapshot');
  } finally {
    fixture.close();
  }
});

test('unknown cost without a missing snapshot is reported distinctly from a known $0.00 cost', () => {
  const fixture = setupOverheadDb();
  try {
    const { db } = fixture;
    insertRunGraph(db, 'host-a', 'run-1', ['dispatch-1']);
    insertSession(db, { key: 'claude:codeburn:coord-unknown', provider: 'claude', rawId: 'coord-unknown',
      snapshot: { observedAt: isoMinus(NOW, 100), cost: 'unknown' } });
    linkRole(db, { key: 'claude:codeburn:coord-unknown', role: 'coordinator', host: 'host-a', run: 'run-1' });
    insertSession(db, { key: 'claude:codeburn:w-zero', provider: 'claude', rawId: 'w-zero',
      snapshot: { observedAt: isoMinus(NOW, 100), cost: 0 } });
    linkRole(db, { key: 'claude:codeburn:w-zero', role: 'worker', host: 'host-a', run: 'run-1', dispatch: 'dispatch-1' });
    freshAttempts(db, 'host-a', 'run-1');

    const report = buildOverheadReport(ctx(db), 'host-a', 'run-1', NOW);
    assert.equal(report.coordinator.missingSnapshotCount, 0);
    assert.equal(report.coordinator.costUsd, null);
    assert.equal(report.coordinator.unknownCostSessionCount, 1);
    // Worker cost is known $0.00 — distinct from unknown.
    assert.equal(report.workers.costUsd, 0);
    assert.equal(report.workers.unknownCostSessionCount, 0);
    assert.equal(report.overheadShare.unknownReason, 'unknown_cost');
  } finally {
    fixture.close();
  }
});

test('both roles at known $0.00 cost trip zero_denominator, not unknown_cost', () => {
  const fixture = setupOverheadDb();
  try {
    const { db } = fixture;
    insertRunGraph(db, 'host-a', 'run-1', ['dispatch-1']);
    insertSession(db, { key: 'claude:codeburn:coord-zero', provider: 'claude', rawId: 'coord-zero',
      snapshot: { observedAt: isoMinus(NOW, 100), cost: 0 } });
    linkRole(db, { key: 'claude:codeburn:coord-zero', role: 'coordinator', host: 'host-a', run: 'run-1' });
    insertSession(db, { key: 'claude:codeburn:w-zero', provider: 'claude', rawId: 'w-zero',
      snapshot: { observedAt: isoMinus(NOW, 100), cost: 0 } });
    linkRole(db, { key: 'claude:codeburn:w-zero', role: 'worker', host: 'host-a', run: 'run-1', dispatch: 'dispatch-1' });
    freshAttempts(db, 'host-a', 'run-1');

    const report = buildOverheadReport(ctx(db), 'host-a', 'run-1', NOW);
    assert.equal(report.coordinator.costUsd, 0);
    assert.equal(report.workers.costUsd, 0);
    assert.equal(report.overheadShare.unknownReason, 'zero_denominator');
    assert.equal(report.overheadPerWorkerCost.unknownReason, 'zero_denominator');
  } finally {
    fixture.close();
  }
});

test('V14-05: attempt status/freshness precedence — partial_source before stale_source, exact 24h boundary included, future completedAt is stale', () => {
  const fixture = setupOverheadDb();
  try {
    const { db } = fixture;
    insertRunGraph(db, 'host-a', 'run-1', ['dispatch-1']);
    insertSession(db, { key: 'claude:codeburn:coord', provider: 'claude', rawId: 'coord',
      snapshot: { observedAt: isoMinus(NOW, 100), cost: 1.0 } });
    linkRole(db, { key: 'claude:codeburn:coord', role: 'coordinator', host: 'host-a', run: 'run-1' });
    insertSession(db, { key: 'claude:codeburn:w1', provider: 'claude', rawId: 'w1',
      snapshot: { observedAt: isoMinus(NOW, 100), cost: 1.0 } });
    linkRole(db, { key: 'claude:codeburn:w1', role: 'worker', host: 'host-a', run: 'run-1', dispatch: 'dispatch-1' });

    // No attempts recorded at all yet: orca/claude/codex all "missing".
    assert.equal(
      buildOverheadReport(ctx(db), 'host-a', 'run-1', NOW).overheadShare.unknownReason,
      'partial_source',
    );

    // codex still missing even once orca+claude succeed fresh.
    attempt(db, { source: 'orca', hostId: 'host-a', runId: 'run-1', startedAt: isoMinus(NOW, 200),
      completedAt: isoMinus(NOW, 100), status: 'success' });
    attempt(db, { source: 'codeburn', provider: 'claude', startedAt: isoMinus(NOW, 200),
      completedAt: isoMinus(NOW, 100), status: 'success' });
    assert.equal(
      buildOverheadReport(ctx(db), 'host-a', 'run-1', NOW).overheadShare.unknownReason,
      'partial_source',
    );

    // codex attempt exists but failed: still partial_source.
    attempt(db, { source: 'codeburn', provider: 'codex', startedAt: isoMinus(NOW, 200),
      completedAt: isoMinus(NOW, 100), status: 'failed', errorCode: 'source_unavailable' });
    const failedReport = buildOverheadReport(ctx(db), 'host-a', 'run-1', NOW);
    assert.equal(failedReport.overheadShare.unknownReason, 'partial_source');
    assert.equal(failedReport.sourceStatus.codex.status, 'failed');
    assert.equal(failedReport.sourceStatus.codex.errorCode, 'source_unavailable');

    // codex running (crash left it running): still partial_source, not success.
    attempt(db, { source: 'codeburn', provider: 'codex', startedAt: isoMinus(NOW, 50), status: 'running' });
    assert.equal(
      buildOverheadReport(ctx(db), 'host-a', 'run-1', NOW).overheadShare.unknownReason,
      'partial_source',
    );

    // codex succeeds exactly at the 24h boundary (inclusive) -> all fresh, ratio computed.
    attempt(db, { source: 'codeburn', provider: 'codex', startedAt: isoMinus(NOW, 24 * 3600 + 100),
      completedAt: isoMinus(NOW, 24 * 3600), status: 'success' });
    const boundaryReport = buildOverheadReport(ctx(db), 'host-a', 'run-1', NOW);
    assert.equal(boundaryReport.overheadShare.unknownReason, null);
    assert.equal(boundaryReport.overheadShare.value, 0.5);

    // One second past the boundary -> stale_source.
    attempt(db, { source: 'codeburn', provider: 'codex', startedAt: isoMinus(NOW, 24 * 3600 + 101),
      completedAt: isoMinus(NOW, 24 * 3600 + 1), status: 'success' });
    assert.equal(
      buildOverheadReport(ctx(db), 'host-a', 'run-1', NOW).overheadShare.unknownReason,
      'stale_source',
    );

    // Future completedAt (clock skew) -> stale_source, not success-fresh.
    attempt(db, { source: 'codeburn', provider: 'codex', startedAt: isoMinus(NOW, -500),
      completedAt: isoMinus(NOW, -500), status: 'success' });
    const futureReport = buildOverheadReport(ctx(db), 'host-a', 'run-1', NOW);
    assert.equal(futureReport.overheadShare.unknownReason, 'stale_source');
    assert.ok(futureReport.sourceStatus.codex.ageSeconds < 0);
  } finally {
    fixture.close();
  }
});

test('V14-06: 1000 sessions across 101 Dispatches keep report SQL bounded and Run/host scopes separate', () => {
  const fixture = setupOverheadDb();
  try {
    const { db } = fixture;
    const dispatchIds = Array.from({ length: 101 }, (_, i) => `dispatch-${i}`);
    insertRunGraph(db, 'host-a', 'run-1', dispatchIds);
    insertRunGraph(db, 'host-a', 'run-2', ['dispatch-0']);
    insertRunGraph(db, 'host-b', 'run-1', ['dispatch-0']);
    insertSession(db, { key: 'claude:codeburn:coord', provider: 'claude', rawId: 'coord',
      snapshot: { observedAt: isoMinus(NOW, 100), cost: 1.0 } });
    linkRole(db, { key: 'claude:codeburn:coord', role: 'coordinator', host: 'host-a', run: 'run-1' });
    for (let i = 0; i < 999; i += 1) {
      const key = `claude:codeburn:w${i}`;
      insertSession(db, { key, provider: 'claude', rawId: `w${i}`,
        snapshot: { observedAt: isoMinus(NOW, 100), cost: 0.01 } });
      linkRole(db, { key, role: 'worker', host: 'host-a', run: 'run-1', dispatch: dispatchIds[i % 101] });
    }
    for (const [host, run, key] of [
      ['host-a', 'run-2', 'claude:codeburn:other-run'],
      ['host-b', 'run-1', 'claude:codeburn:other-host'],
    ]) {
      insertSession(db, { key, provider: 'claude', rawId: key,
        snapshot: { observedAt: isoMinus(NOW, 100), cost: 0.25 } });
      linkRole(db, { key, role: 'worker', host, run, dispatch: 'dispatch-0' });
      freshAttempts(db, host, run);
    }
    freshAttempts(db, 'host-a', 'run-1');

    const originalPrepare = db.prepare.bind(db);
    function countedReport(host, run) {
      let calls = 0;
      db.prepare = (sql) => { calls += 1; return originalPrepare(sql); };
      try {
        return { report: buildOverheadReport(ctx(db), host, run, NOW), calls };
      } finally {
        db.prepare = originalPrepare;
      }
    }
    const large = countedReport('host-a', 'run-1');
    const sameHost = countedReport('host-a', 'run-2');
    const otherHost = countedReport('host-b', 'run-1');

    assert.equal(large.report.classifiedSessionCount, 1000);
    assert.equal(large.report.workers.sessionCount, 999);
    assert.equal(large.report.workers.dispatchCount, 101);
    assert.equal(large.report.workers.byProvider[0].tokens.input, 999 * 8);
    assert.ok(Math.abs(large.report.workers.knownCostUsd - 9.99) < 1e-9);
    assert.equal(sameHost.report.classifiedSessionCount, 1);
    assert.equal(otherHost.report.classifiedSessionCount, 1);
    assert.equal(sameHost.report.workers.dispatchCount, 1);
    assert.equal(otherHost.report.workers.dispatchCount, 1);
    assert.equal(sameHost.report.workers.knownCostUsd, 0.25);
    assert.equal(otherHost.report.workers.knownCostUsd, 0.25);
    assert.equal(large.calls, sameHost.calls, 'report statements must not grow with row count');
    assert.equal(large.calls, otherHost.calls, 'report statements must not grow across host scope');
    assert.ok(large.calls <= 50, `expected <=50 report statements, got ${large.calls}`);
  } finally {
    fixture.close();
  }
});

function runCli(appHome, ...args) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ORCA_TELEMETRY_HOME: appHome },
  });
}

test('V14-07: Run roles never assign an Issue or change task/project totals; all reports leave the DB untouched', () => {
  // Synthetic Issue and CodeBurn sessions. The Run/Dispatch are scoped fixture rows,
  // not evidence that a live Orca session was matched to CodeBurn.
  const repo = initBareRepo();
  const appHome = mkdtempSync(join(tmpdir(), 'orca-issue-role-home-'));
  const dbPath = join(appHome, 'telemetry.sqlite');
  const ghStub = resolve(testDir, 'helpers/gh-repo-stub.mjs');
  const env = {
    ORCA_TELEMETRY_HOME: appHome,
    ORCA_TELEMETRY_GH: ghStub,
    GH_STUB_REPO_VIEW_JSON: JSON.stringify({
      id: 'R_reports', nameWithOwner: 'org-a/repo', url: 'https://github.com/org-a/repo',
    }),
  };
  const cliJson = (...args) => {
    const result = runCliReport(args, { cwd: repo, env });
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr || result.stdout}`);
    const body = JSON.parse(result.stdout.trim());
    assert.equal(body.ok, true);
    return body.data;
  };
  const dbState = () => {
    const handle = openTelemetryDatabase({ dbPath, gitRoot: repo });
    try {
      const db = handle.db;
      const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'
        AND name NOT LIKE 'sqlite_%' ORDER BY name`).all().map((row) => row.name);
      return {
        counts: Object.fromEntries(tables.map((table) => [table,
          db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n])),
        issueLinks: db.prepare(`SELECT session_key, issue_node_id FROM session_links
          ORDER BY session_key`).all(),
      };
    } finally {
      handle.close();
    }
  };
  const reports = () => {
    const beforeDb = dbState();
    const beforeFiles = appHomeInventory(appHome);
    const beforeRepo = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' });
    const task = cliJson('report', 'task', '1', '--json');
    const project = cliJson('report', 'project', '--json');
    const overhead = cliJson('report', 'overhead', '--host', 'host-fixture', '--run', 'run-fixture', '--format', 'json');
    assert.deepEqual(dbState(), beforeDb, 'report commands must not change any table row count or Issue link');
    assert.deepEqual(appHomeInventory(appHome), beforeFiles, 'report commands must not change app home files');
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }), beforeRepo,
      'report commands must not edit the target repository');
    return { task, project, overhead, issueLinks: beforeDb.issueLinks };
  };
  const roleArgs = (role, provider, session, dispatch) => [
    '--host', 'host-fixture', '--run', 'run-fixture', '--role', role,
    ...(dispatch ? ['--dispatch', dispatch] : []),
    '--provider', provider, '--session', session, '--verifier', 'fixture_operator',
  ];

  try {
    writeReportsProfile(appHome);
    installDatasetInHome(appHome, linkAlphaSessions);
    const handle = openTelemetryDatabase({ dbPath, gitRoot: repo });
    insertRunGraph(handle.db, 'host-fixture', 'run-fixture', ['dispatch-fixture']);
    handle.close();

    const baseline = reports();
    assert.equal(baseline.task.issue.sessionCount, 3);
    assert.equal(baseline.task.issue.cost.knownAmountUsd, 1.75);
    assert.equal(baseline.project.linkedSessionCount, 3);
    assert.equal(baseline.project.cost.knownAmountUsd, 1.75);
    assert.equal(baseline.project.unmappedNotInProjectTotals.sessionCount, 1);
    assert.equal(baseline.overhead.classifiedSessionCount, 0);
    assert.equal(baseline.issueLinks.length, 3);

    // This Claude session has no Issue link. Its Run role must not infer one.
    const unlinkedClaude = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    assert.equal(cliJson('link-role', ...roleArgs('coordinator', 'claude', unlinkedClaude),
      '--confirm-same-session', '--json').outcome, 'created');
    const coordinatorOnly = reports();
    assert.deepEqual(coordinatorOnly.issueLinks, baseline.issueLinks);
    assert.deepEqual(coordinatorOnly.task, baseline.task);
    assert.deepEqual(coordinatorOnly.project, baseline.project);
    assert.equal(coordinatorOnly.overhead.coordinator.sessionCount, 1);
    assert.equal(coordinatorOnly.overhead.workers.sessionCount, 0);

    // This Codex session already belongs to the Issue. A worker role must not
    // add a second Issue/Project contribution for the same sessionKey.
    assert.equal(cliJson('link-role', ...roleArgs('worker', 'codex', unlinkedClaude, 'dispatch-fixture'),
      '--confirm-same-session', '--json').outcome, 'created');
    const bothRoles = reports();
    assert.deepEqual(bothRoles.issueLinks, baseline.issueLinks);
    assert.deepEqual(bothRoles.task, baseline.task);
    assert.deepEqual(bothRoles.project, baseline.project);
    assert.equal(bothRoles.overhead.classifiedSessionCount, 2);
    assert.equal(bothRoles.overhead.workers.sessionCount, 1);
    assert.equal(bothRoles.overhead.workers.dispatchCount, 1);

    assert.equal(cliJson('unlink-role', ...roleArgs('coordinator', 'claude', unlinkedClaude),
      '--json').outcome, 'deleted');
    assert.equal(cliJson('unlink-role', ...roleArgs('worker', 'codex', unlinkedClaude, 'dispatch-fixture'),
      '--json').outcome, 'deleted');
    const afterUnlink = reports();
    assert.deepEqual(afterUnlink.issueLinks, baseline.issueLinks);
    assert.deepEqual(afterUnlink.task, baseline.task);
    assert.deepEqual(afterUnlink.project, baseline.project);
    assert.equal(afterUnlink.overhead.classifiedSessionCount, 0);
  } finally {
    rmSync(appHome, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
}, 60_000);

test('CLI: report overhead requires --run, resolves a unique host, rejects an unknown explicit tuple, and renders JSON/text', () => {
  const appHome = mkdtempSync(join(tmpdir(), 'orca-overhead-cli-'));
  try {
    const dbPath = join(appHome, 'telemetry.sqlite');
    const handle = openTelemetryDatabase({ dbPath });
    insertRunGraph(handle.db, 'host-a', 'run-1', ['dispatch-1']);
    insertSession(handle.db, { key: 'claude:codeburn:coord', provider: 'claude', rawId: 'coord',
      snapshot: { observedAt: new Date().toISOString(), cost: 1.0 } });
    linkRole(handle.db, { key: 'claude:codeburn:coord', role: 'coordinator', host: 'host-a', run: 'run-1' });
    handle.close();

    const missingRun = runCli(appHome, 'report', 'overhead', '--host', 'host-a', '--format', 'json');
    assert.equal(missingRun.status, 2);
    assert.equal(JSON.parse(missingRun.stdout).error.code, 'usage_error');
    assert.match(JSON.parse(missingRun.stdout).error.message, /Missing --run/);

    const uniqueHost = runCli(appHome, 'report', 'overhead', '--run', 'run-1', '--format', 'json');
    assert.equal(uniqueHost.status, 0, uniqueHost.stderr);
    assert.equal(JSON.parse(uniqueHost.stdout).data.hostId, 'host-a');

    const notFound = runCli(appHome, 'report', 'overhead', '--host', 'host-x', '--run', 'run-x', '--json');
    assert.equal(notFound.status, 3);
    const notFoundBody = JSON.parse(notFound.stdout.trim());
    assert.equal(notFoundBody.ok, false);
    assert.equal(notFoundBody.error.code, 'report_setup');
    assert.match(notFoundBody.error.message, /host-x/);

    const jsonResult = runCli(appHome, 'report', 'overhead', '--host', 'host-a', '--run', 'run-1', '--format', 'json');
    assert.equal(jsonResult.status, 0);
    const body = JSON.parse(jsonResult.stdout.trim());
    assert.equal(body.ok, true);
    assert.equal(body.data.hostId, 'host-a');
    assert.equal(body.data.runId, 'run-1');
    assert.equal(body.data.coverage, 'unknown');
    assert.equal(body.data.unclassifiedSessionCount, null);

    const textResult = runCli(appHome, 'report', 'overhead', '--host', 'host-a', '--run', 'run-1');
    assert.equal(textResult.status, 0);
    assert.match(textResult.stdout, /Overhead report — host host-a \/ run run-1/);
    assert.match(textResult.stdout, /overheadShare:/);
    assert.match(textResult.stdout, /Warnings:/);
  } finally {
    rmSync(appHome, { recursive: true, force: true });
  }
});

test('CLI: omitted host resolves only one exact Run; zero/two hosts list safe candidates and never mutate the DB', () => {
  const fixture = setupOverheadDb();
  try {
    const { db, dbPath } = fixture;
    const appHome = dirname(dbPath);
    const runId = 'run-selector';
    const hostileHost = 'host-b\u001b[31m\nnext\u0085';
    const safeHost = JSON.stringify(hostileHost).replace('\u0085', '\\u0085');
    insertRunGraph(db, 'host-a', runId, []);
    insertRunGraph(db, 'host-c', 'other-run', []);
    const before = readFileSync(dbPath);

    const zero = runCli(appHome, 'report', 'overhead', '--run', 'missing-run', '--format=json');
    assert.equal(zero.status, 3);
    assert.deepEqual(JSON.parse(zero.stdout).error, {
      code: 'report_run_not_found',
      message: 'Run "missing-run" is not in the local database; candidate host IDs: [].',
      hint: 'Collect this Orca Run before reporting overhead, or pass the exact --host/--run.',
    });
    assert.deepEqual(readFileSync(dbPath), before);

    const one = runCli(appHome, 'report', 'overhead', '--run', runId, '--json');
    assert.equal(one.status, 0, one.stderr);
    assert.deepEqual([JSON.parse(one.stdout).data.hostId, JSON.parse(one.stdout).data.runId], ['host-a', runId]);
    assert.deepEqual(readFileSync(dbPath), before);

    insertRunGraph(db, hostileHost, runId, []);
    const twoBefore = readFileSync(dbPath);
    const two = runCli(appHome, 'report', 'overhead', '--run', runId, '--format', 'json');
    assert.equal(two.status, 3);
    const twoError = JSON.parse(two.stdout).error;
    assert.equal(twoError.code, 'report_run_ambiguous');
    assert.match(twoError.message, /candidate host IDs/);
    assert.ok(twoError.message.includes(`["host-a",${safeHost}]`));
    assert.deepEqual(readFileSync(dbPath), twoBefore);

    const text = runCli(appHome, 'report', 'overhead', '--run', runId);
    assert.equal(text.status, 3);
    assert.ok(text.stderr.includes(safeHost));
    assert.doesNotMatch(text.stderr, /[\u001b\u0085]|\nnext/);
    assert.deepEqual(readFileSync(dbPath), twoBefore);

    const explicitWrong = runCli(appHome, 'report', 'overhead', '--host', 'host-x', '--run', runId, '--json');
    assert.equal(explicitWrong.status, 3);
    assert.equal(JSON.parse(explicitWrong.stdout).error.code, 'report_setup');
    assert.deepEqual(readFileSync(dbPath), twoBefore);

    const unsafeWrong = runCli(appHome, 'report', 'overhead', '--host', 'host-x\u001b\u0085', '--run', runId);
    assert.equal(unsafeWrong.status, 3);
    assert.doesNotMatch(unsafeWrong.stderr, /[\u001b\u0085]/);
    assert.ok(unsafeWrong.stderr.includes('host-x\\u001b\\u0085'));

    const explicitA = runCli(appHome, 'report', 'overhead', '--host', 'host-a', '--run', runId, '--json');
    assert.equal(explicitA.status, 0, explicitA.stderr);
    assert.equal(JSON.parse(explicitA.stdout).data.hostId, 'host-a');
    assert.deepEqual(readFileSync(dbPath), twoBefore);

    const malformed = runCli(appHome, 'report', 'overhead', '--run', runId,
      '--format', 'json', '--unknown-option');
    assert.equal(malformed.status, 2);
    assert.equal(JSON.parse(malformed.stdout).error.code, 'usage_error');
    assert.deepEqual(readFileSync(dbPath), twoBefore);
  } finally {
    fixture.close();
  }
});

test('V14-01 golden: CLI JSON and text for one coordinator and two workers across two Dispatches', () => {
  const fixture = setupOverheadDb();
  try {
    const { db, dbPath } = fixture;
    const appHome = dirname(dbPath);
    const collectedAt = new Date();
    const observedAt = collectedAt.toISOString();
    insertRunGraph(db, 'host-a', 'run-1', ['dispatch-1', 'dispatch-2']);
    insertSession(db, { key: 'claude:codeburn:coord', provider: 'claude', rawId: 'coord',
      snapshot: { observedAt, cost: 2.0 } });
    linkRole(db, { key: 'claude:codeburn:coord', role: 'coordinator', host: 'host-a', run: 'run-1' });
    insertSession(db, { key: 'claude:codeburn:w1', provider: 'claude', rawId: 'w1',
      snapshot: { observedAt, cost: 1.0 } });
    linkRole(db, { key: 'claude:codeburn:w1', role: 'worker', host: 'host-a', run: 'run-1', dispatch: 'dispatch-1' });
    insertSession(db, { key: 'codex:codeburn:w2', provider: 'codex', rawId: 'w2',
      snapshot: { observedAt, cost: 0.5, tokensOverride: { reasoning: 7 } } });
    linkRole(db, { key: 'codex:codeburn:w2', role: 'worker', host: 'host-a', run: 'run-1', dispatch: 'dispatch-2' });
    for (const source of ['orca', 'claude', 'codex']) {
      attempt(db, { source: source === 'orca' ? 'orca' : 'codeburn',
        ...(source === 'orca' ? { hostId: 'host-a', runId: 'run-1' } : { provider: source }),
        startedAt: isoMinus(collectedAt, 60), completedAt: observedAt, status: 'success' });
    }

    const jsonResult = runCli(appHome, 'report', 'overhead', '--host', 'host-a', '--run', 'run-1', '--format', 'json');
    assert.equal(jsonResult.status, 0, jsonResult.stderr);
    assert.equal(jsonResult.stderr, '');
    const { ok, data } = JSON.parse(jsonResult.stdout);
    assert.equal(ok, true);
    assert.equal(data.hostId, 'host-a');
    assert.equal(data.runId, 'run-1');
    assert.equal(data.coverage, 'unknown');
    assert.equal(data.classifiedSessionCount, 3);
    assert.equal(data.unclassifiedSessionCount, null);
    for (const source of ['orca', 'claude', 'codex']) {
      assert.equal(data.sourceStatus[source].status, 'success');
      assert.equal(data.sourceStatus[source].completedAt, observedAt);
      assert.equal(data.sourceStatus[source].errorCode, null);
    }
    assert.deepEqual(data.coordinator, {
      sessionCount: 1, dispatchCount: null,
      byProvider: [{ provider: 'claude', sessionCount: 1, missingSnapshotCount: 0,
        tokens: { input: 8, output: 4, cacheRead: 2, cacheWrite: 1, reasoning: null } }],
      missingSnapshotCount: 0, knownCostUsd: 2, unknownCostSessionCount: 0, costUsd: 2,
    });
    assert.deepEqual(data.workers, {
      sessionCount: 2, dispatchCount: 2,
      byProvider: [
        { provider: 'claude', sessionCount: 1, missingSnapshotCount: 0,
          tokens: { input: 8, output: 4, cacheRead: 2, cacheWrite: 1, reasoning: null } },
        { provider: 'codex', sessionCount: 1, missingSnapshotCount: 0,
          tokens: { input: 10, output: 5, cacheRead: 1, cacheWrite: 0, reasoning: 7 } },
      ],
      missingSnapshotCount: 0, knownCostUsd: 1.5, unknownCostSessionCount: 0, costUsd: 1.5,
    });
    assert.deepEqual(data.overheadShare, { value: 4 / 7, unknownReason: null }); // 2 / (2 + 1 + 0.5)
    assert.deepEqual(data.overheadPerWorkerCost, { value: 4 / 3, unknownReason: null }); // 2 / (1 + 0.5)
    assert.ok(data.warnings.some((warning) => warning.includes('coverage is unknown')));

    const textResult = runCli(appHome, 'report', 'overhead', '--host', 'host-a', '--run', 'run-1');
    assert.equal(textResult.status, 0, textResult.stderr);
    assert.equal(textResult.stderr, '');
    const normalizedText = textResult.stdout.replace(/age=\d+s/g, 'age=<recent>');
    assert.equal(normalizedText, [
      'Overhead report — host host-a / run run-1',
      `Source status: orca=success (completedAt=${observedAt}, age=<recent>, error=none)`,
      `               claude=success (completedAt=${observedAt}, age=<recent>, error=none)`,
      `               codex=success (completedAt=${observedAt}, age=<recent>, error=none)`,
      'Coverage: unknown; classifiedSessionCount=3; unclassifiedSessionCount=null',
      '',
      '  Coordinator: sessions=1 cost=$2.00 (known=$2.00, unknownCostSessions=0)',
      '    claude: sessions=1 missingSnapshots=0 in=8 out=4 cacheR=2 cacheW=1 reasoning=unknown',
      '  Workers: sessions=2 dispatches=2 cost=$1.50 (known=$1.50, unknownCostSessions=0)',
      '    claude: sessions=1 missingSnapshots=0 in=8 out=4 cacheR=2 cacheW=1 reasoning=unknown',
      '    codex: sessions=1 missingSnapshots=0 in=10 out=5 cacheR=1 cacheW=0 reasoning=7',
      '',
      'overheadShare: 0.5714',
      'overheadPerWorkerCost: 1.3333',
      'Warnings:',
      '  coverage is unknown: Orca/CodeBurn collection success does not prove every session of this Run was found.',
      '  Cost is estimated API equivalent, never actual billing or Orca runtime cost.',
      '  overheadShare only describes the linked/classified session set, not full Run usage.',
      '',
    ].join('\n'));
  } finally {
    fixture.close();
  }
});

test('V14-04: retry chain and overlapping CodeBurn sessions count only distinct explicit role links', () => {
  const fixture = setupOverheadDb();
  try {
    const { db, dbPath } = fixture;
    const appHome = dirname(dbPath);
    const observedAt = new Date().toISOString();
    insertRunGraph(db, 'host-a', 'run-retry', ['dispatch-1', 'dispatch-2', 'dispatch-3']);
    // The same raw Run ID on another host makes --run alone ambiguous.
    insertRunGraph(db, 'host-b', 'run-retry', ['dispatch-1']);
    db.prepare(`UPDATE orca_dispatches SET retry_of_dispatch_id = ?
      WHERE host_id = ? AND run_id = ? AND dispatch_id = ?`)
      .run('dispatch-1', 'host-a', 'run-retry', 'dispatch-2');
    db.prepare(`UPDATE orca_dispatches SET retry_of_dispatch_id = ?
      WHERE host_id = ? AND run_id = ? AND dispatch_id = ?`)
      .run('dispatch-2', 'host-a', 'run-retry', 'dispatch-3');
    assert.deepEqual(db.prepare(`SELECT dispatch_id, retry_of_dispatch_id FROM orca_dispatches
      WHERE host_id = ? AND run_id = ? ORDER BY dispatch_id`).all('host-a', 'run-retry').map((row) => ({ ...row })), [
      { dispatch_id: 'dispatch-1', retry_of_dispatch_id: null },
      { dispatch_id: 'dispatch-2', retry_of_dispatch_id: 'dispatch-1' },
      { dispatch_id: 'dispatch-3', retry_of_dispatch_id: 'dispatch-2' },
    ]);

    // CodeBurn's verified aggregated JSON exposes startedAt/endedAt. These
    // synthetic windows all overlap at 10:30, but session time is not a role link.
    const sessions = [
      { key: 'claude:codeburn:coord', provider: 'claude', rawId: 'coord', cost: 2,
        role: 'coordinator', startedAt: '2026-10-24T10:00:00Z', endedAt: '2026-10-24T10:45:00Z' },
      { key: 'claude:codeburn:worker-1', provider: 'claude', rawId: 'worker-1', cost: 1,
        role: 'worker', dispatch: 'dispatch-1', startedAt: '2026-10-24T10:05:00Z', endedAt: '2026-10-24T10:50:00Z' },
      { key: 'codex:codeburn:worker-2a', provider: 'codex', rawId: 'worker-2a', cost: 0.5,
        role: 'worker', dispatch: 'dispatch-2', startedAt: '2026-10-24T10:10:00Z', endedAt: '2026-10-24T10:55:00Z' },
      { key: 'claude:codeburn:worker-2b', provider: 'claude', rawId: 'worker-2b', cost: 0.5,
        role: 'worker', dispatch: 'dispatch-2', startedAt: '2026-10-24T10:15:00Z', endedAt: '2026-10-24T11:00:00Z' },
      { key: 'codex:codeburn:worker-3', provider: 'codex', rawId: 'worker-3', cost: 1,
        role: 'worker', dispatch: 'dispatch-3', startedAt: '2026-10-24T10:20:00Z', endedAt: '2026-10-24T11:05:00Z' },
      { key: 'codex:codeburn:unlinked', provider: 'codex', rawId: 'unlinked', cost: 50,
        startedAt: '2026-10-24T10:25:00Z', endedAt: '2026-10-24T11:10:00Z' },
    ];
    const overlapAt = Date.parse('2026-10-24T10:30:00Z');
    for (const session of sessions) {
      assert.ok(Date.parse(session.startedAt) <= overlapAt && overlapAt < Date.parse(session.endedAt));
      insertSession(db, { key: session.key, provider: session.provider, rawId: session.rawId,
        snapshot: { observedAt, cost: session.cost } });
      if (session.role) {
        linkRole(db, { key: session.key, role: session.role, host: 'host-a', run: 'run-retry',
          dispatch: session.dispatch });
      }
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM session_role_links').get().count, 5);
    for (const source of ['orca', 'claude', 'codex']) {
      attempt(db, { source: source === 'orca' ? 'orca' : 'codeburn',
        ...(source === 'orca' ? { hostId: 'host-a', runId: 'run-retry' } : { provider: source }),
        startedAt: isoMinus(new Date(observedAt), 60), completedAt: observedAt, status: 'success' });
    }

    const missingHost = runCli(appHome, 'report', 'overhead', '--run', 'run-retry', '--format', 'json');
    assert.equal(missingHost.status, 3);
    assert.equal(JSON.parse(missingHost.stdout).error.code, 'report_run_ambiguous');
    assert.match(JSON.parse(missingHost.stdout).error.message, /\["host-a","host-b"\]/);

    const jsonResult = runCli(appHome, 'report', 'overhead', '--host', 'host-a', '--run', 'run-retry', '--format', 'json');
    assert.equal(jsonResult.status, 0, jsonResult.stderr);
    const { ok, data } = JSON.parse(jsonResult.stdout);
    assert.equal(ok, true);
    assert.equal(data.classifiedSessionCount, 5);
    assert.equal(data.coverage, 'unknown');
    assert.equal(data.unclassifiedSessionCount, null);
    assert.deepEqual(data.coordinator, {
      sessionCount: 1, dispatchCount: null,
      byProvider: [{ provider: 'claude', sessionCount: 1, missingSnapshotCount: 0,
        tokens: { input: 8, output: 4, cacheRead: 2, cacheWrite: 1, reasoning: null } }],
      missingSnapshotCount: 0, knownCostUsd: 2, unknownCostSessionCount: 0, costUsd: 2,
    });
    assert.deepEqual(data.workers, {
      sessionCount: 4, dispatchCount: 3,
      byProvider: [
        { provider: 'claude', sessionCount: 2, missingSnapshotCount: 0,
          tokens: { input: 16, output: 8, cacheRead: 4, cacheWrite: 2, reasoning: null } },
        { provider: 'codex', sessionCount: 2, missingSnapshotCount: 0,
          tokens: { input: 20, output: 10, cacheRead: 2, cacheWrite: 0, reasoning: null } },
      ],
      missingSnapshotCount: 0, knownCostUsd: 3, unknownCostSessionCount: 0, costUsd: 3,
    });
    assert.deepEqual(data.overheadShare, { value: 0.4, unknownReason: null }); // 2 / (2 + 3)
    assert.deepEqual(data.overheadPerWorkerCost, { value: 2 / 3, unknownReason: null });
    assert.equal(Object.keys(data).some((key) => /waste|retry.*cost/i.test(key)), false);

    const textResult = runCli(appHome, 'report', 'overhead', '--host', 'host-a', '--run', 'run-retry');
    assert.equal(textResult.status, 0, textResult.stderr);
    assert.match(textResult.stdout, /Coverage: unknown; classifiedSessionCount=5; unclassifiedSessionCount=null/);
    assert.match(textResult.stdout, /Coordinator: sessions=1 cost=\$2\.00 \(known=\$2\.00, unknownCostSessions=0\)/);
    assert.match(textResult.stdout, /Workers: sessions=4 dispatches=3 cost=\$3\.00 \(known=\$3\.00, unknownCostSessions=0\)/);
    assert.match(textResult.stdout, /claude: sessions=2 missingSnapshots=0 in=16 out=8 cacheR=4 cacheW=2 reasoning=unknown/);
    assert.match(textResult.stdout, /codex: sessions=2 missingSnapshots=0 in=20 out=10 cacheR=2 cacheW=0 reasoning=unknown/);
    assert.match(textResult.stdout, /overheadShare: 0\.4000/);
    assert.match(textResult.stdout, /overheadPerWorkerCost: 0\.6667/);
    assert.doesNotMatch(textResult.stdout, /waste/i);
  } finally {
    fixture.close();
  }
});

test('RPT-F01: a codex provider/role reasoning total stays null when any session in that group has no snapshot, never a partial sum', () => {
  const fixture = setupOverheadDb();
  try {
    const { db } = fixture;
    insertRunGraph(db, 'host-a', 'run-1', ['dispatch-1']);
    insertSession(db, { key: 'codex:codeburn:coord-with-snapshot', provider: 'codex', rawId: 'coord-with-snapshot',
      snapshot: { observedAt: isoMinus(NOW, 100), cost: 1.0, tokensOverride: { reasoning: 3 } } });
    linkRole(db, { key: 'codex:codeburn:coord-with-snapshot', role: 'coordinator', host: 'host-a', run: 'run-1' });
    // Second coordinator Codex session has no snapshot at all.
    insertSession(db, { key: 'codex:codeburn:coord-missing', provider: 'codex', rawId: 'coord-missing' });
    linkRole(db, { key: 'codex:codeburn:coord-missing', role: 'coordinator', host: 'host-a', run: 'run-1' });
    insertSession(db, { key: 'claude:codeburn:w1', provider: 'claude', rawId: 'w1',
      snapshot: { observedAt: isoMinus(NOW, 100), cost: 1.0 } });
    linkRole(db, { key: 'claude:codeburn:w1', role: 'worker', host: 'host-a', run: 'run-1', dispatch: 'dispatch-1' });
    freshAttempts(db, 'host-a', 'run-1');

    const report = buildOverheadReport(ctx(db), 'host-a', 'run-1', NOW);
    const coordCodex = report.coordinator.byProvider.find((p) => p.provider === 'codex');
    assert.equal(coordCodex.sessionCount, 2);
    assert.equal(coordCodex.missingSnapshotCount, 1);
    assert.equal(coordCodex.tokens.reasoning, null, 'must not report the one known reasoning value as a partial total');
  } finally {
    fixture.close();
  }
});

test('RPT-F02: malformed tokens_json numeric bucket is a structured DB schema error, never a string-concatenated total', () => {
  const fixture = setupOverheadDb();
  try {
    const { db } = fixture;
    insertRunGraph(db, 'host-a', 'run-1', ['dispatch-1']);
    insertSession(db, { key: 'claude:codeburn:coord', provider: 'claude', rawId: 'coord',
      snapshot: { observedAt: isoMinus(NOW, 100), cost: 1.0, tokensOverride: { input: 'oops' } } });
    linkRole(db, { key: 'claude:codeburn:coord', role: 'coordinator', host: 'host-a', run: 'run-1' });
    freshAttempts(db, 'host-a', 'run-1');

    assert.throws(
      () => buildOverheadReport(ctx(db), 'host-a', 'run-1', NOW),
      (err) => err.code === 'db_schema_drift',
    );
  } finally {
    fixture.close();
  }
});

test('RPT-F02: an Infinity cost_amount_usd is a structured DB schema error, never a silent JSON null', () => {
  const fixture = setupOverheadDb();
  try {
    const { db } = fixture;
    insertRunGraph(db, 'host-a', 'run-1', ['dispatch-1']);
    insertSession(db, { key: 'claude:codeburn:coord', provider: 'claude', rawId: 'coord',
      snapshot: { observedAt: isoMinus(NOW, 100), cost: Infinity } });
    linkRole(db, { key: 'claude:codeburn:coord', role: 'coordinator', host: 'host-a', run: 'run-1' });
    freshAttempts(db, 'host-a', 'run-1');

    assert.throws(
      () => buildOverheadReport(ctx(db), 'host-a', 'run-1', NOW),
      (err) => err.code === 'db_schema_drift',
    );
  } finally {
    fixture.close();
  }
});

test('RPT-F02: two individually finite cost rows that overflow the role cost aggregate are a structured DB schema error', () => {
  const fixture = setupOverheadDb();
  try {
    const { db } = fixture;
    insertRunGraph(db, 'host-a', 'run-1', ['dispatch-1']);
    insertSession(db, { key: 'claude:codeburn:coord1', provider: 'claude', rawId: 'coord1',
      snapshot: { observedAt: isoMinus(NOW, 100), cost: 1e308 } });
    insertSession(db, { key: 'claude:codeburn:coord2', provider: 'claude', rawId: 'coord2',
      snapshot: { observedAt: isoMinus(NOW, 100), cost: 1e308 } });
    linkRole(db, { key: 'claude:codeburn:coord1', role: 'coordinator', host: 'host-a', run: 'run-1' });
    linkRole(db, { key: 'claude:codeburn:coord2', role: 'coordinator', host: 'host-a', run: 'run-1' });
    freshAttempts(db, 'host-a', 'run-1');

    assert.throws(
      () => buildOverheadReport(ctx(db), 'host-a', 'run-1', NOW),
      (err) => err.code === 'db_schema_drift',
    );
  } finally {
    fixture.close();
  }
});

test.each([1.5, Number.MAX_SAFE_INTEGER + 1])(
  'RPT-F02: token bucket %s outside the safe nonnegative integer range is a structured DB schema error',
  (input) => {
    const fixture = setupOverheadDb();
    try {
      const { db } = fixture;
      insertRunGraph(db, 'host-a', 'run-1', ['dispatch-1']);
      insertSession(db, { key: 'claude:codeburn:coord', provider: 'claude', rawId: 'coord',
        snapshot: { observedAt: isoMinus(NOW, 100), cost: 1.0, tokensOverride: { input } } });
      linkRole(db, { key: 'claude:codeburn:coord', role: 'coordinator', host: 'host-a', run: 'run-1' });
      freshAttempts(db, 'host-a', 'run-1');

      assert.throws(
        () => buildOverheadReport(ctx(db), 'host-a', 'run-1', NOW),
        (err) => err.code === 'db_schema_drift',
      );
    } finally {
      fixture.close();
    }
  },
);

test('RPT-F02: unknown cost with a persisted numeric amount fails closed', () => {
  const fixture = setupOverheadDb();
  try {
    const { db } = fixture;
    insertRunGraph(db, 'host-a', 'run-1', ['dispatch-1']);
    insertSession(db, { key: 'claude:codeburn:coord', provider: 'claude', rawId: 'coord',
      snapshot: { observedAt: isoMinus(NOW, 100), cost: 'unknown' } });
    db.prepare('UPDATE usage_snapshots SET cost_amount_usd = ? WHERE session_key = ?')
      .run(Infinity, 'claude:codeburn:coord');
    linkRole(db, { key: 'claude:codeburn:coord', role: 'coordinator', host: 'host-a', run: 'run-1' });
    freshAttempts(db, 'host-a', 'run-1');
    assert.throws(
      () => buildOverheadReport(ctx(db), 'host-a', 'run-1', NOW),
      (err) => err.code === 'db_schema_drift',
    );
  } finally {
    fixture.close();
  }
});

test('RPT-F02: a token bucket aggregate that overflows Number.isSafeInteger is a structured DB schema error', () => {
  const fixture = setupOverheadDb();
  try {
    const { db } = fixture;
    insertRunGraph(db, 'host-a', 'run-1', ['dispatch-1']);
    insertSession(db, { key: 'claude:codeburn:coord1', provider: 'claude', rawId: 'coord1',
      snapshot: { observedAt: isoMinus(NOW, 100), cost: 1.0,
        tokensOverride: { input: Number.MAX_SAFE_INTEGER } } });
    insertSession(db, { key: 'claude:codeburn:coord2', provider: 'claude', rawId: 'coord2',
      snapshot: { observedAt: isoMinus(NOW, 100), cost: 1.0,
        tokensOverride: { input: Number.MAX_SAFE_INTEGER } } });
    linkRole(db, { key: 'claude:codeburn:coord1', role: 'coordinator', host: 'host-a', run: 'run-1' });
    linkRole(db, { key: 'claude:codeburn:coord2', role: 'coordinator', host: 'host-a', run: 'run-1' });
    freshAttempts(db, 'host-a', 'run-1');

    assert.throws(
      () => buildOverheadReport(ctx(db), 'host-a', 'run-1', NOW),
      (err) => err.code === 'db_schema_drift',
    );
  } finally {
    fixture.close();
  }
});

test('RPT-F02: a Codex reasoning aggregate above the safe integer limit is a structured DB schema error', () => {
  const fixture = setupOverheadDb();
  try {
    const { db } = fixture;
    insertRunGraph(db, 'host-a', 'run-1', ['dispatch-1']);
    for (const rawId of ['coord1', 'coord2']) {
      const key = `codex:codeburn:${rawId}`;
      insertSession(db, { key, provider: 'codex', rawId,
        snapshot: { observedAt: isoMinus(NOW, 100), cost: 1,
          tokensOverride: { reasoning: Number.MAX_SAFE_INTEGER } } });
      linkRole(db, { key, role: 'coordinator', host: 'host-a', run: 'run-1' });
    }
    freshAttempts(db, 'host-a', 'run-1');
    assert.throws(
      () => buildOverheadReport(ctx(db), 'host-a', 'run-1', NOW),
      (err) => err.code === 'db_schema_drift',
    );
  } finally {
    fixture.close();
  }
});

test('RPT-F02: a finite-per-role cost pair that overflows the overheadShare denominator is a structured DB schema error', () => {
  const fixture = setupOverheadDb();
  try {
    const { db } = fixture;
    insertRunGraph(db, 'host-a', 'run-1', ['dispatch-1']);
    insertSession(db, { key: 'claude:codeburn:coord', provider: 'claude', rawId: 'coord',
      snapshot: { observedAt: isoMinus(NOW, 100), cost: 1e308 } });
    insertSession(db, { key: 'claude:codeburn:w1', provider: 'claude', rawId: 'w1',
      snapshot: { observedAt: isoMinus(NOW, 100), cost: 1e308 } });
    linkRole(db, { key: 'claude:codeburn:coord', role: 'coordinator', host: 'host-a', run: 'run-1' });
    linkRole(db, { key: 'claude:codeburn:w1', role: 'worker', host: 'host-a', run: 'run-1', dispatch: 'dispatch-1' });
    freshAttempts(db, 'host-a', 'run-1');

    assert.throws(
      () => buildOverheadReport(ctx(db), 'host-a', 'run-1', NOW),
      (err) => err.code === 'db_schema_drift',
    );
  } finally {
    fixture.close();
  }
});

test('RPT-F03: --format --format=json still selects the JSON error envelope for a usage error', () => {
  const appHome = mkdtempSync(join(tmpdir(), 'orca-overhead-cli-format-dup-'));
  try {
    const result = runCli(appHome, 'report', 'overhead', '--format', '--format=json');
    assert.equal(result.status, 2);
    const body = JSON.parse(result.stdout.trim());
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'usage_error');
  } finally {
    rmSync(appHome, { recursive: true, force: true });
  }
});

test('RPT-F03: --format json --format malformed duplicate preserves the JSON error envelope', () => {
  const appHome = mkdtempSync(join(tmpdir(), 'orca-overhead-cli-format-dup2-'));
  try {
    const result = runCli(appHome, 'report', 'overhead', '--format', 'json', '--format', 'malformed');
    assert.equal(result.status, 2);
    const body = JSON.parse(result.stdout.trim());
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'usage_error');
  } finally {
    rmSync(appHome, { recursive: true, force: true });
  }
});

test('RPT-F03: --format json renders JSON for usage errors, a missing DB, an unknown Run, and a schema error, with exit codes preserved', () => {
  const appHome = mkdtempSync(join(tmpdir(), 'orca-overhead-cli-json-'));
  try {
    // Missing --run, no DB set up yet: usage error before DB is touched.
    const missingFlag = runCli(appHome, 'report', 'overhead', '--format', 'json');
    assert.equal(missingFlag.status, 2);
    assert.equal(missingFlag.stdout.trim().length > 0, true, 'stdout must carry the JSON error body');
    const missingFlagBody = JSON.parse(missingFlag.stdout.trim());
    assert.equal(missingFlagBody.ok, false);
    assert.equal(missingFlagBody.error.code, 'usage_error');

    // DB not initialized yet: report_setup error, still as JSON via --format.
    const missingDb = runCli(appHome, 'report', 'overhead', '--host', 'host-a', '--run', 'run-1', '--format', 'json');
    assert.equal(missingDb.status, 3);
    const missingDbBody = JSON.parse(missingDb.stdout.trim());
    assert.equal(missingDbBody.ok, false);
    assert.equal(missingDbBody.error.code, 'report_setup');

    const dbPath = join(appHome, 'telemetry.sqlite');
    const handle = openTelemetryDatabase({ dbPath });
    insertRunGraph(handle.db, 'host-a', 'run-1', ['dispatch-1']);
    handle.close();

    // Run exists in no DB row yet for host-b: unknown Run, still JSON via --format.
    const unknownRun = runCli(appHome, 'report', 'overhead', '--host', 'host-b', '--run', 'run-x', '--format', 'json');
    assert.equal(unknownRun.status, 3);
    const unknownRunBody = JSON.parse(unknownRun.stdout.trim());
    assert.equal(unknownRunBody.ok, false);
    assert.equal(unknownRunBody.error.code, 'report_setup');

    const handle2 = openTelemetryDatabase({ dbPath });
    insertSession(handle2.db, { key: 'claude:codeburn:coord', provider: 'claude', rawId: 'coord',
      snapshot: { observedAt: new Date().toISOString(), cost: 1.0, tokensOverride: { input: 'oops' } } });
    linkRole(handle2.db, { key: 'claude:codeburn:coord', role: 'coordinator', host: 'host-a', run: 'run-1' });
    handle2.close();

    // Schema error (malformed tokens_json), still JSON via --format, not global --json.
    const schemaErr = runCli(appHome, 'report', 'overhead', '--host', 'host-a', '--run', 'run-1', '--format', 'json');
    assert.equal(schemaErr.status, 4);
    const schemaErrBody = JSON.parse(schemaErr.stdout.trim());
    assert.equal(schemaErrBody.ok, false);
    assert.equal(schemaErrBody.error.code, 'db_schema_drift');

    // Global --json behavior is unchanged when --format json is absent.
    const globalJsonOnly = runCli(appHome, 'report', 'overhead', '--json');
    assert.equal(globalJsonOnly.status, 2);
    const globalJsonOnlyBody = JSON.parse(globalJsonOnly.stdout.trim());
    assert.equal(globalJsonOnlyBody.ok, false);
    assert.equal(globalJsonOnlyBody.error.code, 'usage_error');
  } finally {
    rmSync(appHome, { recursive: true, force: true });
  }
});

test('RPT-F04: ANSI/control characters in a DB-sourced completedAt never reach the text report', () => {
  const fixture = setupOverheadDb();
  try {
    const { db } = fixture;
    insertRunGraph(db, 'host-a', 'run-1', ['dispatch-1']);
    insertSession(db, { key: 'claude:codeburn:coord', provider: 'claude', rawId: 'coord',
      snapshot: { observedAt: isoMinus(NOW, 100), cost: 1.0 } });
    linkRole(db, { key: 'claude:codeburn:coord', role: 'coordinator', host: 'host-a', run: 'run-1' });
    attempt(db, { source: 'orca', hostId: 'host-a', runId: 'run-1', startedAt: isoMinus(NOW, 3700),
      completedAt: 'bad\u001b[31mRED\u001b[0m', status: 'success' });
    attempt(db, { source: 'codeburn', provider: 'claude', startedAt: isoMinus(NOW, 3700),
      completedAt: isoMinus(NOW, 3600), status: 'success' });
    attempt(db, { source: 'codeburn', provider: 'codex', startedAt: isoMinus(NOW, 3700),
      completedAt: isoMinus(NOW, 3600), status: 'success' });

    const report = buildOverheadReport(ctx(db), 'host-a', 'run-1', NOW);
    const text = formatOverheadReportText(report);
    // The raw ESC byte must never reach stdout verbatim, regardless of
    // whatever printable remainder sanitizeDisplayText leaves behind.
    assert.doesNotMatch(text, /\x1b/);
    assert.match(text, /completedAt=bad/);
  } finally {
    fixture.close();
  }
});
