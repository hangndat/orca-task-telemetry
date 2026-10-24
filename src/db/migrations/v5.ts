/** Schema version 5 — durable audit of explicit session role unlinks. */
export const SCHEMA_VERSION_V5 = 5;

/**
 * `unlink-role` deletes the live row in `session_role_links`; this table is the
 * only durable record that a role link ever existed. It intentionally excludes
 * `evidence_note` and any other free-form/raw evidence field — only the enum
 * role/identity columns and the two verifier hashes survive the unlink.
 */
export const MIGRATION_V5_STATEMENTS: readonly string[] = [
  `CREATE TABLE session_role_link_audit (
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
      AND substr(unlinked_by, 8) NOT GLOB '*[^0-9a-f]*'),
    CHECK (
      (role = 'coordinator' AND dispatch_id IS NULL)
      OR (role = 'worker' AND dispatch_id IS NOT NULL)
    )
  )`,
  `CREATE INDEX session_role_link_audit_session_idx
    ON session_role_link_audit(session_key, audit_id DESC)`,
];
