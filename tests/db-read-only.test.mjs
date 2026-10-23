import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  countRows,
  importGitHubRecords,
  openTelemetryDatabase,
  openReadOnlyTelemetryDb,
  readUserVersionReadOnly,
  SUPPORTED_SCHEMA_VERSION,
} from '../dist/db/index.js';
import { EXIT_SOURCE_UNAVAILABLE, EXIT_USAGE } from '../dist/errors.js';
import { spawnLegacyWalHolder } from './helpers/spawn-legacy-wal.mjs';
import { initBareRepo, writeReportsProfile } from './helpers/reports-harness.mjs';

const distDir = dirname(fileURLToPath(import.meta.url));

function tempHome() {
  const dir = mkdtempSync(join(tmpdir(), 'orca-ro-test-'));
  return { dir, dbPath: join(dir, 'telemetry.sqlite') };
}

async function createColdLegacyWalDb(dbPath) {
  const holder = spawnLegacyWalHolder(dbPath);
  await holder.ready;
  await holder.closeGracefully();
  const walPath = `${dbPath}-wal`;
  const shmPath = `${dbPath}-shm`;
  assert.ok(!existsSync(walPath));
  assert.ok(!existsSync(shmPath));
  const header = readFileSync(dbPath);
  assert.equal(header.readUInt8(18), 2);
  assert.equal(header.readUInt8(19), 2);
}

function assertDbError(err) {
  return err.code === 'db_error';
}

function ghDoctorEnv(appHome, repoId = 'R_cold_wal', nameWithOwner = 'o/r') {
  const ghStub = resolve(distDir, 'helpers/gh-repo-stub.mjs');
  return {
    ...process.env,
    ORCA_TELEMETRY_HOME: appHome,
    ORCA_TELEMETRY_GH: ghStub,
    GH_STUB_REPO_VIEW_JSON: JSON.stringify({
      id: repoId,
      nameWithOwner,
      url: `https://github.com/${nameWithOwner}`,
    }),
  };
}

test('read-only opens live DELETE database without sidecars', async () => {
  const { dir, dbPath } = tempHome();
  openTelemetryDatabase({ dbPath }).close();
  const before = readdirSync(dir).sort().join(',');
  const handle = await openReadOnlyTelemetryDb(dbPath);
  const version = handle.db.prepare('PRAGMA user_version').get().user_version;
  assert.equal(version, SUPPORTED_SCHEMA_VERSION);
  handle.release();
  const after = readdirSync(dir).sort().join(',');
  assert.equal(before, after);
  rmSync(dir, { recursive: true, force: true });
});

test('cold legacy WAL header rejects read-only access without mutating home', async () => {
  const { dir, dbPath } = tempHome();
  await createColdLegacyWalDb(dbPath);
  const inventoryBefore = readdirSync(dir).sort();
  assert.deepEqual(inventoryBefore, ['telemetry.sqlite']);
  await assert.rejects(() => readUserVersionReadOnly(dbPath), assertDbError);
  await assert.rejects(() => openReadOnlyTelemetryDb(dbPath), assertDbError);
  assert.deepEqual(readdirSync(dir).sort(), inventoryBefore);
  rmSync(dir, { recursive: true, force: true });
});

test('T32-SEC-F02/T35-SEC-F01: doctor rejects cold legacy WAL before SQLite open', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'orca-doc-cold-wal-repo-'));
  spawnSync('git', ['init'], { cwd: repo });
  spawnSync('git', ['config', 'user.email', 'd@test.com'], { cwd: repo });
  spawnSync('git', ['config', 'user.name', 'd'], { cwd: repo });

  const appHome = mkdtempSync(join(tmpdir(), 'orca-doc-cold-wal-home-'));
  const dbPath = join(appHome, 'telemetry.sqlite');
  await createColdLegacyWalDb(dbPath);
  const inventoryBefore = readdirSync(appHome).sort();

  const cli = resolve(distDir, '../dist/cli.js');
  const result = spawnSync(process.execPath, [cli, 'doctor', '--json'], {
    cwd: repo,
    encoding: 'utf8',
    env: ghDoctorEnv(appHome),
  });
  assert.equal(result.status, EXIT_USAGE);
  const payload = JSON.parse(result.stdout.trim().split('\n').pop());
  assert.equal(payload.data.summary, 'fail');
  const dbCheck = payload.data.checks.find((c) => c.id === 'database');
  assert.equal(dbCheck?.status, 'fail');
  assert.match(dbCheck?.message ?? '', /legacy WAL storage/i);
  assert.match(dbCheck?.remedy ?? '', /collect/i);
  assert.deepEqual(readdirSync(appHome).sort(), inventoryBefore);
  rmSync(repo, { recursive: true, force: true });
  rmSync(appHome, { recursive: true, force: true });
});

