import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { emptyConfig, saveConfig } from '../dist/config.js';
import { upsertProfile } from '../dist/profiles.js';
import { importCodeBurnUsage, openTelemetryDatabase } from '../dist/db/index.js';
import { parseCodexSessions } from '../dist/codeburn/codex.js';
import { linkSessionToRole, unlinkSessionRole } from '../dist/attribution/role-link.js';

const dir = dirname(fileURLToPath(import.meta.url));
const cli = resolve(dir, '../dist/cli.js');
const ghResolveStub = resolve(dir, 'helpers/integration-stubs/gh-collect.mjs');

function runCli(cwd, env, ...args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function makeCodexRow(sessionId) {
  return {
    sessionId,
    title: '',
    project: 'role-link-fixture',
    provider: 'codex',
    models: ['GPT-6.1 Sol'],
    cost: 0.01,
    savingsUSD: 0,
    calls: 1,
    turns: 1,
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    startedAt: '2026-10-24T00:00:00.000Z',
    endedAt: '2026-10-24T00:00:01.000Z',
    durationMs: 1000,
    estimatedCost: 0,
    isEstimated: false,
  };
}

function insertRunGraph(db, host, run, dispatch) {
  db.prepare('INSERT OR IGNORE INTO orca_runs VALUES (?, ?, ?, ?)')
    .run(host, run, '2026-10-24T00:00:00Z', '1.4.237');
  db.prepare('INSERT OR IGNORE INTO orca_tasks (host_id, run_id, task_id) VALUES (?, ?, ?)')
    .run(host, run, 'task-1');
  if (dispatch) {
    db.prepare(`INSERT OR IGNORE INTO orca_dispatches
      (host_id, run_id, task_id, dispatch_id) VALUES (?, ?, ?, ?)`)
      .run(host, run, 'task-1', dispatch);
  }
}

function setupRepoAndHome() {
  const repo = mkdtempSync(join(tmpdir(), 'orca-role-repo-'));
  execFileSync('git', ['init'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'r@test.com'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'r'], { cwd: repo });
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/o/r.git'], { cwd: repo });

  const appHome = mkdtempSync(join(tmpdir(), 'orca-role-home-'));
  mkdirSync(appHome, { recursive: true });
  const { config } = upsertProfile(emptyConfig(), {
    id: 'R_role', nameWithOwner: 'o/r', url: 'https://github.com/o/r',
  }, {
    id: 'PVT_role', number: 1, title: 'P', url: 'https://github.com/users/o/projects/1',
    closed: false, owner: { kind: 'user', login: 'o' }, sources: ['repository'],
  });
  saveConfig(appHome, config);

  const dbPath = join(appHome, 'telemetry.sqlite');
  const handle = openTelemetryDatabase({ dbPath, gitRoot: repo });

  const env = {
    ORCA_TELEMETRY_HOME: appHome,
    ORCA_TELEMETRY_GH: ghResolveStub,
    GH_STUB_REPO_VIEW_JSON: JSON.stringify({ id: 'R_role', nameWithOwner: 'o/r', url: 'https://github.com/o/r' }),
  };

  return { repo, appHome, env, dbPath, handle };
}

function seedSession(db, rawId, provider = 'codex') {
  const observedAt = '2026-01-01T00:00:00.000Z';
  const row = makeCodexRow(rawId);
  const parsed = parseCodexSessions([row], observedAt, '0.9.27')[0];
  importCodeBurnUsage(db, [{
    session: parsed.session,
    snapshot: parsed.snapshot,
    models: parsed.metadata.models,
    tokenAllocation: 'known',
    projectHint: parsed.metadata.projectHint,
  }]);
  return `${provider}:codeburn:${rawId}`;
}

function throwsCode(fn, code) {
  try {
    fn();
  } catch (err) {
    assert.equal(err.code, code, `expected code ${code}, got ${err.code}: ${err.message}`);
    return;
  }
  assert.fail(`expected a CliError with code ${code}`);
}

function cleanup(ctx) {
  try {
    ctx.handle.close();
  } catch {
    // already closed
  }
  rmSync(ctx.repo, { recursive: true, force: true });
  rmSync(ctx.appHome, { recursive: true, force: true });
}

test('role-links: coordinator link via CLI is idempotent, then rejects a conflicting re-link', () => {
  const ctx = setupRepoAndHome();
  insertRunGraph(ctx.handle.db, 'host-a', 'run-1', 'dispatch-x');
  const sessionId = seedSession(ctx.handle.db, 's-coord-1');
  ctx.handle.close();

  const linkArgs = [
    'link-role', '--host', 'host-a', '--run', 'run-1', '--role', 'coordinator',
    '--provider', 'codex', '--session', 's-coord-1', '--verifier', 'operator1',
    '--evidence-note', 'operator_observed_same_session', '--confirm-same-session', '--json',
  ];
  const first = runCli(ctx.repo, ctx.env, ...linkArgs);
  assert.equal(first.status, 0, first.stderr);
  const firstBody = JSON.parse(first.stdout.trim());
  assert.equal(firstBody.ok, true);
  assert.equal(firstBody.data.outcome, 'created');
  assert.equal(firstBody.data.link.sessionKey, sessionId);
  assert.equal(firstBody.data.link.role, 'coordinator');

  const second = runCli(ctx.repo, ctx.env, ...linkArgs);
  assert.equal(second.status, 0);
  const secondBody = JSON.parse(second.stdout.trim());
  assert.equal(secondBody.data.outcome, 'unchanged');

  const conflictArgs = [
    'link-role', '--host', 'host-a', '--run', 'run-1', '--role', 'worker',
    '--dispatch', 'dispatch-x', '--provider', 'codex', '--session', 's-coord-1',
    '--verifier', 'operator1', '--confirm-same-session', '--json',
  ];
  const conflict = runCli(ctx.repo, ctx.env, ...conflictArgs);
  const conflictBody = JSON.parse(conflict.stdout.trim());
  assert.equal(conflictBody.ok, false);
  assert.equal(conflictBody.error.code, 'role_link_conflict');

  cleanup(ctx);
});

test('role-links: CLI validation rejects missing --confirm-same-session, missing --dispatch, and bad --evidence-note', () => {
  const ctx = setupRepoAndHome();
  insertRunGraph(ctx.handle.db, 'host-a', 'run-1', 'dispatch-1');
  seedSession(ctx.handle.db, 's-cli-1');
  ctx.handle.close();

  const missingConfirm = runCli(ctx.repo, ctx.env,
    'link-role', '--host', 'host-a', '--run', 'run-1', '--role', 'coordinator',
    '--provider', 'codex', '--session', 's-cli-1', '--verifier', 'operator1');
  assert.equal(missingConfirm.status, 2);
  assert.match(missingConfirm.stderr, /confirm-same-session/);

  const missingDispatch = runCli(ctx.repo, ctx.env,
    'link-role', '--host', 'host-a', '--run', 'run-1', '--role', 'worker',
    '--provider', 'codex', '--session', 's-cli-1', '--verifier', 'operator1',
    '--confirm-same-session');
  assert.equal(missingDispatch.status, 2);
  assert.match(missingDispatch.stderr, /dispatch/i);

  const badEvidence = runCli(ctx.repo, ctx.env,
    'link-role', '--host', 'host-a', '--run', 'run-1', '--role', 'coordinator',
    '--provider', 'codex', '--session', 's-cli-1', '--verifier', 'operator1',
    '--evidence-note', 'prompt leak', '--confirm-same-session');
  assert.equal(badEvidence.status, 2);
  assert.match(badEvidence.stderr, /evidence-note/i);

  cleanup(ctx);
});

test('role-links: link-role and unlink-role reject an invalid --verifier as a usage error, with no mutation', () => {
  const ctx = setupRepoAndHome();
  insertRunGraph(ctx.handle.db, 'host-a', 'run-1', 'dispatch-1');
  seedSession(ctx.handle.db, 's-verifier-1');
  ctx.handle.close();

  const badLink = runCli(ctx.repo, ctx.env,
    'link-role', '--host', 'host-a', '--run', 'run-1', '--role', 'coordinator',
    '--provider', 'codex', '--session', 's-verifier-1', '--verifier', 'bad verifier',
    '--confirm-same-session');
  assert.equal(badLink.status, 2);
  assert.match(badLink.stderr, /verifier/i);

  const checkDb1 = openTelemetryDatabase({ dbPath: ctx.dbPath, gitRoot: ctx.repo });
  assert.equal(checkDb1.db.prepare('SELECT COUNT(*) AS n FROM session_role_links').get().n, 0);
  checkDb1.close();

  // Seed a real link out-of-band so unlink-role's bad-verifier rejection can
  // be checked without first needing a successful link-role call.
  const seeded = openTelemetryDatabase({ dbPath: ctx.dbPath, gitRoot: ctx.repo });
  linkSessionToRole(seeded.db, {
    provider: 'codex', rawSessionId: 's-verifier-1', role: 'coordinator',
    hostId: 'host-a', runId: 'run-1', verifier: 'operator1', linkedAt: '2026-10-24T00:00:00Z',
  });
  seeded.close();

  const badUnlink = runCli(ctx.repo, ctx.env,
    'unlink-role', '--host', 'host-a', '--run', 'run-1', '--role', 'coordinator',
    '--provider', 'codex', '--session', 's-verifier-1', '--verifier', '!!not-allowed!!');
  assert.equal(badUnlink.status, 2);
  assert.match(badUnlink.stderr, /verifier/i);

  const checkDb2 = openTelemetryDatabase({ dbPath: ctx.dbPath, gitRoot: ctx.repo });
  assert.equal(checkDb2.db.prepare('SELECT COUNT(*) AS n FROM session_role_links').get().n, 1);
  assert.equal(checkDb2.db.prepare('SELECT COUNT(*) AS n FROM session_role_link_audit').get().n, 0);
  checkDb2.close();

  cleanup(ctx);
});

test('role-links: missing session, Run, and Dispatch are rejected without writing a link', () => {
  const ctx = setupRepoAndHome();
  insertRunGraph(ctx.handle.db, 'host-a', 'run-1', 'dispatch-1');
  seedSession(ctx.handle.db, 's-missing-1');
  const db = ctx.handle.db;

  throwsCode(() => linkSessionToRole(db, {
    provider: 'codex', rawSessionId: 'missing-session', role: 'coordinator',
    hostId: 'host-a', runId: 'run-1', verifier: 'operator1', linkedAt: '2026-10-24T00:00:00Z',
  }), 'role_link_session_unknown');

  throwsCode(() => linkSessionToRole(db, {
    provider: 'codex', rawSessionId: 's-missing-1', role: 'coordinator',
    hostId: 'host-a', runId: 'missing-run', verifier: 'operator1', linkedAt: '2026-10-24T00:00:00Z',
  }), 'role_link_run_unknown');

  throwsCode(() => linkSessionToRole(db, {
    provider: 'codex', rawSessionId: 's-missing-1', role: 'worker',
    hostId: 'host-a', runId: 'run-1', dispatchId: 'missing-dispatch',
    verifier: 'operator1', linkedAt: '2026-10-24T00:00:00Z',
  }), 'role_link_dispatch_unknown');

  throwsCode(() => linkSessionToRole(db, {
    provider: 'codex', rawSessionId: 's-missing-1', role: 'worker',
    hostId: 'host-a', runId: 'run-1', verifier: 'operator1', linkedAt: '2026-10-24T00:00:00Z',
  }), 'role_link_dispatch_missing');

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM session_role_links').get().n, 0);
  cleanup(ctx);
});

test('role-links: cross-host same raw run/dispatch IDs are isolated tuples', () => {
  const ctx = setupRepoAndHome();
  const db = ctx.handle.db;
  insertRunGraph(db, 'host-a', 'run-1', 'same-dispatch');
  insertRunGraph(db, 'host-b', 'run-1', 'same-dispatch');
  const sessionA = seedSession(db, 's-cross-a');
  const sessionB = seedSession(db, 's-cross-b');

  const resultA = linkSessionToRole(db, {
    provider: 'codex', rawSessionId: 's-cross-a', role: 'worker',
    hostId: 'host-a', runId: 'run-1', dispatchId: 'same-dispatch',
    verifier: 'operator1', linkedAt: '2026-10-24T00:00:00Z',
  });
  assert.equal(resultA.outcome, 'created');
  assert.equal(resultA.link.sessionKey, sessionA);

  const resultB = linkSessionToRole(db, {
    provider: 'codex', rawSessionId: 's-cross-b', role: 'worker',
    hostId: 'host-b', runId: 'run-1', dispatchId: 'same-dispatch',
    verifier: 'operator1', linkedAt: '2026-10-24T00:00:00Z',
  });
  assert.equal(resultB.outcome, 'created');
  assert.equal(resultB.link.sessionKey, sessionB);

  // The same session cannot be reused against the other host's tuple.
  throwsCode(() => linkSessionToRole(db, {
    provider: 'codex', rawSessionId: 's-cross-a', role: 'worker',
    hostId: 'host-b', runId: 'run-1', dispatchId: 'same-dispatch',
    verifier: 'operator1', linkedAt: '2026-10-24T00:00:00Z',
  }), 'role_link_conflict');

  const rows = db.prepare('SELECT host_id, run_id, dispatch_id FROM session_role_links ORDER BY host_id').all()
    .map((row) => ({ host_id: row.host_id, run_id: row.run_id, dispatch_id: row.dispatch_id }));
  assert.deepEqual(rows, [
    { host_id: 'host-a', run_id: 'run-1', dispatch_id: 'same-dispatch' },
    { host_id: 'host-b', run_id: 'run-1', dispatch_id: 'same-dispatch' },
  ]);

  cleanup(ctx);
});

test('role-links: exact repeat is idempotent, differing provenance is a conflict', () => {
  const ctx = setupRepoAndHome();
  const db = ctx.handle.db;
  insertRunGraph(db, 'host-a', 'run-1', 'dispatch-1');
  seedSession(db, 's-idem-1');

  const base = {
    provider: 'codex', rawSessionId: 's-idem-1', role: 'worker',
    hostId: 'host-a', runId: 'run-1', dispatchId: 'dispatch-1',
    verifier: 'operator1', evidenceNote: 'ids_visible_same_session',
    linkedAt: '2026-10-24T00:00:00Z',
  };
  const created = linkSessionToRole(db, base);
  assert.equal(created.outcome, 'created');

  const repeatSameVerifier = linkSessionToRole(db, { ...base, verifier: 'operator2' });
  assert.equal(repeatSameVerifier.outcome, 'unchanged');
  assert.equal(repeatSameVerifier.link.linkedBy, created.link.linkedBy);

  throwsCode(() => linkSessionToRole(db, { ...base, evidenceNote: 'operator_observed_same_session' }),
    'role_link_conflict');
  throwsCode(() => linkSessionToRole(db, { ...base, dispatchId: 'dispatch-2-missing' }),
    'role_link_dispatch_unknown');

  insertRunGraph(db, 'host-a', 'run-1', 'dispatch-2');
  throwsCode(() => linkSessionToRole(db, { ...base, dispatchId: 'dispatch-2' }),
    'role_link_conflict');

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM session_role_links').get().n, 1);
  cleanup(ctx);
});

test('role-links: unlink writes a durable audit row atomically and survives DB reopen', () => {
  const ctx = setupRepoAndHome();
  insertRunGraph(ctx.handle.db, 'host-a', 'run-1', 'dispatch-1');
  seedSession(ctx.handle.db, 's-unlink-1');
  linkSessionToRole(ctx.handle.db, {
    provider: 'codex', rawSessionId: 's-unlink-1', role: 'worker',
    hostId: 'host-a', runId: 'run-1', dispatchId: 'dispatch-1',
    verifier: 'operator1', linkedAt: '2026-10-24T00:00:00Z',
  });
  ctx.handle.close();

  const reopened1 = openTelemetryDatabase({ dbPath: ctx.dbPath, gitRoot: ctx.repo });
  const result = unlinkSessionRole(reopened1.db, {
    provider: 'codex', rawSessionId: 's-unlink-1', role: 'worker',
    hostId: 'host-a', runId: 'run-1', dispatchId: 'dispatch-1',
    verifier: 'operator2', unlinkedAt: '2026-10-24T01:00:00Z',
  });
  assert.equal(result.outcome, 'deleted');
  assert.equal(reopened1.db.prepare('SELECT COUNT(*) AS n FROM session_role_links').get().n, 0);
  reopened1.close();

  const reopened2 = openTelemetryDatabase({ dbPath: ctx.dbPath, gitRoot: ctx.repo });
  const audit = reopened2.db.prepare(`SELECT session_key, role, host_id, run_id, dispatch_id,
    linked_at, linked_by, unlinked_at, unlinked_by FROM session_role_link_audit`).get();
  assert.equal(audit.session_key, 'codex:codeburn:s-unlink-1');
  assert.equal(audit.role, 'worker');
  assert.equal(audit.host_id, 'host-a');
  assert.equal(audit.run_id, 'run-1');
  assert.equal(audit.dispatch_id, 'dispatch-1');
  assert.equal(audit.unlinked_at, '2026-10-24T01:00:00Z');
  assert.notEqual(audit.linked_by, audit.unlinked_by);
  assert.equal(reopened2.db.prepare('SELECT COUNT(*) AS n FROM session_role_links').get().n, 0);
  reopened2.close();

  cleanup(ctx);
});

test('role-links: unlink selector mismatch and missing link are rejected without mutation', () => {
  const ctx = setupRepoAndHome();
  const db = ctx.handle.db;
  insertRunGraph(db, 'host-a', 'run-1', 'dispatch-1');
  seedSession(db, 's-mismatch-1');
  linkSessionToRole(db, {
    provider: 'codex', rawSessionId: 's-mismatch-1', role: 'worker',
    hostId: 'host-a', runId: 'run-1', dispatchId: 'dispatch-1',
    verifier: 'operator1', linkedAt: '2026-10-24T00:00:00Z',
  });

  throwsCode(() => unlinkSessionRole(db, {
    provider: 'codex', rawSessionId: 's-mismatch-1', role: 'coordinator',
    hostId: 'host-a', runId: 'run-1', verifier: 'operator2', unlinkedAt: '2026-10-24T01:00:00Z',
  }), 'role_link_selector_mismatch');

  throwsCode(() => unlinkSessionRole(db, {
    provider: 'codex', rawSessionId: 'never-linked', role: 'coordinator',
    hostId: 'host-a', runId: 'run-1', verifier: 'operator2', unlinkedAt: '2026-10-24T01:00:00Z',
  }), 'role_link_not_found');

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM session_role_links').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM session_role_link_audit').get().n, 0);

  cleanup(ctx);
});

