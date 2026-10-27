/** Schema version 4 — agent-top usage source (ADR 0001). Drops CodeBurn session identity. */
export const SCHEMA_VERSION_V4 = 4;

export const MIGRATION_V4_STATEMENTS: readonly string[] = [
  `PRAGMA foreign_keys = OFF`,
  `DELETE FROM session_commit_links`,
  `DELETE FROM session_pull_links`,
  `DELETE FROM session_links`,
  `DELETE FROM usage_snapshots`,
  `DELETE FROM usage_sessions`,
  `DELETE FROM collection_logs WHERE source = 'codeburn'`,
  `CREATE TABLE usage_sessions_v4 (
    session_key TEXT PRIMARY KEY NOT NULL,
    provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex')),
    source TEXT NOT NULL CHECK (source = 'agent-top'),
    raw_id TEXT NOT NULL,
    CHECK (
      (provider = 'claude' AND session_key GLOB 'claude:agent-top:*')
      OR (provider = 'codex' AND session_key GLOB 'codex:agent-top:*')
    )
  )`,
  `INSERT INTO usage_sessions_v4 SELECT * FROM usage_sessions`,
  `DROP TABLE usage_sessions`,
  `ALTER TABLE usage_sessions_v4 RENAME TO usage_sessions`,
  `CREATE TABLE collection_logs_v4 (
    log_id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL CHECK (source IN ('github', 'orca', 'agent-top')),
    status TEXT NOT NULL CHECK (status IN ('success', 'failed')),
    message TEXT NOT NULL,
    recorded_at TEXT NOT NULL
  )`,
  `INSERT INTO collection_logs_v4 (log_id, source, status, message, recorded_at)
   SELECT log_id, source, status, message, recorded_at FROM collection_logs`,
  `DROP TABLE collection_logs`,
  `ALTER TABLE collection_logs_v4 RENAME TO collection_logs`,
  `PRAGMA foreign_keys = ON`,
];
