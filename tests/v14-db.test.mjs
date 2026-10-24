import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'vitest';
import { openTelemetryDatabase } from '../dist/db/index.js';
import { MIGRATION_V1_STATEMENTS } from '../dist/db/migrations/v1.js';
import { MIGRATION_V2_STATEMENTS } from '../dist/db/migrations/v2.js';
import { MIGRATION_V3_STATEMENTS } from '../dist/db/migrations/v3.js';

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
    .run(host, run, '2026-10-24T00:00:00Z', '1.4.237');
  db.prepare('INSERT INTO orca_tasks (host_id, run_id, task_id) VALUES (?, ?, ?)')
    .run(host, run, 'task-1');
  db.prepare('INSERT INTO orca_dispatches (host_id, run_id, task_id, dispatch_id) VALUES (?, ?, ?, ?)')
    .run(host, run, 'task-1', dispatch);
}

function insertSession(db, key) {
  db.prepare('INSERT INTO usage_sessions VALUES (?, ?, ?, ?)')
    .run(key, 'codex', 'codeburn', key.slice('codex:codeburn:'.length));
}

function insertRole(db, key, role, host, run, dispatch) {
  db.prepare(`INSERT INTO session_role_links
    (session_key, role, host_id, run_id, dispatch_id, method,
      evidence_kind, verification, linked_at, linked_by)
    VALUES (?, ?, ?, ?, ?, 'manual', 'bounded_manual', 'manual_limited',
      '2026-10-24T00:00:00Z', 'operator')`)
    .run(key, role, host, run, dispatch);
}