test('role-links: a failing audit write rolls back and leaves the live link untouched', () => {
  const ctx = setupRepoAndHome();
  const db = ctx.handle.db;
  insertRunGraph(db, 'host-a', 'run-1', null);
  seedSession(db, 's-rollback-1');
  linkSessionToRole(db, {
    provider: 'codex', rawSessionId: 's-rollback-1', role: 'coordinator',
    hostId: 'host-a', runId: 'run-1', verifier: 'operator1', linkedAt: '2026-10-24T00:00:00Z',
  });

  // Force the audit INSERT inside the transaction to violate its CHECK
  // constraint (role/dispatch mismatch) and confirm the DELETE never commits.
  assert.throws(() => {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`INSERT INTO session_role_link_audit
        (session_key, role, host_id, run_id, dispatch_id, linked_at, linked_by,
          unlinked_at, unlinked_by)
        VALUES ('codex:codeburn:s-rollback-1', 'coordinator', 'host-a', 'run-1', 'dispatch-1',
          '2026-10-24T00:00:00Z', ?, '2026-10-24T01:00:00Z', ?)`)
        .run(
          'sha256:' + '0'.repeat(64),
          'sha256:' + '0'.repeat(64),
        );
      db.prepare('DELETE FROM session_role_links WHERE session_key = ?').run('codex:codeburn:s-rollback-1');
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  });

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM session_role_links').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM session_role_link_audit').get().n, 0);

  cleanup(ctx);
});

