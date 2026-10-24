import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  migrateDatabase,
  openTelemetryDatabase,
  SUPPORTED_SCHEMA_VERSION,
} from '../dist/db/index.js';

const distDir = dirname(fileURLToPath(import.meta.url));

function tempDbPath(prefix = 'orca-db-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, dbPath: join(dir, 'telemetry.sqlite') };
}

test('T26: fresh database migrates and reopen is no-op', () => {
  const { dir, dbPath } = tempDbPath();
  const first = openTelemetryDatabase({ dbPath });
  const version = first.db
    .prepare('PRAGMA user_version')
    .get().user_version;
  assert.equal(version, SUPPORTED_SCHEMA_VERSION);
  first.close();
  const second = openTelemetryDatabase({ dbPath });
  second.close();
  rmSync(dir, { recursive: true, force: true });
});

test('T26: DELETE journal mode and foreign keys enabled', () => {
  const { dir, dbPath } = tempDbPath();
  const handle = openTelemetryDatabase({ dbPath });
  const journal = handle.db.prepare('PRAGMA journal_mode').get().journal_mode;
  assert.equal(journal.toLowerCase(), 'delete');
  const fk = handle.db.prepare('PRAGMA foreign_keys').get().foreign_keys;
  assert.equal(fk, 1);
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

test('T26: future schema version fails before mutation', () => {
  const { dir, dbPath } = tempDbPath();
  const raw = new DatabaseSync(dbPath);
  raw.exec('PRAGMA user_version = 99');
  raw.close();
  assert.throws(
    () => openTelemetryDatabase({ dbPath }),
    (err) => err.code === 'db_schema_drift',
  );
  rmSync(dir, { recursive: true, force: true });
});

test('T26: migration rolls back on failure leaving user_version 0', () => {
  const { dir, dbPath } = tempDbPath();
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('CREATE TABLE migration_probe (id INTEGER PRIMARY KEY)');
    db.exec('SYNTAX_ERROR_ON_PURPOSE');
    db.exec('COMMIT');
  } catch {
    db.exec('ROLLBACK');
  }
  const version = db.prepare('PRAGMA user_version').get().user_version;
  assert.equal(version, 0);
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='migration_probe'",
    )
    .all();
  assert.equal(tables.length, 0);
  db.close();
  migrateDatabase(new DatabaseSync(dbPath));
  rmSync(dir, { recursive: true, force: true });
});

test('T26: rejects database path inside git root', () => {
  const { dir, dbPath } = tempDbPath('orca-git-root-');
  const gitRoot = join(dir, 'repo');
  mkdirSync(gitRoot, { recursive: true });
  const nested = join(gitRoot, 'nested', 'telemetry.sqlite');
  mkdirSync(dirname(nested), { recursive: true });
  assert.throws(
    () => openTelemetryDatabase({ dbPath: nested, gitRoot }),
    (err) => err.code === 'db_path_rejected',
  );
  rmSync(dir, { recursive: true, force: true });
});

test('T26: rejects symlink database path', () => {
  if (process.platform === 'win32') {
    return;
  }
  const { dir, dbPath } = tempDbPath('orca-symlink-');
  const target = join(dir, 'real.sqlite');
  writeFileSync(target, '');
  const link = join(dir, 'link.sqlite');
  symlinkSync(target, link);
  assert.throws(
    () => openTelemetryDatabase({ dbPath: link }),
    (err) => err.code === 'db_path_rejected',
  );
  rmSync(dir, { recursive: true, force: true });
});

test('T26: database file mode 0600 on POSIX when supported', () => {
  if (process.platform === 'win32') {
    return;
  }
  const { dir, dbPath } = tempDbPath();
  const handle = openTelemetryDatabase({ dbPath });
  handle.close();
  const mode = lstatSync(dbPath).mode & 0o777;
  assert.equal(mode, 0o600);
  rmSync(dir, { recursive: true, force: true });
});

function runNodeSqliteSmoke(nodeSpecifier) {
  const script = resolve(distDir, 'helpers/node24-sqlite-smoke.mjs');
  return execFileSync(
    'npx',
    ['--yes', nodeSpecifier, script],
    { encoding: 'utf8', cwd: resolve(distDir, '..'), timeout: 115_000 },
  ).trim();
}

test('T26: node:sqlite loads on pinned minimum Node 24.0.0 (isolated)', () => {
  assert.equal(runNodeSqliteSmoke('node@24.0.0'), 'ok');
}, 120_000);

test('T26: node:sqlite loads on Node 24.11.0 (isolated)', () => {
  assert.equal(runNodeSqliteSmoke('node@24.11.0'), 'ok');
}, 120_000);
