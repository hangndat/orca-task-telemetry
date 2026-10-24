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

export const SUPPORTED_SCHEMA_VERSION = SCHEMA_VERSION_V4;

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
  if (current !== 0 && current !== SCHEMA_VERSION_V1 && current !== SCHEMA_VERSION_V2 && current !== SCHEMA_VERSION_V3) {
    throw dbSchemaError(
      `Unsupported intermediate schema version ${current}; expected 0, ${SCHEMA_VERSION_V1}, ${SCHEMA_VERSION_V2}, ${SCHEMA_VERSION_V3} or ${SUPPORTED_SCHEMA_VERSION}.`,
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
    for (const sql of MIGRATION_V4_STATEMENTS) {
      db.exec(sql);
    }
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION_V4}`);
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
  // v4 was hardened before release without changing its version. Refuse a
  // database created by the earlier draft schema rather than silently opening
  // it with weaker identity or privacy constraints.
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