test('role-links: unlink holds its write lock across the read-check-delete span, closing the F01 relink race', () => {
  const ctx = setupRepoAndHome();
  const db = ctx.handle.db;
  insertRunGraph(db, 'host-a', 'run-1', 'dispatch-old');
  insertRunGraph(db, 'host-a', 'run-1', 'dispatch-new');
  seedSession(db, 's-race-1');
  linkSessionToRole(db, {
    provider: 'codex', rawSessionId: 's-race-1', role: 'worker',
    hostId: 'host-a', runId: 'run-1', dispatchId: 'dispatch-old',
    verifier: 'operator1', linkedAt: '2026-10-24T00:00:00Z',
  });
  ctx.handle.close();

  const connA = openTelemetryDatabase({ dbPath: ctx.dbPath, gitRoot: ctx.repo });
  const connB = openTelemetryDatabase({ dbPath: ctx.dbPath, gitRoot: ctx.repo });

  // Simulate writer A holding the write lock for the whole read-check-delete
  // span (the F01 fix). Before the fix, A's read of the existing link ran in
  // autocommit mode *before* any lock was taken, leaving a window for writer
  // B to relink the session; A would then delete B's new row while auditing
  // the stale row it had read earlier. With the fix, that whole span is one
  // write transaction, so B's write cannot land until A's attempt finishes.
  connA.db.exec('BEGIN IMMEDIATE');
  try {
    assert.throws(() => {
      unlinkSessionRole(connB.db, {
        provider: 'codex', rawSessionId: 's-race-1', role: 'worker',
        hostId: 'host-a', runId: 'run-1', dispatchId: 'dispatch-old',
        verifier: 'operatorB', unlinkedAt: '2026-10-24T00:30:00Z',
      });
    }, /locked|busy/i);
  } finally {
    connA.db.exec('ROLLBACK');
  }

  // With A's attempt abandoned, writer B unlinks and relinks to a new target.
  const bUnlink = unlinkSessionRole(connB.db, {
    provider: 'codex', rawSessionId: 's-race-1', role: 'worker',
    hostId: 'host-a', runId: 'run-1', dispatchId: 'dispatch-old',
    verifier: 'operatorB', unlinkedAt: '2026-10-24T00:30:00Z',
  });
  assert.equal(bUnlink.outcome, 'deleted');
  linkSessionToRole(connB.db, {
    provider: 'codex', rawSessionId: 's-race-1', role: 'worker',
    hostId: 'host-a', runId: 'run-1', dispatchId: 'dispatch-new',
    verifier: 'operatorB', linkedAt: '2026-10-24T00:31:00Z',
  });

  // Writer A's original request, targeting the now-stale dispatch-old
  // selector, must reject against the *current* row instead of deleting the
  // dispatch-new link or auditing a row that no longer exists.
  throwsCode(() => unlinkSessionRole(connA.db, {
    provider: 'codex', rawSessionId: 's-race-1', role: 'worker',
    hostId: 'host-a', runId: 'run-1', dispatchId: 'dispatch-old',
    verifier: 'operatorA', unlinkedAt: '2026-10-24T00:32:00Z',
  }), 'role_link_selector_mismatch');

  const live = connA.db.prepare('SELECT dispatch_id FROM session_role_links WHERE session_key = ?')
    .get('codex:codeburn:s-race-1');
  assert.equal(live.dispatch_id, 'dispatch-new');

  const audit = connA.db.prepare('SELECT dispatch_id FROM session_role_link_audit WHERE session_key = ?')
    .get('codex:codeburn:s-race-1');
  assert.equal(audit.dispatch_id, 'dispatch-old');

  connA.close();
  connB.close();
  cleanup(ctx);
});

