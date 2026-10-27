import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'vitest';
import { openTelemetryDatabase, openReadOnlyTelemetryDb } from '../dist/db/index.js';
import { MIGRATION_V1_STATEMENTS } from '../dist/db/migrations/v1.js';
import { MIGRATION_V2_STATEMENTS } from '../dist/db/migrations/v2.js';
import { MIGRATION_V3_STATEMENTS } from '../dist/db/migrations/v3.js';
import { MIGRATION_V4_STATEMENTS } from '../dist/db/migrations/v4.js';
import { MIGRATION_V5_STATEMENTS } from '../dist/db/migrations/v5.js';
import { MIGRATION_V6_STATEMENTS } from '../dist/db/migrations/v6.js';
import {
  scopedExecutionKey, insertScopedExecution, insertManualRoleLink,
  insertCollectionAttempt, verifierIdentityHash,
} from '../dist/db/run-provenance.js';

function withPath(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'orca-v14-db-'));
  const path = join(dir, 'telemetry.sqlite');
  try {
    return fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function seedVersion(path, version) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  const migrations = [MIGRATION_V1_STATEMENTS, MIGRATION_V2_STATEMENTS, MIGRATION_V3_STATEMENTS];
  for (const statements of migrations.slice(0, version)) {
    for (const sql of statements) db.exec(sql);
  }
  db.exec(`PRAGMA user_version = ${version}`);
  return db;
}

function insertRunGraph(db, host = 'host-a', run = 'run-1', dispatch = 'dispatch-1') {
  db.prepare('INSERT INTO orca_runs VALUES (?, ?, ?, ?)')
    .run(host, run, '2026-10-24T00:00:00Z', '1.4.241');
  db.prepare('INSERT INTO orca_tasks (host_id, run_id, task_id) VALUES (?, ?, ?)')
    .run(host, run, 'task-1');
  db.prepare('INSERT INTO orca_dispatches (host_id, run_id, task_id, dispatch_id) VALUES (?, ?, ?, ?)')
    .run(host, run, 'task-1', dispatch);
}

function insertSession(db, key) {
  db.prepare('INSERT INTO usage_sessions VALUES (?, ?, ?, ?)')
    .run(key, 'codex', 'agent-top', key.slice('codex:agent-top:'.length));
}

function insertRole(db, key, role, host, run, dispatch) {
  insertManualRoleLink(db, {
    sessionKey: key, role, hostId: host, runId: run, dispatchId: dispatch,
    linkedAt: '2026-10-24T00:00:00Z', verifier: 'operator',
  });
}

