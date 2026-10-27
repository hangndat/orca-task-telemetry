/** Schema version 7 — allow agent-top `cursor` usage provider (ADR 0001 addendum). */
export const SCHEMA_VERSION_V7 = 7;

/**
 * Rebuilds CHECK constraints that previously allowed only claude|codex.
 * Data is preserved; no CodeBurn / identity rewrite.
 */
export const MIGRATION_V7_STATEMENTS: readonly string[] = [
  `PRAGMA foreign_keys = OFF`,
  `CREATE TABLE usage_sessions_v7 (
    session_key TEXT PRIMARY KEY NOT NULL,
    provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex', 'cursor')),
    source TEXT NOT NULL CHECK (source = 'agent-top'),
    raw_id TEXT NOT NULL,
    CHECK (
      (provider = 'claude' AND session_key GLOB 'claude:agent-top:*')
      OR (provider = 'codex' AND session_key GLOB 'codex:agent-top:*')
      OR (provider = 'cursor' AND session_key GLOB 'cursor:agent-top:*')
    )
  )`,
  `INSERT INTO usage_sessions_v7 SELECT * FROM usage_sessions`,
  `DROP TABLE usage_sessions`,
  `ALTER TABLE usage_sessions_v7 RENAME TO usage_sessions`,
  `DROP TRIGGER IF EXISTS collection_attempts_counters_insert`,
  `DROP TRIGGER IF EXISTS collection_attempts_counters_update`,
  `DROP INDEX IF EXISTS collection_attempts_orca_idx`,
  `DROP INDEX IF EXISTS collection_attempts_agent_top_idx`,
  `CREATE TABLE collection_attempts_v7 (
    attempt_id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL CHECK (source IN ('orca', 'agent-top')),
    host_id TEXT,
    run_id TEXT,
    provider TEXT CHECK (provider IS NULL OR provider IN ('claude', 'codex', 'cursor')),
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
  `INSERT INTO collection_attempts_v7
    (attempt_id, source, host_id, run_id, provider, started_at, completed_at,
     status, error_code, counters_json)
   SELECT attempt_id, source, host_id, run_id, provider, started_at, completed_at,
     status, error_code, counters_json FROM collection_attempts`,
  `DROP TABLE collection_attempts`,
  `ALTER TABLE collection_attempts_v7 RENAME TO collection_attempts`,
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
  `PRAGMA foreign_keys = ON`,
];