test('role-links: unlink only deletes and audits the exact row matching all selectors, never a differently-scoped row', () => {
  const ctx = setupRepoAndHome();
  const db = ctx.handle.db;
  insertRunGraph(db, 'host-a', 'run-1', 'dispatch-1');
  seedSession(db, 's-exact-1');
  linkSessionToRole(db, {
    provider: 'codex', rawSessionId: 's-exact-1', role: 'worker',
    hostId: 'host-a', runId: 'run-1', dispatchId: 'dispatch-1',
    verifier: 'operator1', linkedAt: '2026-10-24T00:00:00Z',
  });

  const result = unlinkSessionRole(db, {
    provider: 'codex', rawSessionId: 's-exact-1', role: 'worker',
    hostId: 'host-a', runId: 'run-1', dispatchId: 'dispatch-1',
    verifier: 'operator2', unlinkedAt: '2026-10-24T01:00:00Z',
  });
  assert.equal(result.outcome, 'deleted');
  assert.equal(result.link.dispatchId, 'dispatch-1');

  const audit = db.prepare(`SELECT session_key, role, host_id, run_id, dispatch_id
    FROM session_role_link_audit WHERE session_key = ?`).get('codex:codeburn:s-exact-1');
  assert.equal(audit.dispatch_id, 'dispatch-1');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM session_role_links').get().n, 0);

  cleanup(ctx);
});

