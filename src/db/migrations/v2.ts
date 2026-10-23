/** Schema version 2 — native GitHub sub-issue parent reference. */
export const SCHEMA_VERSION_V2 = 2;

export const MIGRATION_V2_STATEMENTS: readonly string[] = [
  `ALTER TABLE issues ADD COLUMN parent_issue_node_id TEXT`,
  `ALTER TABLE issues ADD COLUMN parent_issue_observed INTEGER NOT NULL DEFAULT 0 CHECK (parent_issue_observed IN (0, 1))`,
  `CREATE INDEX issues_parent_issue_node_id_idx ON issues(parent_issue_node_id)`,
];
