import type { DatabaseSync } from 'node:sqlite';
import { dbSchemaError } from './errors.js';
import {
  MIGRATION_V1_STATEMENTS,
  SCHEMA_VERSION_V1,
} from './migrations/v1.js';

export const SUPPORTED_SCHEMA_VERSION = SCHEMA_VERSION_V1;

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
  if (current !== 0) {
    throw dbSchemaError(
      `Unsupported intermediate schema version ${current}; expected 0 or ${SUPPORTED_SCHEMA_VERSION}.`,
    );
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const sql of MIGRATION_V1_STATEMENTS) {
      db.exec(sql);
    }
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION_V1}`);
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
}