test('role-links: linking a role never writes to Issue session_links or issues tables', () => {
  const ctx = setupRepoAndHome();
  const db = ctx.handle.db;
  insertRunGraph(db, 'host-a', 'run-1', null);
  seedSession(db, 's-issue-1');

  const beforeLinks = db.prepare('SELECT COUNT(*) AS n FROM session_links').get().n;
  const beforeIssues = db.prepare('SELECT COUNT(*) AS n FROM issues').get().n;

  linkSessionToRole(db, {
    provider: 'codex', rawSessionId: 's-issue-1', role: 'coordinator',
    hostId: 'host-a', runId: 'run-1', verifier: 'operator1', linkedAt: '2026-10-24T00:00:00Z',
  });

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM session_links').get().n, beforeLinks);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM issues').get().n, beforeIssues);

  cleanup(ctx);
});

test('V1.4: coordinator --host inference resolves only an exact unique Run; 0/2 hosts fail with safe candidates, no mutation', () => {
  const ctx = setupRepoAndHome();
  const db = ctx.handle.db;
  const hostileHost = 'host-b\u001b[31m\nnext\u0085';
  const safeHost = JSON.stringify(hostileHost).replace('\u0085', '\\u0085');
  seedSession(db, 's-coord-infer-1');
  seedSession(db, 's-coord-infer-2');
  ctx.handle.close();

  const zero = runCli(ctx.repo, ctx.env,
    'link-role', '--run', 'missing-run', '--role', 'coordinator',
    '--provider', 'codex', '--session', 's-coord-infer-1', '--verifier', 'operator1',
    '--confirm-same-session', '--json');
  assert.equal(zero.status, 2);
  assert.equal(JSON.parse(zero.stdout).error.code, 'role_link_run_not_found');
  assert.match(JSON.parse(zero.stdout).error.message, /candidate host IDs: \[\]/);

  const checkAfterZero = openTelemetryDatabase({ dbPath: ctx.dbPath, gitRoot: ctx.repo });
  assert.equal(checkAfterZero.db.prepare('SELECT COUNT(*) AS n FROM session_role_links').get().n, 0);
  insertRunGraph(checkAfterZero.db, 'host-a', 'run-infer', null);
  checkAfterZero.close();

  const one = runCli(ctx.repo, ctx.env,
    'link-role', '--run', 'run-infer', '--role', 'coordinator',
    '--provider', 'codex', '--session', 's-coord-infer-1', '--verifier', 'operator1',
    '--confirm-same-session', '--json');
  assert.equal(one.status, 0, one.stderr);
  const oneBody = JSON.parse(one.stdout.trim());
  assert.equal(oneBody.data.outcome, 'created');
  assert.equal(oneBody.data.link.hostId, 'host-a');

  const addSecondHost = openTelemetryDatabase({ dbPath: ctx.dbPath, gitRoot: ctx.repo });
  insertRunGraph(addSecondHost.db, hostileHost, 'run-infer', null);
  addSecondHost.close();

  const before = readFileSync(ctx.dbPath);
  const two = runCli(ctx.repo, ctx.env,
    'link-role', '--run', 'run-infer', '--role', 'coordinator',
    '--provider', 'codex', '--session', 's-coord-infer-2', '--verifier', 'operator1',
    '--confirm-same-session', '--json');
  assert.equal(two.status, 2);
  const twoError = JSON.parse(two.stdout).error;
  assert.equal(twoError.code, 'role_link_run_ambiguous');
  assert.ok(twoError.message.includes(`["host-a",${safeHost}]`));
  assert.doesNotMatch(two.stdout, /[\u001b\u0085]|\nnext/);
  assert.deepEqual(readFileSync(ctx.dbPath), before);

  const explicit = runCli(ctx.repo, ctx.env,
    'link-role', '--run', 'run-infer', '--host', 'host-a', '--role', 'coordinator',
    '--provider', 'codex', '--session', 's-coord-infer-2', '--verifier', 'operator1',
    '--confirm-same-session', '--json');
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.equal(JSON.parse(explicit.stdout).data.link.hostId, 'host-a');

  cleanup(ctx);
});