test('cold legacy WAL rejects report CLI commands without mutating home', async () => {
  const repo = initBareRepo();
  const appHome = mkdtempSync(join(tmpdir(), 'orca-report-cold-wal-home-'));
  writeReportsProfile(appHome);
  const dbPath = join(appHome, 'telemetry.sqlite');
  await createColdLegacyWalDb(dbPath);
  const inventoryBefore = readdirSync(appHome).sort();
  const cli = resolve(distDir, '../dist/cli.js');
  const commands = [
    ['report', 'tasks', '--json'],
    ['report', 'project', '--json'],
    ['report', 'unmapped', '--json'],
    ['report', 'task', '1', '--json'],
  ];
  for (const args of commands) {
    const result = spawnSync(process.execPath, [cli, ...args], {
      cwd: repo,
      encoding: 'utf8',
      env: ghDoctorEnv(appHome, 'R_reports', 'org-a/repo'),
    });
    assert.equal(result.status, EXIT_SOURCE_UNAVAILABLE);
  }
  assert.deepEqual(readdirSync(appHome).sort(), inventoryBefore);
  rmSync(repo, { recursive: true, force: true });
  rmSync(appHome, { recursive: true, force: true });
});

test('SQLite header preflight rejects short and unsupported future format', async () => {
  const { dir, dbPath } = tempHome();
  writeFileSync(dbPath, Buffer.from('SQLite format 3\0', 'utf8'));
  await assert.rejects(() => readUserVersionReadOnly(dbPath), assertDbError);
  rmSync(dir, { recursive: true, force: true });

  const future = tempHome();
  openTelemetryDatabase({ dbPath: future.dbPath }).close();
  const bytes = Buffer.from(readFileSync(future.dbPath));
  bytes.writeUInt8(3, 18);
  bytes.writeUInt8(3, 19);
  writeFileSync(future.dbPath, bytes);
  await assert.rejects(() => readUserVersionReadOnly(future.dbPath), assertDbError);
  rmSync(future.dir, { recursive: true, force: true });
});

test('legacy WAL sidecar rejects read-only access without mutating home', async () => {
  const { dir, dbPath } = tempHome();
  const holder = spawnLegacyWalHolder(dbPath);
  await holder.ready;
  const inventoryBefore = readdirSync(dir).sort();
  assert.ok(inventoryBefore.some((n) => n.endsWith('-wal')));
  await assert.rejects(
    () => readUserVersionReadOnly(dbPath),
    (err) => err.code === 'db_error',
  );
  await assert.rejects(
    () => openReadOnlyTelemetryDb(dbPath),
    (err) => err.code === 'db_error',
  );
  assert.deepEqual(readdirSync(dir).sort(), inventoryBefore);
  holder.stop();
  rmSync(dir, { recursive: true, force: true });
});