test('V14 DB: fresh and v1/v2/v3 databases migrate to v4 and reopen idempotently', () => {
  for (const startVersion of [0, 1, 2, 3]) {
    withPath((path) => {
      if (startVersion) {
        const old = seedVersion(path, startVersion);
        old.prepare(`INSERT INTO issues
          (issue_node_id, repository_name_with_owner, number, url, title, state)
          VALUES ('I1', 'o/r', 1, 'https://github.com/o/r/issues/1', 'Issue', 'OPEN')`).run();
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
      assert.equal(first.db.prepare('PRAGMA user_version').get().user_version, 4);
      assert.equal(first.db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
      if (startVersion) {
        assert.equal(first.db.prepare('SELECT COUNT(*) AS n FROM session_links').get().n, 1);
        assert.deepEqual(first.db.prepare('SELECT execution_scope FROM execution_scopes ORDER BY execution_key')
          .all().map((row) => row.execution_scope), ['legacy_unscoped', 'manual']);
        assert.equal(first.db.prepare('SELECT COUNT(*) AS n FROM scoped_executions').get().n, 0);
      }
      first.close();
      const second = openTelemetryDatabase({ dbPath: path });
      assert.equal(second.db.prepare('PRAGMA user_version').get().user_version, 4);
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
      ['host-a', 'run-1', 'orca:supervised:v2:host-a:run-1:same-dispatch'],
      ['host-a', 'run-2', 'orca:supervised:v2:host-a:run-2:same-dispatch'],
      ['host-b', 'run-1', 'orca:supervised:v2:host-b:run-1:same-dispatch'],
    ];
    for (const [host, run, key] of tuples) {
      db.prepare(`INSERT INTO scoped_executions
        (execution_key, host_id, run_id, task_id, dispatch_id, raw_id)
        VALUES (?, ?, ?, 'task-1', 'same-dispatch', 'same-dispatch')`).run(key, host, run);
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM scoped_executions').get().n, 3);
    assert.throws(() => db.prepare(`INSERT INTO scoped_executions
      (execution_key, host_id, run_id, task_id, dispatch_id, raw_id)
      VALUES ('orca:supervised:v2:duplicate', 'host-a', 'run-1', 'task-1', 'same-dispatch', 'same-dispatch')`).run());
    handle.close();
  });
});

test('V14 DB: composite foreign keys and role/null checks reject mismatched identity', () => {
  withPath((path) => {
    const handle = openTelemetryDatabase({ dbPath: path });
    const db = handle.db;
    insertRunGraph(db);
    insertRunGraph(db, 'host-b', 'run-1', 'dispatch-2');
    insertSession(db, 'codex:codeburn:s1');
    insertSession(db, 'codex:codeburn:s2');
    assert.throws(() => db.prepare(`INSERT INTO orca_tasks
      (host_id, run_id, task_id) VALUES ('host-c', 'run-1', 'task-1')`).run());
    assert.throws(() => db.prepare(`INSERT INTO orca_dispatches
      (host_id, run_id, task_id, dispatch_id)
      VALUES ('host-a', 'run-1', 'missing-task', 'd')`).run());
    assert.throws(() => db.prepare(`INSERT INTO scoped_executions
      (execution_key, host_id, run_id, task_id, dispatch_id, raw_id)
      VALUES ('orca:supervised:v2:wrong', 'host-a', 'run-1', 'task-1', 'dispatch-2', 'dispatch-2')`).run());
    assert.throws(() => insertRole(db, 'codex:codeburn:s1', 'worker', 'host-a', 'run-1', null));
    assert.throws(() => insertRole(db, 'codex:codeburn:s1', 'coordinator', 'host-a', 'run-1', 'dispatch-1'));
    assert.throws(() => insertRole(db, 'codex:codeburn:s1', 'worker', 'host-a', 'run-1', 'dispatch-2'));
    assert.throws(() => insertRole(db, 'codex:codeburn:missing', 'coordinator', 'host-a', 'run-1', null));
    insertRole(db, 'codex:codeburn:s1', 'coordinator', 'host-a', 'run-1', null);
    insertRole(db, 'codex:codeburn:s2', 'worker', 'host-a', 'run-1', 'dispatch-1');
    assert.throws(() => insertRole(db, 'codex:codeburn:s1', 'worker', 'host-a', 'run-1', 'dispatch-1'));
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
    handle.close();
  });
});

test('V14 DB: old and scoped execution keys/candidates cannot collide in either direction', () => {
  withPath((path) => {
    const handle = openTelemetryDatabase({ dbPath: path });
    const db = handle.db;
    insertRunGraph(db);
    db.prepare(`INSERT INTO executions VALUES
      ('orca:supervised:v2:crafted', 'host-a', 'manual', NULL, NULL, NULL)`).run();
    assert.throws(() => db.prepare(`INSERT INTO scoped_executions
      (execution_key, host_id, run_id, task_id, dispatch_id, raw_id)
      VALUES ('orca:supervised:v2:crafted', 'host-a', 'run-1', 'task-1', 'dispatch-1', 'dispatch-1')`).run());
    db.prepare(`INSERT INTO executions VALUES
      ('orca:host-a:dispatch-1', 'host-a', 'dispatch-1', 'run-1', 'task-1', 'dispatch-1')`).run();
    assert.throws(() => db.prepare(`INSERT INTO scoped_executions
      (execution_key, host_id, run_id, task_id, dispatch_id, raw_id)
      VALUES ('orca:supervised:v2:valid', 'host-a', 'run-1', 'task-1', 'dispatch-1', 'dispatch-1')`).run());
    db.prepare("DELETE FROM executions WHERE dispatch_id = 'dispatch-1'").run();
    db.prepare(`INSERT INTO scoped_executions
      (execution_key, host_id, run_id, task_id, dispatch_id, raw_id)
      VALUES ('orca:supervised:v2:valid', 'host-a', 'run-1', 'task-1', 'dispatch-1', 'dispatch-1')`).run();
    assert.throws(() => db.prepare(`INSERT INTO executions VALUES
      ('orca:supervised:v2:valid', 'host-z', 'manual', NULL, NULL, NULL)`).run());
    assert.throws(() => db.prepare(`INSERT INTO executions VALUES
      ('orca:host-a:dispatch-1', 'host-a', 'dispatch-1', 'run-1', 'task-1', 'dispatch-1')`).run());
    db.prepare(`INSERT INTO executions VALUES
      ('orca:host-a:other', 'host-a', 'other', NULL, NULL, NULL)`).run();
    assert.throws(() => db.prepare(`UPDATE executions
      SET execution_key = 'orca:supervised:v2:valid'
      WHERE execution_key = 'orca:host-a:other'`).run());
    assert.throws(() => db.prepare(`UPDATE executions
      SET dispatch_id = 'dispatch-1'
      WHERE execution_key = 'orca:host-a:other'`).run());
    assert.throws(() => db.prepare(`UPDATE scoped_executions
      SET execution_key = 'orca:supervised:v2:crafted'
      WHERE execution_key = 'orca:supervised:v2:valid'`).run());
    handle.close();
  });
});

test('V14 DB: invalid legacy foreign key aborts migration without changing v3 data', () => {
  withPath((path) => {
    const old = seedVersion(path, 3);
    old.exec('PRAGMA foreign_keys = OFF');
    old.prepare(`INSERT INTO session_links VALUES
      ('codex:codeburn:missing', 'I_missing', 'manual', '2026-01-01', 'tester')`).run();
    old.close();
    assert.throws(() => openTelemetryDatabase({ dbPath: path }), /foreign key/i);
    const raw = new DatabaseSync(path);
    assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 3);
    assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM session_links').get().n, 1);
    assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'orca_runs'").get().n, 0);
    raw.close();
  });
});

test('V14 DB: attempt scopes and audit mapping reject invalid rows', () => {
  withPath((path) => {
    const handle = openTelemetryDatabase({ dbPath: path });
    const db = handle.db;
    insertRunGraph(db);
    db.prepare(`INSERT INTO scoped_executions
      (execution_key, host_id, run_id, task_id, dispatch_id, raw_id)
      VALUES ('orca:supervised:v2:key', 'host-a', 'run-1', 'task-1', 'dispatch-1', 'dispatch-1')`).run();
    db.prepare(`INSERT INTO legacy_execution_rekeys VALUES
      ('orca:host-a:dispatch-1', 'orca:supervised:v2:key', 'host-a', 'run-1',
        'dispatch-1', '2026-10-24T00:00:00Z', 'operator', 'bounded_manual')`).run();
    assert.throws(() => db.prepare(`INSERT INTO executions VALUES
      ('orca:host-a:dispatch-1', 'host-z', 'manual', NULL, NULL, NULL)`).run());
    assert.throws(() => db.prepare(`INSERT INTO legacy_execution_rekeys VALUES
      ('other', 'orca:supervised:v2:key', 'host-b', 'run-1',
        'dispatch-1', '2026-10-24T00:00:00Z', 'operator', 'bounded_manual')`).run());
    db.prepare(`INSERT INTO collection_attempts
      (source, host_id, run_id, started_at, status)
      VALUES ('orca', 'host-a', 'run-1', '2026-10-24T00:00:00Z', 'running')`).run();
    assert.throws(() => db.prepare(`INSERT INTO collection_attempts
      (source, provider, started_at, status)
      VALUES ('orca', 'codex', '2026-10-24T00:00:00Z', 'running')`).run());
    assert.throws(() => db.prepare(`INSERT INTO collection_attempts
      (source, provider, started_at, completed_at, status)
      VALUES ('codeburn', 'codex', '2026-10-24T00:00:00Z', NULL, 'success')`).run());
    handle.close();
  });
});