test('V14 DB: fresh and v1/v2/v3 databases migrate to v6 and reopen idempotently', () => {
  for (const startVersion of [0, 1, 2, 3]) {
    withPath((path) => {
      if (startVersion) {
        const old = seedVersion(path, startVersion);
        old.prepare(`INSERT INTO issues
          (issue_node_id, repository_name_with_owner, number, url, title, state)
          VALUES ('I1', 'o/r', 1, 'https://github.com/o/r/issues/1', 'Issue', 'OPEN')`).run();
        // Pre-v4 schemas only accept CodeBurn session identity; v4 (ADR 0001) drops them.
        old.prepare(`INSERT INTO usage_sessions VALUES
          ('codex:codeburn:s1', 'codex', 'codeburn', 's1')`).run();
        old.prepare(`INSERT INTO session_links VALUES
          ('codex:codeburn:s1', 'I1', 'manual', '2026-01-01', 'tester')`).run();
        old.prepare(`INSERT INTO executions VALUES
          ('orca:host-a:worktree', 'host-a', 'worktree', NULL, NULL, NULL),
          ('orca:host-a:dispatch-1', 'host-a', 'dispatch-1', 'run-1', 'task-1', 'dispatch-1')`).run();
        old.close();
      }
      const first = openTelemetryDatabase({ dbPath: path });
      assert.equal(first.db.prepare('PRAGMA user_version').get().user_version, 6);
      assert.equal(first.db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
      if (startVersion) {
        assert.equal(first.db.prepare('SELECT COUNT(*) AS n FROM session_links').get().n, 0);
        assert.equal(first.db.prepare('SELECT COUNT(*) AS n FROM usage_sessions').get().n, 0);
        assert.equal(first.db.prepare('SELECT COUNT(*) AS n FROM issues').get().n, 1);
        assert.deepEqual(first.db.prepare('SELECT execution_scope FROM execution_scopes ORDER BY execution_key')
          .all().map((row) => row.execution_scope), ['legacy_unscoped', 'manual']);
        assert.equal(first.db.prepare('SELECT COUNT(*) AS n FROM scoped_executions').get().n, 0);
      }
      first.close();
      const second = openTelemetryDatabase({ dbPath: path });
      assert.equal(second.db.prepare('PRAGMA user_version').get().user_version, 6);
      if (startVersion) assert.equal(second.db.prepare('SELECT COUNT(*) AS n FROM executions').get().n, 2);
      second.close();
    });
  }
});

test('V14 DB: host + run + dispatch is the namespace; same raw dispatch can exist in two runs', () => {
  withPath((path) => {
    const handle = openTelemetryDatabase({ dbPath: path });
    const db = handle.db;
    insertRunGraph(db, 'host-a', 'run-1', 'same-dispatch');
    insertRunGraph(db, 'host-a', 'run-2', 'same-dispatch');
    insertRunGraph(db, 'host-b', 'run-1', 'same-dispatch');
    const tuples = [
      ['host-a', 'run-1', scopedExecutionKey('host-a', 'run-1', 'same-dispatch')],
      ['host-a', 'run-2', scopedExecutionKey('host-a', 'run-2', 'same-dispatch')],
      ['host-b', 'run-1', scopedExecutionKey('host-b', 'run-1', 'same-dispatch')],
    ];
    for (const [host, run, key] of tuples) {
      db.prepare(`INSERT INTO scoped_executions
        (execution_key, host_id, run_id, task_id, dispatch_id, raw_id)
        VALUES (?, ?, ?, 'task-1', 'same-dispatch', 'same-dispatch')`).run(key, host, run);
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM scoped_executions').get().n, 3);
    assert.throws(() => insertScopedExecution(db, {
      hostId: 'host-a', runId: 'run-1', taskId: 'task-1', dispatchId: 'same-dispatch',
    }));
    handle.close();
  });
});

test('V14 DB: composite foreign keys and role/null checks reject mismatched identity', () => {
  withPath((path) => {
    const handle = openTelemetryDatabase({ dbPath: path });
    const db = handle.db;
    insertRunGraph(db);
    insertRunGraph(db, 'host-b', 'run-1', 'dispatch-2');
    insertSession(db, 'codex:agent-top:s1');
    insertSession(db, 'codex:agent-top:s2');
    assert.throws(() => db.prepare(`INSERT INTO orca_tasks
      (host_id, run_id, task_id) VALUES ('host-c', 'run-1', 'task-1')`).run());
    assert.throws(() => db.prepare(`INSERT INTO orca_dispatches
      (host_id, run_id, task_id, dispatch_id)
      VALUES ('host-a', 'run-1', 'missing-task', 'd')`).run());
    assert.throws(() => insertScopedExecution(db, {
      hostId: 'host-a', runId: 'run-1', taskId: 'task-1', dispatchId: 'dispatch-2',
    }));
    assert.throws(() => insertRole(db, 'codex:agent-top:s1', 'worker', 'host-a', 'run-1', null));
    assert.throws(() => insertRole(db, 'codex:agent-top:s1', 'coordinator', 'host-a', 'run-1', 'dispatch-1'));
    assert.throws(() => insertRole(db, 'codex:agent-top:s1', 'worker', 'host-a', 'run-1', 'dispatch-2'));
    assert.throws(() => insertRole(db, 'codex:agent-top:missing', 'coordinator', 'host-a', 'run-1', null));
    insertRole(db, 'codex:agent-top:s1', 'coordinator', 'host-a', 'run-1', null);
    insertRole(db, 'codex:agent-top:s2', 'worker', 'host-a', 'run-1', 'dispatch-1');
    assert.throws(() => insertRole(db, 'codex:agent-top:s1', 'worker', 'host-a', 'run-1', 'dispatch-1'));
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
    handle.close();
  });
});

test('V14 DB: old and scoped execution keys/candidates cannot collide in either direction', () => {
  withPath((path) => {
    const handle = openTelemetryDatabase({ dbPath: path });
    const db = handle.db;
    insertRunGraph(db);
    const key = scopedExecutionKey('host-a', 'run-1', 'dispatch-1');
    db.prepare(`INSERT INTO executions VALUES (?, 'host-a', 'manual', NULL, NULL, NULL)`).run(key);
    assert.throws(() => db.prepare(`INSERT INTO scoped_executions
      (execution_key, host_id, run_id, task_id, dispatch_id, raw_id)
      VALUES (?, 'host-a', 'run-1', 'task-1', 'dispatch-1', 'dispatch-1')`).run(key));
    db.prepare('DELETE FROM executions WHERE execution_key = ?').run(key);
    db.prepare(`INSERT INTO executions VALUES
      ('orca:host-a:dispatch-1', 'host-a', 'dispatch-1', 'run-1', 'task-1', 'dispatch-1')`).run();
    assert.throws(() => insertScopedExecution(db, {
      hostId: 'host-a', runId: 'run-1', taskId: 'task-1', dispatchId: 'dispatch-1',
    }));
    db.prepare("DELETE FROM executions WHERE dispatch_id = 'dispatch-1'").run();
    insertScopedExecution(db, {
      hostId: 'host-a', runId: 'run-1', taskId: 'task-1', dispatchId: 'dispatch-1',
    });
    assert.throws(() => db.prepare(`INSERT INTO executions VALUES
      (?, 'host-z', 'manual', NULL, NULL, NULL)`).run(key));
    assert.throws(() => db.prepare(`INSERT INTO executions VALUES
      ('orca:host-a:dispatch-1', 'host-a', 'dispatch-1', 'run-1', 'task-1', 'dispatch-1')`).run());
    db.prepare(`INSERT INTO executions VALUES
      ('orca:host-a:other', 'host-a', 'other', NULL, NULL, NULL)`).run();
    assert.throws(() => db.prepare(`UPDATE executions
      SET execution_key = ?
      WHERE execution_key = 'orca:host-a:other'`).run(key));
    assert.throws(() => db.prepare(`UPDATE executions
      SET dispatch_id = 'dispatch-1'
      WHERE execution_key = 'orca:host-a:other'`).run());
    assert.throws(() => db.prepare(`UPDATE scoped_executions
      SET execution_key = 'orca:supervised:v2:crafted'
      WHERE execution_key = ?`).run(key));
    handle.close();
  });
});

test('V14 DB: invalid provenance foreign key aborts migration without changing v5 data', () => {
  withPath((path) => {
    const raw = new DatabaseSync(path);
    for (const sql of [
      ...MIGRATION_V1_STATEMENTS,
      ...MIGRATION_V2_STATEMENTS,
      ...MIGRATION_V3_STATEMENTS,
      ...MIGRATION_V4_STATEMENTS,
      ...MIGRATION_V5_STATEMENTS,
    ]) {
      raw.exec(sql);
    }
    raw.exec('PRAGMA user_version = 5');
    raw.exec('PRAGMA foreign_keys = OFF');
    raw.prepare(`INSERT INTO orca_runs VALUES ('host-a', 'run-1', '2026-10-24T00:00:00Z', '1.4.241')`).run();
    raw.prepare(`INSERT INTO usage_sessions VALUES
      ('codex:agent-top:s1', 'codex', 'agent-top', 's1')`).run();
    const linkedBy = `sha256:${'a'.repeat(64)}`;
    raw.prepare(`INSERT INTO session_role_links
      (session_key, role, host_id, run_id, dispatch_id, method, linked_at, linked_by,
       evidence_kind, evidence_note, verification)
      VALUES ('codex:agent-top:s1', 'coordinator', 'host-a', 'run-missing', NULL, 'manual',
        '2026-10-24T00:00:00Z', ?, 'bounded_manual',
        'ids_visible_same_session', 'manual_limited')`).run(linkedBy);
    assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 5);
    raw.close();
    assert.throws(() => openTelemetryDatabase({ dbPath: path }), /foreign key/i);
    const after = new DatabaseSync(path);
    assert.equal(after.prepare('PRAGMA user_version').get().user_version, 5);
    assert.equal(after.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'session_role_link_audit'").get().n, 0);
    after.close();
  });
});

test('V14 DB: attempt scopes and audit mapping reject invalid rows', () => {
  withPath((path) => {
    const handle = openTelemetryDatabase({ dbPath: path });
    const db = handle.db;
    insertRunGraph(db);
    const key = insertScopedExecution(db, {
      hostId: 'host-a', runId: 'run-1', taskId: 'task-1', dispatchId: 'dispatch-1',
    });
    db.prepare(`INSERT INTO legacy_execution_rekeys VALUES
      ('orca:host-a:dispatch-1', ?, 'host-a', 'run-1',
        'dispatch-1', '2026-10-24T00:00:00Z', ?, 'bounded_manual')`)
      .run(key, verifierIdentityHash('operator'));
    assert.throws(() => db.prepare(`UPDATE legacy_execution_rekeys
      SET verified_by = 'terminal preview'`).run());
    assert.throws(() => db.prepare(`UPDATE legacy_execution_rekeys
      SET evidence_kind = 'cross_source_verified'`).run());
    assert.throws(() => db.prepare(`INSERT INTO executions VALUES
      ('orca:host-a:dispatch-1', 'host-z', 'manual', NULL, NULL, NULL)`).run());
    assert.throws(() => db.prepare(`INSERT INTO legacy_execution_rekeys VALUES
      ('other', ?, 'host-b', 'run-1',
        'dispatch-1', '2026-10-24T00:00:00Z', ?, 'bounded_manual')`)
      .run(key, verifierIdentityHash('operator')));
    db.prepare(`INSERT INTO collection_attempts
      (source, host_id, run_id, started_at, status)
      VALUES ('orca', 'host-a', 'run-1', '2026-10-24T00:00:00Z', 'running')`).run();
    assert.throws(() => db.prepare(`INSERT INTO collection_attempts
      (source, provider, started_at, status)
      VALUES ('orca', 'codex', '2026-10-24T00:00:00Z', 'running')`).run());
    assert.throws(() => db.prepare(`INSERT INTO collection_attempts
      (source, provider, started_at, completed_at, status)
      VALUES ('agent-top', 'codex', '2026-10-24T00:00:00Z', NULL, 'success')`).run());
    handle.close();
  });
});

test('V14 DB F01: canonical key is reversible and bound to the exact tuple after reopen', () => {
  const tuple = ['host:%', 'run:a%b', 'dispatch:%:'];
  const alternate = ['host', '%run:a%b', 'dispatch:%:'];
  const key = scopedExecutionKey(...tuple);
  assert.deepEqual(key.split(':').slice(3).map((part) => Buffer.from(part, 'hex').toString('utf8')), tuple);
  assert.notEqual(key, scopedExecutionKey(...alternate));
  assert.throws(() => scopedExecutionKey('', 'run', 'dispatch'));
  assert.throws(() => scopedExecutionKey('host', 'run', ''));
  assert.throws(() => scopedExecutionKey('host', 'run', '\ud800'));
  withPath((path) => {
    let handle = openTelemetryDatabase({ dbPath: path });
    let db = handle.db;
    insertRunGraph(db, ...tuple);
    insertRunGraph(db, ...alternate);
    assert.throws(() => db.prepare(`INSERT INTO scoped_executions
      (execution_key, host_id, run_id, task_id, dispatch_id, raw_id)
      VALUES (?, ?, ?, 'task-1', ?, ?)`).run('orca:supervised:v2:valid', ...tuple, tuple[2]));
    assert.throws(() => db.prepare(`INSERT INTO scoped_executions
      (execution_key, host_id, run_id, task_id, dispatch_id, raw_id)
      VALUES (?, ?, ?, 'task-1', ?, ?)`).run(key, ...alternate, alternate[2]));
    assert.equal(insertScopedExecution(db, {
      hostId: tuple[0], runId: tuple[1], taskId: 'task-1', dispatchId: tuple[2],
    }), key);
    assert.throws(() => db.prepare(`UPDATE scoped_executions SET execution_key = ?
      WHERE execution_key = ?`).run(scopedExecutionKey(...alternate), key));
    assert.throws(() => db.prepare(`UPDATE scoped_executions SET run_id = ?
      WHERE execution_key = ?`).run(alternate[1], key));
    assert.throws(() => db.prepare(`INSERT INTO executions VALUES
      (?, 'host-z', 'manual', NULL, NULL, NULL)`).run(key));
    handle.close();
    handle = openTelemetryDatabase({ dbPath: path });
    db = handle.db;
    assert.equal(db.prepare('SELECT execution_key FROM scoped_executions').get().execution_key, key);
    assert.throws(() => insertScopedExecution(db, {
      hostId: tuple[0], runId: tuple[1], taskId: 'task-1', dispatchId: tuple[2],
    }));
    handle.close();
  });
});

test('V14 DB F02: manual evidence and journal reject sensitive and unbounded values', () => {
  withPath((path) => {
    let handle = openTelemetryDatabase({ dbPath: path });
    let db = handle.db;
    insertRunGraph(db);
    insertSession(db, 'codex:agent-top:s1');
    assert.throws(() => insertManualRoleLink(db, {
      sessionKey: 'codex:agent-top:s1', role: 'coordinator', hostId: 'host-a', runId: 'run-1',
      linkedAt: '2026-10-24T00:00:00Z', verifier: 'operator',
      evidenceNote: 'prompt: secret token',
    }));
    assert.throws(() => db.prepare(`INSERT INTO session_role_links
      (session_key, role, host_id, run_id, method, evidence_kind, verification,
       linked_at, linked_by, evidence_note)
      VALUES ('codex:agent-top:s1', 'coordinator', 'host-a', 'run-1', 'manual',
       'transcript_verified', 'verified', '2026-10-24T00:00:00Z', ?, 'terminal preview')`)
      .run(verifierIdentityHash('operator')));
    insertRole(db, 'codex:agent-top:s1', 'coordinator', 'host-a', 'run-1', null);
    const role = db.prepare('SELECT * FROM session_role_links').get();
    assert.equal(role.evidence_kind, 'bounded_manual');
    assert.equal(role.verification, 'manual_limited');
    assert.equal(role.linked_by, verifierIdentityHash('operator'));
    assert.equal(role.evidence_note, null);
    assert.throws(() => db.prepare(`UPDATE session_role_links
      SET evidence_note = ?`).run('x'.repeat(513)));
    assert.throws(() => db.prepare(`UPDATE session_role_links
      SET verification = 'verified'`).run());
    assert.throws(() => db.prepare(`UPDATE session_role_links
      SET linked_by = 'Authorization: Bearer secret'`).run());
    assert.throws(() => insertCollectionAttempt(db, {
      source: 'orca', hostId: 'host-a', runId: 'run-1',
      startedAt: '2026-10-24T00:00:00Z', status: 'running',
      errorCode: 'prompt: secret',
    }));
    for (const counters of [{ prompt: 'secret' }, { sessions: 100001 }, { sessions: -1 }]) {
      assert.throws(() => insertCollectionAttempt(db, {
        source: 'orca', hostId: 'host-a', runId: 'run-1',
        startedAt: '2026-10-24T00:00:00Z', status: 'running', counters,
      }));
    }
    const rawAttempt = db.prepare(`INSERT INTO collection_attempts
      (source, host_id, run_id, started_at, status, error_code, counters_json)
      VALUES ('orca', 'host-a', 'run-1', '2026-10-24T00:00:00Z', 'running', ?, ?)`);
    for (const payload of ['{"prompt":"secret"}', '{"sessions":1,"sessions":2}',
      '{"sessions":"1"}', '{"sessions":100001}', '{"sessions":1,"preview":0}',
      JSON.stringify({ sessions: 1, transcript: 'x'.repeat(513) }),
      `{${' '.repeat(513)}}`, '{invalid']) {
      assert.throws(() => rawAttempt.run('source_error', payload));
    }
    assert.throws(() => rawAttempt.run('Authorization: Bearer secret', '{"sessions":1}'));
    insertCollectionAttempt(db, {
      source: 'orca', hostId: 'host-a', runId: 'run-1',
      startedAt: '2026-10-24T00:00:00Z', status: 'running', counters: { sessions: 1 },
    });
    assert.throws(() => db.prepare(`UPDATE collection_attempts
      SET counters_json = '{"credential":"secret"}'`).run());
    handle.close();
    handle = openTelemetryDatabase({ dbPath: path });
    assert.deepEqual(handle.db.prepare('SELECT counters_json FROM collection_attempts').all()
      .map((row) => row.counters_json), ['{"sessions":1}']);
    assert.equal(handle.db.prepare('SELECT linked_by FROM session_role_links').get().linked_by,
      verifierIdentityHash('operator'));
    handle.close();
  });
});

test('V14 DB: reopen refuses a draft v5 missing privacy constraints', () => {
  withPath((path) => {
    const handle = openTelemetryDatabase({ dbPath: path });
    handle.db.exec('DROP TRIGGER collection_attempts_counters_update');
    handle.close();
    assert.throws(() => openTelemetryDatabase({ dbPath: path }),
      /provenance constraints are missing or outdated/);
    const raw = new DatabaseSync(path);
    assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 6);
    raw.close();
  });
});

test('V14 DB F03: reopen refuses a v6 database missing the audit table', () => {
  withPath((path) => {
    const handle = openTelemetryDatabase({ dbPath: path });
    handle.db.exec('DROP TABLE session_role_link_audit');
    handle.close();
    assert.throws(() => openTelemetryDatabase({ dbPath: path }),
      /session_role_link_audit schema is missing or outdated/);
    const raw = new DatabaseSync(path);
    assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 6);
    raw.close();
  });
});

