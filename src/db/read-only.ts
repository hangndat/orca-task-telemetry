import fs from 'node:fs';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assertSchemaCurrent } from './migrate.js';
import { dbError } from './errors.js';

export type ReadOnlyTelemetryHandle = {
  readonly db: DatabaseSync;
  readonly snapshotDir: string;
  readonly snapshotPath: string;
  release(): void;
};

function copyWalSidecars(sourceDbPath: string, destDbPath: string): void {
  const wal = `${sourceDbPath}-wal`;
  const shm = `${sourceDbPath}-shm`;
  if (fs.existsSync(wal)) {
    copyFileSync(wal, `${destDbPath}-wal`);
  }
  if (fs.existsSync(shm)) {
    copyFileSync(shm, `${destDbPath}-shm`);
  }
}

/**
 * Read-only queries via a private temp copy of the DB (+ WAL sidecars when present).
 * Never opens the live database file with SQLite, so the telemetry home directory
 * is not mutated (no new -wal/-shm next to the source).
 */
export async function openReadOnlyTelemetryDb(
  sourceDbPath: string,
): Promise<ReadOnlyTelemetryHandle> {
  const resolved = path.resolve(sourceDbPath);
  if (!fs.existsSync(resolved)) {
    throw dbError('Database file does not exist.');
  }

  const snapshotDir = mkdtempSync(path.join(tmpdir(), 'orca-ro-snap-'));
  const snapshotPath = path.join(snapshotDir, 'snapshot.sqlite');

  try {
    copyFileSync(resolved, snapshotPath);
    copyWalSidecars(resolved, snapshotPath);
  } catch {
    rmSync(snapshotDir, { recursive: true, force: true });
    throw dbError(
      'Database is not readable.',
      'Check file permissions or close other processes locking the database.',
    );
  }

  const db = new DatabaseSync(snapshotPath, { readOnly: true });
  try {
    db.exec('PRAGMA foreign_keys = ON');
    assertSchemaCurrent(db);
  } catch (err) {
    db.close();
    rmSync(snapshotDir, { recursive: true, force: true });
    throw err;
  }

  return {
    db,
    snapshotDir,
    snapshotPath,
    release() {
      db.close();
      rmSync(snapshotDir, { recursive: true, force: true });
    },
  };
}

export async function readUserVersionReadOnly(
  sourceDbPath: string,
): Promise<number | null> {
  if (!fs.existsSync(sourceDbPath)) {
    return null;
  }
  const handle = await openReadOnlyTelemetryDb(sourceDbPath);
  try {
    const row = handle.db.prepare('PRAGMA user_version').get() as
      | { user_version: number }
      | undefined;
    return row?.user_version ?? null;
  } finally {
    handle.release();
  }
}
