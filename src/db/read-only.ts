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
/** Minimum bytes to read journal format versions at offsets 18 and 19. */
const SQLITE_HEADER_MIN_BYTES = 20;
const JOURNAL_FORMAT_ROLLBACK = 1;
const JOURNAL_FORMAT_WAL = 2;

const LEGACY_WAL_MESSAGE = 'Telemetry database uses legacy WAL storage.';
const LEGACY_WAL_REMEDY =
  'Run orca-telemetry collect to normalize the database for read-only access.';

function rejectLegacyWalHeader(): void {
  throw dbError(LEGACY_WAL_MESSAGE, LEGACY_WAL_REMEDY);
}

function assertSqliteMainHeader(filePath: string): void {
  const fd = fs.openSync(filePath, 'r');
  try {
    const { size } = fs.fstatSync(fd);
    if (size < SQLITE_HEADER_MIN_BYTES) {
      throw dbError('Database file is not a valid SQLite database.');
    }
    const buf = Buffer.alloc(SQLITE_HEADER_MIN_BYTES);
    const read = fs.readSync(fd, buf, 0, SQLITE_HEADER_MIN_BYTES, 0);
    if (read < SQLITE_HEADER_MIN_BYTES) {
      throw dbError('Database file is not a valid SQLite database.');
    }
    const magic = buf.toString('utf8', 0, SQLITE_MAGIC.length);
    if (magic !== SQLITE_MAGIC) {
      throw dbError('Database file is not a valid SQLite database.');
    }
    const writeVersion = buf.readUInt8(18);
    const readVersion = buf.readUInt8(19);
    if (
      writeVersion === JOURNAL_FORMAT_WAL ||
      readVersion === JOURNAL_FORMAT_WAL
    ) {
      rejectLegacyWalHeader();
    }
    if (
      writeVersion > JOURNAL_FORMAT_WAL ||
      readVersion > JOURNAL_FORMAT_WAL
    ) {
      throw dbError(
        'Database uses an unsupported SQLite file format.',
        'Upgrade orca-task-telemetry or run collect after upgrading the database.',
      );
    }
    if (
      writeVersion < JOURNAL_FORMAT_ROLLBACK ||
      readVersion < JOURNAL_FORMAT_ROLLBACK
    ) {
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
    rejectLegacyWalHeader();
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