test('writer normalizes legacy WAL and preserves committed rows', async () => {
  const { dir, dbPath } = tempHome();
  const holder = spawnLegacyWalHolder(dbPath);
  await holder.ready;
  assert.ok(existsSync(`${dbPath}-wal`));
  await holder.closeGracefully();
  const writer = openTelemetryDatabase({ dbPath });
  const journal = writer.db.prepare('PRAGMA journal_mode').get().journal_mode;
  assert.equal(journal.toLowerCase(), 'delete');
  const rows = writer.db
    .prepare(
      "SELECT message FROM collection_logs WHERE source = 'orca' AND message = 'legacy-wal-probe'",
    )
    .all();
  assert.equal(rows.length, 1);
  writer.close();
  assert.ok(!existsSync(`${dbPath}-wal`));
  const second = openTelemetryDatabase({ dbPath });
  assert.equal(countRows(second.db, 'collection_logs'), 1);
  second.close();
  const reader = await openReadOnlyTelemetryDb(dbPath);
  const probe = reader.db
    .prepare(
      "SELECT message FROM collection_logs WHERE source = 'orca' AND message = 'legacy-wal-probe'",
    )
    .all();
  assert.equal(probe.length, 1);
  reader.release();
  assert.ok(!existsSync(`${dbPath}-wal`));
  rmSync(dir, { recursive: true, force: true });
}, 15_000);

test('read transaction does not see uncommitted writer changes', async () => {
  const { dir, dbPath } = tempHome();
  const writer = openTelemetryDatabase({ dbPath });
  importGitHubRecords(writer.db, { issues: [], memberships: [] });
  const before = countRows(writer.db, 'collection_logs');
  writer.db.exec('BEGIN IMMEDIATE');
  writer.db
    .prepare(
      `INSERT INTO collection_logs (source, status, message, recorded_at)
       VALUES ('github', 'success', 'uncommitted', '2026-06-01T00:00:00.000Z')`,
    )
    .run();
  const reader = await openReadOnlyTelemetryDb(dbPath);
  const readerCount = reader.db
    .prepare('SELECT COUNT(*) AS c FROM collection_logs')
    .get().c;
  assert.equal(readerCount, before);
  reader.release();
  writer.db.exec('ROLLBACK');
  writer.close();
  rmSync(dir, { recursive: true, force: true });
});

test('future schema DELETE database fails report read with schema drift', async () => {
  const { dir, dbPath } = tempHome();
  const raw = new DatabaseSync(dbPath);
  raw.exec('PRAGMA journal_mode = DELETE');
  raw.exec('PRAGMA user_version = 99');
  raw.close();
  await assert.rejects(
    () => openReadOnlyTelemetryDb(dbPath),
    (err) => err.code === 'db_schema_drift',
  );
  rmSync(dir, { recursive: true, force: true });
});

test('T32-F02: doctor CLI diagnoses future schema with exit 2', () => {
  const repo = mkdtempSync(join(tmpdir(), 'orca-doc-future-repo-'));
  spawnSync('git', ['init'], { cwd: repo });
  spawnSync('git', ['config', 'user.email', 'd@test.com'], { cwd: repo });
  spawnSync('git', ['config', 'user.name', 'd'], { cwd: repo });

  const appHome = mkdtempSync(join(tmpdir(), 'orca-doc-future-home-'));
  const dbPath = join(appHome, 'telemetry.sqlite');
  const raw = new DatabaseSync(dbPath);
  raw.exec('PRAGMA journal_mode = DELETE');
  raw.exec(`PRAGMA user_version = ${SUPPORTED_SCHEMA_VERSION + 10}`);
  raw.close();

  const ghStub = resolve(distDir, 'helpers/gh-repo-stub.mjs');
  const cli = resolve(distDir, '../dist/cli.js');
  const result = spawnSync(process.execPath, [cli, 'doctor', '--json'], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      ORCA_TELEMETRY_HOME: appHome,
      ORCA_TELEMETRY_GH: ghStub,
      GH_STUB_REPO_VIEW_JSON: JSON.stringify({
        id: 'R_future',
        nameWithOwner: 'o/r',
        url: 'https://github.com/o/r',
      }),
    },
  });
  assert.equal(result.status, EXIT_USAGE);
  const payload = JSON.parse(result.stdout.trim().split('\n').pop());
  assert.equal(payload.data.summary, 'fail');
  const dbCheck = payload.data.checks.find((c) => c.id === 'database');
  assert.equal(dbCheck?.status, 'fail');
  assert.match(dbCheck?.message ?? '', /newer than supported/);
  rmSync(repo, { recursive: true, force: true });
  rmSync(appHome, { recursive: true, force: true });
});