test('V1.4: worker --host/--run inference over orca_dispatches requires exactly one tuple; explicit selectors never fall back', () => {
  const ctx = setupRepoAndHome();
  const db = ctx.handle.db;
  insertRunGraph(db, 'host-a', 'run-1', 'dup-dispatch');
  insertRunGraph(db, 'host-a', 'run-2', 'dup-dispatch');
  insertRunGraph(db, 'host-b', 'run-1', 'dup-dispatch');
  insertRunGraph(db, 'host-a', 'run-1', 'unique-dispatch');
  seedSession(db, 's-worker-infer-1');
  seedSession(db, 's-worker-infer-2');
  seedSession(db, 's-worker-infer-3');
  seedSession(db, 's-worker-infer-4');
  ctx.handle.close();

  // Dispatch alone with no selectors matches three tuples: ambiguous, no mutation.
  const ambiguousAll = runCli(ctx.repo, ctx.env,
    'link-role', '--role', 'worker', '--dispatch', 'dup-dispatch',
    '--provider', 'codex', '--session', 's-worker-infer-1', '--verifier', 'operator1',
    '--confirm-same-session', '--json');
  assert.equal(ambiguousAll.status, 2);
  assert.equal(JSON.parse(ambiguousAll.stdout).error.code, 'role_link_dispatch_ambiguous');

  // Narrowing with --host alone still leaves two Runs under host-a: ambiguous.
  const ambiguousHost = runCli(ctx.repo, ctx.env,
    'link-role', '--role', 'worker', '--dispatch', 'dup-dispatch', '--host', 'host-a',
    '--provider', 'codex', '--session', 's-worker-infer-1', '--verifier', 'operator1',
    '--confirm-same-session', '--json');
  assert.equal(ambiguousHost.status, 2);
  assert.equal(JSON.parse(ambiguousHost.stdout).error.code, 'role_link_dispatch_ambiguous');

  // Narrowing with --run alone resolves uniquely to host-a/run-2.
  const uniqueByRun = runCli(ctx.repo, ctx.env,
    'link-role', '--role', 'worker', '--dispatch', 'dup-dispatch', '--run', 'run-2',
    '--provider', 'codex', '--session', 's-worker-infer-1', '--verifier', 'operator1',
    '--confirm-same-session', '--json');
  assert.equal(uniqueByRun.status, 0, uniqueByRun.stderr);
  const uniqueByRunBody = JSON.parse(uniqueByRun.stdout.trim());
  assert.equal(uniqueByRunBody.data.link.hostId, 'host-a');
  assert.equal(uniqueByRunBody.data.link.runId, 'run-2');

  // A dispatch that is unique by itself resolves with no host/run given.
  const uniqueByDispatch = runCli(ctx.repo, ctx.env,
    'link-role', '--role', 'worker', '--dispatch', 'unique-dispatch',
    '--provider', 'codex', '--session', 's-worker-infer-2', '--verifier', 'operator1',
    '--confirm-same-session', '--json');
  assert.equal(uniqueByDispatch.status, 0, uniqueByDispatch.stderr);
  assert.equal(JSON.parse(uniqueByDispatch.stdout).data.link.hostId, 'host-a');
  assert.equal(JSON.parse(uniqueByDispatch.stdout).data.link.runId, 'run-1');

  // Unknown dispatch with no selectors: 0 candidates, not ambiguous, not a default pick.
  const zero = runCli(ctx.repo, ctx.env,
    'link-role', '--role', 'worker', '--dispatch', 'missing-dispatch',
    '--provider', 'codex', '--session', 's-worker-infer-3', '--verifier', 'operator1',
    '--confirm-same-session', '--json');
  assert.equal(zero.status, 2);
  assert.equal(JSON.parse(zero.stdout).error.code, 'role_link_dispatch_not_found');
  assert.match(JSON.parse(zero.stdout).error.message, /candidate tuples: \[\]/);

  // Explicit --host/--run name a real Run that does not contain the given
  // dispatch; this must fail outright, never silently resolving to a
  // different real tuple that *does* contain it.
  const wrongExplicit = runCli(ctx.repo, ctx.env,
    'link-role', '--role', 'worker', '--dispatch', 'unique-dispatch',
    '--host', 'host-b', '--run', 'run-1',
    '--provider', 'codex', '--session', 's-worker-infer-4', '--verifier', 'operator1',
    '--confirm-same-session', '--json');
  assert.equal(wrongExplicit.status, 2);
  assert.equal(JSON.parse(wrongExplicit.stdout).error.code, 'role_link_dispatch_unknown');

  const finalDb = openTelemetryDatabase({ dbPath: ctx.dbPath, gitRoot: ctx.repo });
  assert.equal(finalDb.db.prepare('SELECT COUNT(*) AS n FROM session_role_links').get().n, 2);
  finalDb.close();

  cleanup(ctx);
});

