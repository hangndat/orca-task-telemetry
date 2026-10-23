/** Schema version 1 — MVP storage (T27). */
export const SCHEMA_VERSION_V1 = 1;

export const MIGRATION_V1_STATEMENTS: readonly string[] = [
  `CREATE TABLE projects (
    project_id TEXT PRIMARY KEY NOT NULL
  )`,
  `CREATE TABLE issues (
    issue_node_id TEXT PRIMARY KEY NOT NULL,
    repository_name_with_owner TEXT NOT NULL,
    number INTEGER NOT NULL,
    url TEXT NOT NULL,
    title TEXT NOT NULL,
    state TEXT NOT NULL
  )`,
  `CREATE TABLE project_memberships (
    project_id TEXT NOT NULL,
    issue_node_id TEXT NOT NULL,
    PRIMARY KEY (project_id, issue_node_id),
    FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE CASCADE,
    FOREIGN KEY (issue_node_id) REFERENCES issues(issue_node_id) ON DELETE CASCADE
  )`,
  `CREATE TABLE executions (
    execution_key TEXT PRIMARY KEY NOT NULL,
    host_id TEXT NOT NULL,
    raw_id TEXT NOT NULL,
    run_id TEXT,
    task_id TEXT,
    dispatch_id TEXT
  )`,
  `CREATE TABLE usage_sessions (
    session_key TEXT PRIMARY KEY NOT NULL,
    provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex')),
    source TEXT NOT NULL CHECK (source = 'codeburn'),
    raw_id TEXT NOT NULL,
    CHECK (
      (provider = 'claude' AND session_key GLOB 'claude:codeburn:*')
      OR (provider = 'codex' AND session_key GLOB 'codex:codeburn:*')
    )
  )`,
  `CREATE TABLE usage_snapshots (
    session_key TEXT PRIMARY KEY NOT NULL,
    observed_at TEXT NOT NULL,
    tokens_json TEXT NOT NULL,
    cost_amount_usd REAL,
    cost_kind TEXT NOT NULL CHECK (cost_kind IN ('estimated_api_equivalent', 'unknown')),
    cost_source_tool TEXT,
    cost_source_version TEXT,
    claude_models_json TEXT,
    claude_token_allocation TEXT CHECK (
      claude_token_allocation IS NULL
      OR claude_token_allocation IN ('known', 'unknown')
    ),
    claude_project_hint TEXT,
    FOREIGN KEY (session_key) REFERENCES usage_sessions(session_key) ON DELETE CASCADE
  )`,
  `CREATE TABLE session_links (
    session_key TEXT PRIMARY KEY NOT NULL,
    issue_node_id TEXT NOT NULL,
    method TEXT NOT NULL CHECK (method = 'manual'),
    linked_at TEXT NOT NULL,
    linked_by TEXT,
    FOREIGN KEY (session_key) REFERENCES usage_sessions(session_key) ON DELETE CASCADE,
    FOREIGN KEY (issue_node_id) REFERENCES issues(issue_node_id) ON DELETE CASCADE
  )`,
  `CREATE TABLE collection_logs (
    log_id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL CHECK (source IN ('github', 'orca', 'codeburn')),
    status TEXT NOT NULL CHECK (status IN ('success', 'failed')),
    message TEXT NOT NULL,
    recorded_at TEXT NOT NULL
  )`,
];
