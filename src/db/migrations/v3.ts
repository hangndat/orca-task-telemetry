/** Schema version 3 — manually attributed GitHub pull and commit trace. */
export const SCHEMA_VERSION_V3 = 3;

export const MIGRATION_V3_STATEMENTS: readonly string[] = [
  `CREATE UNIQUE INDEX session_links_session_issue_idx
    ON session_links(session_key, issue_node_id)`,
  `CREATE TABLE pull_requests (
    pull_node_id TEXT PRIMARY KEY NOT NULL,
    repository_name_with_owner TEXT NOT NULL,
    number INTEGER NOT NULL CHECK (number > 0),
    url TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('OPEN', 'CLOSED', 'MERGED')),
    is_draft INTEGER NOT NULL CHECK (is_draft IN (0, 1)),
    merged_at TEXT,
    head_ref_oid TEXT NOT NULL,
    observed_at TEXT NOT NULL
  )`,
  `CREATE TABLE issue_pull_relations (
    issue_node_id TEXT NOT NULL,
    pull_node_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('verified_current', 'stale', 'unknown')),
    source TEXT NOT NULL CHECK (source = 'closingIssuesReferences'),
    last_verified_at TEXT,
    PRIMARY KEY (issue_node_id, pull_node_id),
    FOREIGN KEY (issue_node_id) REFERENCES issues(issue_node_id),
    FOREIGN KEY (pull_node_id) REFERENCES pull_requests(pull_node_id)
  )`,
  `CREATE TABLE pull_commits (
    pull_node_id TEXT NOT NULL,
    oid TEXT NOT NULL CHECK (
      length(oid) = 40 AND oid = lower(oid) AND oid NOT GLOB '*[^0-9a-f]*'
    ),
    url TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('verified_current', 'stale', 'unknown')),
    last_verified_at TEXT,
    PRIMARY KEY (pull_node_id, oid),
    FOREIGN KEY (pull_node_id) REFERENCES pull_requests(pull_node_id)
  )`,
  `CREATE TABLE session_pull_links (
    session_key TEXT NOT NULL,
    issue_node_id TEXT NOT NULL,
    pull_node_id TEXT NOT NULL,
    method TEXT NOT NULL CHECK (method = 'manual'),
    linked_at TEXT NOT NULL,
    PRIMARY KEY (session_key, pull_node_id),
    UNIQUE (session_key, issue_node_id, pull_node_id),
    FOREIGN KEY (session_key, issue_node_id)
      REFERENCES session_links(session_key, issue_node_id),
    FOREIGN KEY (issue_node_id, pull_node_id)
      REFERENCES issue_pull_relations(issue_node_id, pull_node_id)
  )`,
  `CREATE TABLE session_commit_links (
    session_key TEXT NOT NULL,
    pull_node_id TEXT NOT NULL,
    oid TEXT NOT NULL,
    method TEXT NOT NULL CHECK (method = 'manual'),
    linked_at TEXT NOT NULL,
    PRIMARY KEY (session_key, pull_node_id, oid),
    FOREIGN KEY (session_key, pull_node_id)
      REFERENCES session_pull_links(session_key, pull_node_id),
    FOREIGN KEY (pull_node_id, oid)
      REFERENCES pull_commits(pull_node_id, oid)
  )`,
];
