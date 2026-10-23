import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { dbError, dbPathError } from './errors.js';
import {
  assertSchemaCurrent,
  migrateDatabase,
  SUPPORTED_SCHEMA_VERSION,
} from './migrate.js';
import { dbSchemaError } from './errors.js';

export type OpenDatabaseOptions = {
  dbPath: string;
  /** When set, refuse DB files inside this git repository root. */
  gitRoot?: string | null;
};

export type TelemetryDatabase = {
  readonly path: string;
  readonly db: DatabaseSync;
  close(): void;
};

function isPathInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative.length > 0 &&
    !relative.startsWith('..') &&
    !path.isAbsolute(relative)
  );
}

function assertNotSymlink(targetPath: string, label: string): void {
  try {
    const stat = fs.lstatSync(targetPath);
    if (stat.isSymbolicLink()) {
      throw dbPathError(`${label} must not be a symbolic link.`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw err;
  }
}

function assertDbPathAllowed(dbPath: string, gitRoot?: string | null): void {
  const resolved = path.resolve(dbPath);
  if (!path.isAbsolute(resolved)) {
    throw dbPathError('Database path must be absolute.');
  }
  assertNotSymlink(resolved, 'Database file');
  const parent = path.dirname(resolved);
  assertNotSymlink(parent, 'Database parent directory');
  if (gitRoot) {
    const root = path.resolve(gitRoot);
    if (isPathInside(resolved, root) || resolved === root) {
      throw dbPathError(
        'Database must not live inside the target git repository.',
      );
    }
  }
}

function ensureDatabaseDirectory(dbPath: string): void {
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // best-effort; parent dirs may be outside our control
  }
}

function restrictDatabaseFileMode(dbPath: string): void {
  if (!fs.existsSync(dbPath)) {
    return;
  }
  try {
    fs.chmodSync(dbPath, 0o600);
  } catch {
    // ignore on platforms without POSIX modes
  }
}

function readUserVersionBeforeMigrate(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as
    | { user_version: number }
    | undefined;
  const version = row?.user_version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
    throw dbSchemaError('PRAGMA user_version returned invalid value.');
  }
  return version;
}

function configurePragmas(db: DatabaseSync): void {
  db.exec('PRAGMA foreign_keys = ON');
  const journal = db.prepare('PRAGMA journal_mode = DELETE').get() as
    | { journal_mode: string }
    | undefined;
  const mode = journal?.journal_mode?.toLowerCase();
  if (mode !== 'delete') {
    throw dbError(`Expected DELETE journal mode, got ${mode ?? 'unknown'}.`);
  }
}

/**
 * Open (or create) the telemetry SQLite database at an explicit path (tests / resolved app home).
 */
export function openTelemetryDatabase(
  options: OpenDatabaseOptions,
): TelemetryDatabase {
  assertDbPathAllowed(options.dbPath, options.gitRoot ?? null);
  ensureDatabaseDirectory(options.dbPath);
  const db = new DatabaseSync(options.dbPath);
  try {
    db.exec('PRAGMA foreign_keys = ON');
    const versionBeforeJournal = readUserVersionBeforeMigrate(db);
    if (versionBeforeJournal > SUPPORTED_SCHEMA_VERSION) {
      throw dbSchemaError(
        `Database schema version ${versionBeforeJournal} is newer than supported ${SUPPORTED_SCHEMA_VERSION}.`,
      );
    }
    configurePragmas(db);
    migrateDatabase(db);
    assertSchemaCurrent(db);
    restrictDatabaseFileMode(options.dbPath);
  } catch (err) {
    db.close();
    throw err;
  }
  return {
    path: path.resolve(options.dbPath),
    db,
    close() {
      db.close();
    },
  };
}