test('V14 DB F03: reopen refuses a v6 audit table missing its role/dispatch constraint', () => {
  withPath((path) => {
    const handle = openTelemetryDatabase({ dbPath: path });
    handle.db.exec('DROP TABLE session_role_link_audit');
    handle.db.exec(`CREATE TABLE session_role_link_audit (
      audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_key TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('coordinator', 'worker')),
      host_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      dispatch_id TEXT,
      linked_at TEXT NOT NULL,
      linked_by TEXT NOT NULL CHECK (length(linked_by) = 71
        AND substr(linked_by, 1, 7) = 'sha256:'
        AND substr(linked_by, 8) NOT GLOB '*[^0-9a-f]*'),
      unlinked_at TEXT NOT NULL,
      unlinked_by TEXT NOT NULL CHECK (length(unlinked_by) = 71
        AND substr(unlinked_by, 1, 7) = 'sha256:'
        AND substr(unlinked_by, 8) NOT GLOB '*[^0-9a-f]*')
    )`);
    handle.close();
    assert.throws(() => openTelemetryDatabase({ dbPath: path }),
      /session_role_link_audit schema is missing or outdated/);
    const raw = new DatabaseSync(path);
    assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 6);
    raw.close();
  });
});

test('V14 DB F03: writable and read-only reopen refuse a v6 audit table with both sha256-prefix and hex-suffix CHECKs removed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-v14-db-'));
  const path = join(dir, 'telemetry.sqlite');
  try {
    const handle = openTelemetryDatabase({ dbPath: path });
    handle.db.exec('DROP TABLE session_role_link_audit');
    handle.db.exec(`CREATE TABLE session_role_link_audit (
      audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_key TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('coordinator', 'worker')),
      host_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      dispatch_id TEXT,
      linked_at TEXT NOT NULL,
      linked_by TEXT NOT NULL CHECK (length(linked_by) = 71),
      unlinked_at TEXT NOT NULL,
      unlinked_by TEXT NOT NULL CHECK (length(unlinked_by) = 71),
      CHECK (
        (role = 'coordinator' AND dispatch_id IS NULL)
        OR (role = 'worker' AND dispatch_id IS NOT NULL)
      )
    )`);
    handle.close();
    assert.throws(() => openTelemetryDatabase({ dbPath: path }),
      (err) => err.code === 'db_schema_drift'
        && /session_role_link_audit schema is missing or outdated/.test(err.message));
    await assert.rejects(
      () => openReadOnlyTelemetryDb(path),
      (err) => err.code === 'db_schema_drift',
    );
    const raw = new DatabaseSync(path);
    assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 6);
    raw.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('V14 DB F03: writable and read-only reopen refuse a v6 audit table missing only the hex-suffix CHECK on linked_by', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-v14-db-'));
  const path = join(dir, 'telemetry.sqlite');
  try {
    const handle = openTelemetryDatabase({ dbPath: path });
    handle.db.exec('DROP TABLE session_role_link_audit');
    handle.db.exec(`CREATE TABLE session_role_link_audit (
      audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_key TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('coordinator', 'worker')),
      host_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      dispatch_id TEXT,
      linked_at TEXT NOT NULL,
      linked_by TEXT NOT NULL CHECK (length(linked_by) = 71
        AND substr(linked_by, 1, 7) = 'sha256:'),
      unlinked_at TEXT NOT NULL,
      unlinked_by TEXT NOT NULL CHECK (length(unlinked_by) = 71
        AND substr(unlinked_by, 1, 7) = 'sha256:'
        AND substr(unlinked_by, 8) NOT GLOB '*[^0-9a-f]*'),
      CHECK (
        (role = 'coordinator' AND dispatch_id IS NULL)
        OR (role = 'worker' AND dispatch_id IS NOT NULL)
      )
    )`);
    handle.close();
    assert.throws(() => openTelemetryDatabase({ dbPath: path }),
      (err) => err.code === 'db_schema_drift'
        && /session_role_link_audit schema is missing or outdated/.test(err.message));
    await assert.rejects(
      () => openReadOnlyTelemetryDb(path),
      (err) => err.code === 'db_schema_drift',
    );
    const raw = new DatabaseSync(path);
    assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 6);
    raw.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('V14 DB: migrating a draft v5 (missing privacy constraints) to v6 rolls back without bumping the version', () => {
  withPath((path) => {
    const draft = new DatabaseSync(path);
    draft.exec('PRAGMA foreign_keys = ON');
    for (const sql of [...MIGRATION_V1_STATEMENTS, ...MIGRATION_V2_STATEMENTS,
      ...MIGRATION_V3_STATEMENTS, ...MIGRATION_V4_STATEMENTS, ...MIGRATION_V5_STATEMENTS]) {
      draft.exec(sql);
    }
    draft.exec('DROP TRIGGER collection_attempts_counters_update');
    draft.exec('PRAGMA user_version = 5');
    draft.close();

    assert.throws(() => openTelemetryDatabase({ dbPath: path }),
      /provenance constraints are missing or outdated/);
    const raw = new DatabaseSync(path);
    assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 5);
    assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'session_role_link_audit'").get().n, 0);
    raw.close();
  });
});
