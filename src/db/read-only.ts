import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { assertSchemaCurrent } from './migrate.js';
import { dbError } from './errors.js';
import { CliError } from '../errors.js';

export type ReadOnlyTelemetryHandle = {
  readonly db: DatabaseSync;
  readonly sourcePath: string;
  release(): void;
};

const SQLITE_MAGIC = 'SQLite format 3';

function assertSqliteMainHeader(filePath: string): void {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(16);
    fs.readSync(fd, buf, 0, 16, 0);
    const magic = buf.toString('utf8', 0, SQLITE_MAGIC.length);
    if (magic !== SQLITE_MAGIC) {
      throw dbError('Database file is not a valid SQLite database.');
    }
  } finally {
    fs.closeSync(fd);
  }
}

function mapOpenError(err: unknown): CliError {
  const msg = err instanceof Error ? err.message : String(err);
  if (/SQLITE_BUSY|database is locked/i.test(msg)) {
    return dbError(
      'Database is locked.',
      'Close other processes using the telemetry database or run collect later.',
    );
  }
  return dbError(
    'Database is not readable.',
    'Check file permissions or close other processes locking the database.',
  );
}

/**
 * Reject legacy WAL sidecars before opening SQLite on the live path (no new sidecars).
 */
export function preflightReadOnlySource(sourceDbPath: string): void {
  const resolved = path.resolve(sourceDbPath);
  if (!fs.existsSync(resolved)) {
    return;
  }
  assertSqliteMainHeader(resolved);
  if (fs.existsSync(`${resolved}-wal`)) {
    throw dbError(
      'Telemetry database uses legacy WAL storage.',
      'Run orca-telemetry collect to normalize the database for read-only access.',
    );
  }
}

/**
 * Read-only queries on the live DELETE-journal database inside one deferred read transaction.
 */
export async function openReadOnlyTelemetryDb(
  sourceDbPath: string,
): Promise<ReadOnlyTelemetryHandle> {
  const resolved = path.resolve(sourceDbPath);
  if (!fs.existsSync(resolved)) {
    throw dbError('Database file does not exist.');
  }
  preflightReadOnlySource(resolved);

  let db: DatabaseSync;
  try {
    db = new DatabaseSync(resolved, { readOnly: true });
  } catch (err) {
    throw mapOpenError(err);
  }

  let inTransaction = false;
  try {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('BEGIN DEFERRED');
    inTransaction = true;
    assertSchemaCurrent(db);
  } catch (err) {
    if (inTransaction) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // ignore
      }
    }
    db.close();
    throw err;
  }

  return {
    db,
    sourcePath: resolved,
    release() {
      try {
        db.exec('ROLLBACK');
      } catch {
        // ignore
      }
      db.close();
    },
  };
}

/**
 * Diagnostic user_version read for doctor — no assertSchemaCurrent.
 */
export async function readUserVersionReadOnly(
  sourceDbPath: string,
): Promise<number | null> {
  const resolved = path.resolve(sourceDbPath);
  if (!fs.existsSync(resolved)) {
    return null;
  }
  preflightReadOnlySource(resolved);

  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(resolved, { readOnly: true });
    db.exec('PRAGMA foreign_keys = ON');
    const row = db.prepare('PRAGMA user_version').get() as
      | { user_version: number }
      | undefined;
    const version = row?.user_version;
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
      throw dbError('Could not read database schema version.');
    }
    return version;
  } catch (err) {
    if (err instanceof CliError) {
      throw err;
    }
    throw mapOpenError(err);
  } finally {
    db?.close();
  }
}
