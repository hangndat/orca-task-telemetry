import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { EXIT_USAGE } from '../dist/errors.js';
import { runDoctorWithDeps } from '../dist/doctor.js';
import { openTelemetryDatabase, SUPPORTED_SCHEMA_VERSION } from '../dist/db/index.js';
import { readUserVersionReadOnly } from '../dist/db/read-only.js';

const distDir = dirname(fileURLToPath(import.meta.url));

test('T32: doctor pass when core checks healthy', async () => {
  const report = await runDoctorWithDeps({
    nodeVersion: 'v24.1.0',
    ghAuthStatus: async () => ({
      authenticated: true,
      scopes: ['read:project', 'project', 'repo'],
    }),
    orcaVersion: async () => '1.4.241',
    agentTopVersion: async () => '0.27.1',
    readDbUserVersion: () => SUPPORTED_SCHEMA_VERSION,
  });
  assert.equal(report.summary, 'pass');
  assert.equal(report.exitCode, 0);
  assert.equal(report.checks.find((c) => c.id === 'gh_apply_scope')?.status, 'pass');
});

test('F02: doctor separates read access from apply scope', async () => {
  const report = await runDoctorWithDeps({
    nodeVersion: 'v24.1.0',
    ghAuthStatus: async () => ({ authenticated: true, scopes: ['read:project', 'repo'] }),
  });
  assert.equal(report.checks.find((c) => c.id === 'gh_scope')?.status, 'pass');
  assert.deepEqual(report.checks.find((c) => c.id === 'gh_apply_scope'), {
    id: 'gh_apply_scope', status: 'warn',
    message: 'Token is missing project scope required for --apply.',
    remedy: 'gh auth refresh -s project',
  });
  assert.equal(report.summary, 'warn');
});

test('F02: doctor warns when active auth state is unknown or unauthenticated', async () => {
  for (const status of [
    { authenticated: false, scopes: [], known: true },
    { authenticated: false, scopes: [], known: false },
  ]) {
    const report = await runDoctorWithDeps({ nodeVersion: 'v24.1.0', ghAuthStatus: async () => status });
    assert.equal(report.checks.find((c) => c.id === 'gh_apply_scope')?.status, 'warn');
  }
});

test('T32: doctor warn on missing sources still exits 0', async () => {
  const report = await runDoctorWithDeps({
    nodeVersion: 'v24.1.0',
    ghAuthStatus: async () => ({ authenticated: false, scopes: [] }),
    orcaVersion: async () => null,
    agentTopVersion: async () => null,
    readDbUserVersion: () => null,
  });
  assert.equal(report.summary, 'warn');
  assert.equal(report.exitCode, 0);
});

test('T32: doctor fail on unsupported node', async () => {
  const report = await runDoctorWithDeps({
    nodeVersion: 'v20.0.0',
  });
  assert.equal(report.summary, 'fail');
  assert.equal(report.exitCode, EXIT_USAGE);
  assert.ok(report.checks.some((c) => c.id === 'node' && c.status === 'fail'));
});

test('T32: doctor fail on future database schema', async () => {
  const report = await runDoctorWithDeps({
    nodeVersion: 'v24.0.0',
    appHome: '/tmp/home',
    readDbUserVersion: () => SUPPORTED_SCHEMA_VERSION + 10,
  });
  assert.equal(report.checks.find((c) => c.id === 'database')?.status, 'fail');
  assert.equal(report.summary, 'fail');
  assert.equal(report.exitCode, EXIT_USAGE);
});

test('T32-SEC-F02: readUserVersionReadOnly does not add files under DB directory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-doctor-ro-'));
  const dbPath = join(dir, 'telemetry.sqlite');
  openTelemetryDatabase({ dbPath }).close();
  const before = readdirSync(dir).sort().join(',');
  const version = await readUserVersionReadOnly(dbPath);
  assert.equal(version, SUPPORTED_SCHEMA_VERSION);
  const after = readdirSync(dir).sort().join(',');
  assert.equal(before, after);
  rmSync(dir, { recursive: true, force: true });
});

test('T32-SEC-F02: doctor CLI does not create WAL/SHM in telemetry home', () => {
  const repo = mkdtempSync(join(tmpdir(), 'orca-doctor-cli-repo-'));
  execFileSync('git', ['init'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'd@test.com'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'd'], { cwd: repo });
  writeFileSync(join(repo, 'README.md'), '# d\n');
  execFileSync('git', ['add', 'README.md'], { cwd: repo });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repo });
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/o/r.git'], { cwd: repo });

  const appHome = mkdtempSync(join(tmpdir(), 'orca-doctor-cli-home-'));
  const dbPath = join(appHome, 'telemetry.sqlite');
  openTelemetryDatabase({ dbPath, gitRoot: repo }).close();

  const ghStub = resolve(distDir, 'helpers/gh-repo-stub.mjs');
  const cli = resolve(distDir, '../dist/cli.js');
  const before = readdirSync(appHome).sort();
  const result = spawnSync(process.execPath, [cli, 'doctor', '--json'], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      ORCA_TELEMETRY_HOME: appHome,
      ORCA_TELEMETRY_GH: ghStub,
      GH_STUB_REPO_VIEW_JSON: JSON.stringify({
        id: 'R_doc',
        nameWithOwner: 'o/r',
        url: 'https://github.com/o/r',
      }),
    },
  });
  assert.equal(result.status, 0);
  const after = readdirSync(appHome).sort();
  assert.deepEqual(after, before);
  assert.ok(!after.some((n) => n.endsWith('-wal') || n.endsWith('-shm')));
  rmSync(repo, { recursive: true, force: true });
  rmSync(appHome, { recursive: true, force: true });
});

/** Cold CI runners download node@24.0.0 via npx; bound above Vitest default 5s. */
const NODE24_READONLY_VITEST_TIMEOUT_MS = 120_000;
const NODE24_READONLY_CHILD_TIMEOUT_MS = 115_000;

function runNodeReadonlySmoke(nodeSpecifier) {
  const script = resolve(distDir, 'helpers/node24-readonly-smoke.mjs');
  return execFileSync('npx', ['--yes', nodeSpecifier, script], {
    encoding: 'utf8',
    cwd: resolve(distDir, '..'),
    timeout: NODE24_READONLY_CHILD_TIMEOUT_MS,
  }).trim();
}

test(
  'read-only native helper on Node 24.0.0',
  { timeout: NODE24_READONLY_VITEST_TIMEOUT_MS },
  () => {
    const out = runNodeReadonlySmoke('node@24.0.0');
    assert.equal(out.split('\n').pop(), 'ok');
  },
);
