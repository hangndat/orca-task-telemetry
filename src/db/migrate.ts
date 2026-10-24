import type { DatabaseSync } from 'node:sqlite';
import { dbSchemaError } from './errors.js';
import {
  MIGRATION_V1_STATEMENTS,
  SCHEMA_VERSION_V1,
} from './migrations/v1.js';
import {
  MIGRATION_V2_STATEMENTS,
  SCHEMA_VERSION_V2,
} from './migrations/v2.js';
import { MIGRATION_V3_STATEMENTS, SCHEMA_VERSION_V3 } from './migrations/v3.js';
import { MIGRATION_V4_STATEMENTS, SCHEMA_VERSION_V4 } from './migrations/v4.js';
import { MIGRATION_V5_STATEMENTS, SCHEMA_VERSION_V5 } from './migrations/v5.js';

export const SUPPORTED_SCHEMA_VERSION = SCHEMA_VERSION_V5;

function readUserVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as
    | { user_version: number }
    | undefined;
  const version = row?.user_version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
    throw dbSchemaError('PRAGMA user_version returned invalid value.');
  }
  return version;
}

/**
 * Apply pending migrations inside a transaction; rolls back on failure.
 */
export function migrateDatabase(db: DatabaseSync): void {
  const current = readUserVersion(db);
  if (current > SUPPORTED_SCHEMA_VERSION) {
    throw dbSchemaError(
      `Database schema version ${current} is newer than supported ${SUPPORTED_SCHEMA_VERSION}.`,
    );
  }
  if (current === SUPPORTED_SCHEMA_VERSION) {
    return;
  }
  if (current !== 0 && current !== SCHEMA_VERSION_V1 && current !== SCHEMA_VERSION_V2
    && current !== SCHEMA_VERSION_V3 && current !== SCHEMA_VERSION_V4) {
    throw dbSchemaError(
      `Unsupported intermediate schema version ${current}; expected 0, ${SCHEMA_VERSION_V1}, ` +
      `${SCHEMA_VERSION_V2}, ${SCHEMA_VERSION_V3}, ${SCHEMA_VERSION_V4} or ${SUPPORTED_SCHEMA_VERSION}.`,
    );
  }

  // SQLite cannot enable foreign keys inside the migration transaction.
  db.exec('PRAGMA foreign_keys = ON');
  const foreignKeys = db.prepare('PRAGMA foreign_keys').get() as
    | { foreign_keys: number }
    | undefined;
  if (foreignKeys?.foreign_keys !== 1) {
    throw dbSchemaError('Foreign keys must be enabled before migration.');
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    if (current === 0) {
      for (const sql of MIGRATION_V1_STATEMENTS) {
        db.exec(sql);
      }
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION_V1}`);
    }
    if (current < SCHEMA_VERSION_V2) {
      for (const sql of MIGRATION_V2_STATEMENTS) {
        db.exec(sql);
      }
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION_V2}`);
    }
    if (current < SCHEMA_VERSION_V3) {
      for (const sql of MIGRATION_V3_STATEMENTS) {
        db.exec(sql);
      }
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION_V3}`);
    }
    if (current < SCHEMA_VERSION_V4) {
      for (const sql of MIGRATION_V4_STATEMENTS) {
        db.exec(sql);
      }
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION_V4}`);
    }
    assertV4ProvenanceHardened(db);
    for (const sql of MIGRATION_V5_STATEMENTS) {
      db.exec(sql);
    }
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION_V5}`);
    const invalid = db.prepare('PRAGMA foreign_key_check').get();
    if (invalid) {
      throw dbSchemaError('Existing database contains invalid foreign key references.');
    }
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // ignore rollback errors
    }
    throw err;
  }
}

/**
 * v4 was hardened before release without changing its version. Refuse a
 * database created by the earlier draft schema rather than silently opening
 * it with weaker identity or privacy constraints.
 */
function assertV4ProvenanceHardened(db: DatabaseSync): void {
  const requiredSql: readonly [string, string][] = [
    ['scoped_executions', "hex(host_id)"],
    ['session_role_links', "evidence_kind = 'bounded_manual'"],
    ['session_role_links', 'evidence_note IN'],
    ['legacy_execution_rekeys', "evidence_kind = 'bounded_manual'"],
    ['collection_attempts', 'length(counters_json) <= 512'],
    ['collection_attempts_counters_insert', 'json_each(NEW.counters_json)'],
    ['collection_attempts_counters_update', 'json_each(NEW.counters_json)'],
  ];
  const schema = new Map(
    (db.prepare(`SELECT name, sql FROM sqlite_master WHERE name IN
      ('scoped_executions', 'session_role_links', 'legacy_execution_rekeys',
       'collection_attempts', 'collection_attempts_counters_insert',
       'collection_attempts_counters_update')`).all() as { name: string; sql: string }[])
      .map((row) => [row.name, row.sql]),
  );
  if (requiredSql.some(([name, marker]) => !schema.get(name)?.includes(marker))) {
    throw dbSchemaError('Database v4 provenance constraints are missing or outdated.');
  }
}

/**
 * v5 adds the durable unlink audit trail. Refuse a database whose
 * `session_role_link_audit` table is missing or missing its identity/role/
 * verifier-hash constraints, rather than let `unlink-role` silently audit
 * into an under-constrained table.
 */
function assertV5AuditHardened(db: DatabaseSync): void {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'session_role_link_audit'`)
    .get() as { sql: string } | undefined;
  const sql = row?.sql ?? '';
  const requiredMarkers = [
    "role IN ('coordinator', 'worker')",
    'length(linked_by) = 71',
    "substr(linked_by, 1, 7) = 'sha256:'",
    "substr(linked_by, 8) NOT GLOB '*[^0-9a-f]*'",
    'length(unlinked_by) = 71',
    "substr(unlinked_by, 1, 7) = 'sha256:'",
    "substr(unlinked_by, 8) NOT GLOB '*[^0-9a-f]*'",
    "role = 'coordinator' AND dispatch_id IS NULL",
    "role = 'worker' AND dispatch_id IS NOT NULL",
  ];
  if (!row || requiredMarkers.some((marker) => !sql.includes(marker))) {
    throw dbSchemaError('Database v5 session_role_link_audit schema is missing or outdated.');
  }
}

export function assertSchemaCurrent(db: DatabaseSync): void {
  const current = readUserVersion(db);
  if (current > SUPPORTED_SCHEMA_VERSION) {
    throw dbSchemaError(
      `Database schema version ${current} is newer than supported ${SUPPORTED_SCHEMA_VERSION}.`,
    );
  }
  if (current < SUPPORTED_SCHEMA_VERSION) {
    throw dbSchemaError(
      `Database schema version ${current} is older than required ${SUPPORTED_SCHEMA_VERSION}.`,
    );
  }
  assertV4ProvenanceHardened(db);
  assertV5AuditHardened(db);
}