test('V1.4: selection and the role-link write run under one BEGIN IMMEDIATE, so a concurrent writer cannot change candidate cardinality mid-resolve', () => {
  const ctx = setupRepoAndHome();
  const db = ctx.handle.db;
  insertRunGraph(db, 'host-a', 'run-1', 'race-dispatch');
  seedSession(db, 's-race-infer-1');
  ctx.handle.close();

  const connA = openTelemetryDatabase({ dbPath: ctx.dbPath, gitRoot: ctx.repo });
  const connB = openTelemetryDatabase({ dbPath: ctx.dbPath, gitRoot: ctx.repo });

  // Writer A holds the write lock while a second Run with the same raw
  // dispatch ID would make resolution ambiguous. Writer B's attempt to
  // resolve+link by --dispatch alone must not interleave with A's write; it
  // either sees the pre-A state (one tuple) or is rejected as busy/locked —
  // never a result computed from a stale, partially-written candidate set.
  connA.db.exec('BEGIN IMMEDIATE');
  try {
    assert.throws(() => {
      linkSessionToRole(connB.db, {
        provider: 'codex', rawSessionId: 's-race-infer-1', role: 'worker',
        dispatchId: 'race-dispatch', verifier: 'operatorB', linkedAt: '2026-10-24T00:00:00Z',
      });
    }, /locked|busy/i);
    connA.db.prepare('INSERT OR IGNORE INTO orca_runs VALUES (?, ?, ?, ?)')
      .run('host-a', 'run-2', '2026-10-24T00:00:00Z', '1.4.237');
    connA.db.prepare(`INSERT INTO orca_tasks (host_id, run_id, task_id) VALUES (?, ?, ?)`)
      .run('host-a', 'run-2', 'task-1');
    connA.db.prepare(`INSERT INTO orca_dispatches
      (host_id, run_id, task_id, dispatch_id) VALUES (?, ?, ?, ?)`)
      .run('host-a', 'run-2', 'task-1', 'race-dispatch');
    connA.db.exec('COMMIT');
  } catch (err) {
    connA.db.exec('ROLLBACK');
    throw err;
  }

  // Now that A committed a second tuple, resolution by --dispatch alone is
  // genuinely ambiguous: B's retry must fail, not silently pick one.
  throwsCode(() => linkSessionToRole(connB.db, {
    provider: 'codex', rawSessionId: 's-race-infer-1', role: 'worker',
    dispatchId: 'race-dispatch', verifier: 'operatorB', linkedAt: '2026-10-24T00:01:00Z',
  }), 'role_link_dispatch_ambiguous');

  assert.equal(connB.db.prepare('SELECT COUNT(*) AS n FROM session_role_links').get().n, 0);

  connA.close();
  connB.close();
  cleanup(ctx);
});

test('V1.4: link-role help documents optional selector inference for coordinator and worker', async () => {
  const { commandHelpText } = await import('../dist/commands/help.js');
  const text = commandHelpText('link-role');
  assert.match(text, /--run <run-id> \[--host <host-id>\] --role coordinator/);
  assert.match(text, /--dispatch <dispatch-id> \[--host <host-id>\] \[--run <run-id>\]/);
  assert.match(text, /exact filter, never a hint/);
});
