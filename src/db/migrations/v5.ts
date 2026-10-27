/** Schema version 5 — verified Orca Run provenance and manual session roles. */
export const SCHEMA_VERSION_V5 = 5;

/**
 * Existing `executions` rows cannot acquire a trusted Run identity in a schema
 * migration. Keep that table intact; only rows explicitly inserted into
 * `scoped_executions` can participate in Run-scoped reporting.
 */
export const MIGRATION_V5_STATEMENTS: readonly string[] = [
  `CREATE TABLE orca_runs (
    host_id TEXT NOT NULL CHECK (length(host_id) > 0),
    run_id TEXT NOT NULL CHECK (length(run_id) > 0),
    observed_at TEXT NOT NULL,
    source_version TEXT NOT NULL,
    PRIMARY KEY (host_id, run_id)
  )`,
  `CREATE TABLE orca_tasks (
    host_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    task_id TEXT NOT NULL CHECK (length(task_id) > 0),
    parent_task_id TEXT,
    PRIMARY KEY (host_id, run_id, task_id),
    FOREIGN KEY (host_id, run_id) REFERENCES orca_runs(host_id, run_id)
  )`,
  `CREATE TABLE orca_dispatches (
    host_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    dispatch_id TEXT NOT NULL CHECK (length(dispatch_id) > 0),
    creator_orca_session_id TEXT,
    creator_dispatch_id TEXT,
    retry_of_dispatch_id TEXT,
    assignee_orca_session_id TEXT,
    depth INTEGER CHECK (depth IS NULL OR depth >= 0),
    PRIMARY KEY (host_id, run_id, dispatch_id),
    UNIQUE (host_id, run_id, task_id, dispatch_id),
    FOREIGN KEY (host_id, run_id, task_id)
      REFERENCES orca_tasks(host_id, run_id, task_id)
  )`,
  `CREATE TABLE scoped_executions (
    execution_key TEXT PRIMARY KEY NOT NULL
      CHECK (execution_key = 'orca:supervised:v2:' || hex(host_id)
        || ':' || hex(run_id) || ':' || hex(dispatch_id)),
    host_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    dispatch_id TEXT NOT NULL,
    raw_id TEXT NOT NULL CHECK (raw_id = dispatch_id),
    execution_scope TEXT NOT NULL DEFAULT 'scoped_supervised'
      CHECK (execution_scope = 'scoped_supervised'),
    UNIQUE (host_id, run_id, dispatch_id),
    UNIQUE (execution_key, host_id, run_id, dispatch_id),
    FOREIGN KEY (host_id, run_id, task_id, dispatch_id)
      REFERENCES orca_dispatches(host_id, run_id, task_id, dispatch_id)
  )`,
  `CREATE TABLE session_role_links (
    session_key TEXT PRIMARY KEY NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('coordinator', 'worker')),
    host_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    dispatch_id TEXT,
    method TEXT NOT NULL CHECK (method = 'manual'),
    evidence_kind TEXT NOT NULL CHECK (evidence_kind = 'bounded_manual'),
    verification TEXT NOT NULL CHECK (verification = 'manual_limited'),
    linked_at TEXT NOT NULL,
    linked_by TEXT NOT NULL CHECK (length(linked_by) = 71
      AND substr(linked_by, 1, 7) = 'sha256:'
      AND substr(linked_by, 8) NOT GLOB '*[^0-9a-f]*'),
    evidence_note TEXT CHECK (evidence_note IS NULL OR evidence_note IN
      ('ids_visible_same_session', 'operator_observed_same_session')),
    CHECK (
      (role = 'coordinator' AND dispatch_id IS NULL)
      OR (role = 'worker' AND dispatch_id IS NOT NULL)
    ),
    FOREIGN KEY (session_key) REFERENCES usage_sessions(session_key),
    FOREIGN KEY (host_id, run_id) REFERENCES orca_runs(host_id, run_id),
    FOREIGN KEY (host_id, run_id, dispatch_id)
      REFERENCES orca_dispatches(host_id, run_id, dispatch_id)
  )`,
  `CREATE INDEX session_role_links_run_idx
    ON session_role_links(host_id, run_id, role, dispatch_id)`,
  `CREATE TABLE legacy_execution_rekeys (
    legacy_execution_key TEXT PRIMARY KEY NOT NULL,
    scoped_execution_key TEXT NOT NULL UNIQUE,
    host_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    dispatch_id TEXT NOT NULL,
    rekeyed_at TEXT NOT NULL,
    verified_by TEXT NOT NULL CHECK (length(verified_by) = 71
      AND substr(verified_by, 1, 7) = 'sha256:'
      AND substr(verified_by, 8) NOT GLOB '*[^0-9a-f]*'),
    evidence_kind TEXT NOT NULL CHECK (evidence_kind = 'bounded_manual'),
    CHECK (legacy_execution_key <> scoped_execution_key),
    FOREIGN KEY (scoped_execution_key, host_id, run_id, dispatch_id)
      REFERENCES scoped_executions(execution_key, host_id, run_id, dispatch_id)
  )`,
  `CREATE TABLE collection_attempts (
    attempt_id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL CHECK (source IN ('orca', 'agent-top')),
    host_id TEXT,
    run_id TEXT,
    provider TEXT CHECK (provider IS NULL OR provider IN ('claude', 'codex')),
    started_at TEXT NOT NULL,
    completed_at TEXT,
    status TEXT NOT NULL CHECK (status IN ('running', 'success', 'failed', 'partial')),
    error_code TEXT CHECK (error_code IS NULL OR error_code IN
      ('source_unavailable', 'source_invalid_json', 'source_version_unsupported',
       'source_error', 'collection_limit', 'storage_error')),
    counters_json TEXT CHECK (counters_json IS NULL OR
      (length(counters_json) <= 512 AND json_valid(counters_json)
        AND json_type(counters_json) = 'object')),
    CHECK (
      (source = 'orca' AND host_id IS NOT NULL AND length(host_id) > 0
        AND run_id IS NOT NULL AND length(run_id) > 0 AND provider IS NULL)
      OR (source = 'agent-top' AND host_id IS NULL AND run_id IS NULL
        AND provider IS NOT NULL)
    ),
    CHECK ((status = 'running' AND completed_at IS NULL)
      OR (status <> 'running' AND completed_at IS NOT NULL))
  )`,
  `CREATE INDEX collection_attempts_orca_idx
    ON collection_attempts(host_id, run_id, attempt_id DESC)
    WHERE source = 'orca'`,
  `CREATE INDEX collection_attempts_agent_top_idx
    ON collection_attempts(provider, attempt_id DESC)
    WHERE source = 'agent-top'`,
  `CREATE TRIGGER collection_attempts_counters_insert
    BEFORE INSERT ON collection_attempts
    WHEN NEW.counters_json IS NOT NULL AND CASE
      WHEN json_valid(NEW.counters_json) THEN
        json_type(NEW.counters_json) <> 'object'
        OR (SELECT COUNT(*) FROM json_each(NEW.counters_json)) <>
          (SELECT COUNT(DISTINCT key) FROM json_each(NEW.counters_json))
        OR EXISTS (SELECT 1 FROM json_each(NEW.counters_json)
          WHERE key NOT IN ('runs', 'tasks', 'dispatches', 'workers',
            'pages', 'sessions', 'snapshots')
            OR type <> 'integer' OR value < 0 OR value > 100000)
      ELSE 1 END
    BEGIN SELECT RAISE(ABORT, 'invalid collection counters'); END`,
  `CREATE TRIGGER collection_attempts_counters_update
    BEFORE UPDATE OF counters_json ON collection_attempts
    WHEN NEW.counters_json IS NOT NULL AND CASE
      WHEN json_valid(NEW.counters_json) THEN
        json_type(NEW.counters_json) <> 'object'
        OR (SELECT COUNT(*) FROM json_each(NEW.counters_json)) <>
          (SELECT COUNT(DISTINCT key) FROM json_each(NEW.counters_json))
        OR EXISTS (SELECT 1 FROM json_each(NEW.counters_json)
          WHERE key NOT IN ('runs', 'tasks', 'dispatches', 'workers',
            'pages', 'sessions', 'snapshots')
            OR type <> 'integer' OR value < 0 OR value > 100000)
      ELSE 1 END
    BEGIN SELECT RAISE(ABORT, 'invalid collection counters'); END`,
  `CREATE VIEW execution_scopes AS
    SELECT execution_key, host_id, run_id, task_id, dispatch_id, raw_id,
      CASE WHEN dispatch_id IS NULL THEN 'manual' ELSE 'legacy_unscoped' END
        AS execution_scope
    FROM executions
    UNION ALL
    SELECT execution_key, host_id, run_id, task_id, dispatch_id, raw_id,
      execution_scope
    FROM scoped_executions`,
  `CREATE TRIGGER scoped_executions_no_legacy_collision_insert
    BEFORE INSERT ON scoped_executions
    WHEN EXISTS (
      SELECT 1 FROM executions
      WHERE execution_key = NEW.execution_key
        OR (host_id = NEW.host_id AND dispatch_id = NEW.dispatch_id)
    )
    BEGIN SELECT RAISE(ABORT, 'scoped execution conflicts with legacy execution'); END`,
  `CREATE TRIGGER scoped_executions_no_legacy_collision_update
    BEFORE UPDATE ON scoped_executions
    WHEN EXISTS (
      SELECT 1 FROM executions
      WHERE execution_key = NEW.execution_key
        OR (host_id = NEW.host_id AND dispatch_id = NEW.dispatch_id)
    )
    BEGIN SELECT RAISE(ABORT, 'scoped execution conflicts with legacy execution'); END`,
  `CREATE TRIGGER executions_no_scoped_collision_insert
    BEFORE INSERT ON executions
    WHEN EXISTS (
      SELECT 1 FROM scoped_executions
      WHERE execution_key = NEW.execution_key
        OR (host_id = NEW.host_id AND dispatch_id = NEW.dispatch_id)
    ) OR EXISTS (
      SELECT 1 FROM legacy_execution_rekeys
      WHERE legacy_execution_key = NEW.execution_key
    )
    BEGIN SELECT RAISE(ABORT, 'legacy execution conflicts with scoped execution'); END`,
  `CREATE TRIGGER executions_no_scoped_collision_update
    BEFORE UPDATE ON executions
    WHEN EXISTS (
      SELECT 1 FROM scoped_executions
      WHERE execution_key = NEW.execution_key
        OR (host_id = NEW.host_id AND dispatch_id = NEW.dispatch_id)
    ) OR EXISTS (
      SELECT 1 FROM legacy_execution_rekeys
      WHERE legacy_execution_key = NEW.execution_key
    )
    BEGIN SELECT RAISE(ABORT, 'legacy execution conflicts with scoped execution'); END`,
  `CREATE TRIGGER legacy_execution_rekeys_requires_old_absent
    BEFORE INSERT ON legacy_execution_rekeys
    WHEN EXISTS (
      SELECT 1 FROM executions WHERE execution_key = NEW.legacy_execution_key
    )
    BEGIN SELECT RAISE(ABORT, 'legacy execution must be removed before rekey audit'); END`,
];
