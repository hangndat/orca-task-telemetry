import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  symlinkSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'vitest';
import {
  EXIT_PARTIAL,
  EXIT_SOURCE_UNAVAILABLE,
  EXIT_SUCCESS,
} from '../dist/errors.js';
import { runCollectCommand } from '../dist/commands/collect.js';
import { emptyConfig, saveConfig } from '../dist/config.js';
import { SUPPORTED_SCHEMA_VERSION } from '../dist/db/migrate.js';
import { openTelemetryDatabase } from '../dist/db/index.js';
import { upsertProfile } from '../dist/profiles.js';

const dir = dirname(fileURLToPath(import.meta.url));
const cli = resolve(dir, '../dist/cli.js');
const orcaRouter = resolve(dir, 'helpers/integration-stubs/orca-router.mjs');
const codeburnRouter = resolve(dir, 'helpers/integration-stubs/codeburn-router.mjs');
const page1 = resolve(dir, 'fixtures/github/project-items-page1.json');
const page2 = resolve(dir, 'fixtures/github/project-items-page2.json');
const statusFixture = resolve(dir, 'fixtures/orca/status-trimmed.json');
const workerListFixture = resolve(dir, 'fixtures/orca/worker-list-snippet.json');
const claudeSessions = resolve(
  dir,
  'fixtures/codeburn/claude/session-sonnet-aggregated.json',
);
const codexSessions = resolve(
  dir,
  'fixtures/codeburn/codex/session-gpt-small-aggregated.json',
);

function initRepo() {
  const root = mkdtempSync(join(tmpdir(), 'orca-collect-repo-'));
  execFileSync('git', ['init'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'c@test.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'c'], { cwd: root });
  writeFileSync(join(root, 'README.md'), '# c\n');
  execFileSync('git', ['add', 'README.md'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: root });
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/o/r.git'], {
    cwd: root,
  });
  return root;
}

function writeProfile(appHome, repoId = 'R_collect') {
  mkdirSync(appHome, { recursive: true });
  let config = emptyConfig();
  const { config: next } = upsertProfile(config, {
    id: repoId,
    nameWithOwner: 'o/r',
    url: 'https://github.com/o/r',
  }, {
    id: 'PVT_kwHOAGoDWs4BoZ5m',
    number: 1,
    title: 'P',
    url: 'https://github.com/users/o/projects/1',
    closed: false,
    owner: { kind: 'user', login: 'o' },
    sources: ['repository'],
  });
  saveConfig(appHome, next);
}

function stubEnv(appHome, _gitRoot, extra = {}) {
  return {
    ORCA_TELEMETRY_HOME: appHome,
    ORCA_TELEMETRY_GH: resolve(dir, 'helpers/integration-stubs/gh-collect.mjs'),
    GH_STUB_REPO_VIEW_JSON: JSON.stringify({
      id: 'R_collect',
      nameWithOwner: 'o/r',
      url: 'https://github.com/o/r',
    }),
    ORCA_TELEMETRY_ORCA: orcaRouter,
    ORCA_STUB_STATUS_PATH: statusFixture,
    ORCA_STUB_WORKER_LIST_PATH: workerListFixture,
    ORCA_TELEMETRY_COLLECT_RUN: 'run_1a060327fe49',
    ORCA_TELEMETRY_CODEBURN: codeburnRouter,
    CODEBURN_STUB_CLAUDE_PATH: claudeSessions,
    CODEBURN_STUB_CODEX_PATH: codexSessions,
    GH_STUB_PAGE1_PATH: page1,
    GH_STUB_PAGE2_PATH: page2,
    ...extra,
  };
}

function withCollectEnv(repo, appHome, fn, extra = {}) {
  const overlay = stubEnv(appHome, repo, extra);
  const saved = {};
  for (const [key, value] of Object.entries(overlay)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  return Promise.resolve(fn()).finally(() => {
    for (const key of Object.keys(overlay)) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  });
}

function gitStatusPorcelain(repo) {
  return execFileSync('git', ['status', '--porcelain'], {
    cwd: repo,
    encoding: 'utf8',
  });
}

function trackedFiles(repo) {
  return execFileSync('git', ['ls-files'], { cwd: repo, encoding: 'utf8' });
}

function runCliCollect(cwd, env, ...args) {
  return spawnSync(process.execPath, [cli, 'collect', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function parseStdoutJson(result) {
  const line = result.stdout.trim().split('\n').filter(Boolean).pop();
  return JSON.parse(line);
}

function assertNoSecrets(text) {
  assert.doesNotMatch(text, /ghp_[A-Za-z0-9]+/);
  assert.doesNotMatch(text, /github_pat_/);
  assert.doesNotMatch(text, /Bearer\s+\S{8,}/);
}

describe.sequential('T33 collect integration', () => {
  test('collect all sources ok and idempotent business counts', async () => {
    const repo = initRepo();
    const appHome = mkdtempSync(join(tmpdir(), 'orca-collect-home-'));
    writeProfile(appHome);
    const beforeStatus = gitStatusPorcelain(repo);
    const beforeTracked = trackedFiles(repo);
    await withCollectEnv(repo, appHome, async () => {
      const payload = await runCollectCommand({ cwd: repo });
      assert.equal(payload.exitCode, EXIT_SUCCESS);
      assert.equal(payload.sources.every((s) => s.status === 'ok'), true);
      const second = await runCollectCommand({ cwd: repo });
      assert.equal(second.counts.issues, payload.counts.issues);
      assert.equal(second.counts.sessions, payload.counts.sessions);
      assert.ok(second.counts.collectionLogs > payload.counts.collectionLogs);
    });
    assert.equal(gitStatusPorcelain(repo), beforeStatus);
    assert.equal(trackedFiles(repo), beforeTracked);
    rmSync(repo, { recursive: true, force: true });
    rmSync(appHome, { recursive: true, force: true });
  }, 20_000);

  test('partial exit when orca unavailable; github still ok', async () => {
    const repo = initRepo();
    const appHome = mkdtempSync(join(tmpdir(), 'orca-collect-home-'));
    writeProfile(appHome);
    await withCollectEnv(
      repo,
      appHome,
      async () => {
        const payload = await runCollectCommand({ cwd: repo });
        assert.equal(payload.exitCode, EXIT_PARTIAL);
        assert.equal(payload.sources.find((s) => s.source === 'orca')?.status, 'error');
        assert.equal(payload.sources.find((s) => s.source === 'github')?.status, 'ok');
        assert.equal(payload.sources.find((s) => s.source === 'codeburn')?.status, 'ok');
      },
      { ORCA_TELEMETRY_ORCA: '/no/orca-binary' },
    );
    rmSync(repo, { recursive: true, force: true });
    rmSync(appHome, { recursive: true, force: true });
  }, 20_000);

  test('partial when codeburn unavailable only', async () => {
    const repo = initRepo();
    const appHome = mkdtempSync(join(tmpdir(), 'orca-collect-home-'));
    writeProfile(appHome);
    await withCollectEnv(
      repo,
      appHome,
      async () => {
        const payload = await runCollectCommand({ cwd: repo });
        assert.equal(payload.exitCode, EXIT_PARTIAL);
        assert.equal(payload.sources.find((s) => s.source === 'codeburn')?.status, 'error');
        assert.equal(payload.sources.find((s) => s.source === 'github')?.status, 'ok');
        assert.equal(payload.sources.find((s) => s.source === 'orca')?.status, 'ok');
      },
      { ORCA_TELEMETRY_CODEBURN: '/no/codeburn-binary' },
    );
    rmSync(repo, { recursive: true, force: true });
    rmSync(appHome, { recursive: true, force: true });
  }, 20_000);

  test('github missing read:project scope', async () => {
    const repo = initRepo();
    const appHome = mkdtempSync(join(tmpdir(), 'orca-collect-home-'));
    writeProfile(appHome);
    await withCollectEnv(
      repo,
      appHome,
      async () => {
        const payload = await runCollectCommand({ cwd: repo });
        assert.equal(payload.exitCode, EXIT_PARTIAL);
        const gh = payload.sources.find((s) => s.source === 'github');
        assert.equal(gh?.status, 'error');
        assert.equal(gh?.error?.code, 'github_scope_missing');
        assert.equal(payload.sources.find((s) => s.source === 'orca')?.status, 'ok');
      },
      { GH_STUB_SCOPE_ERROR: '1' },
    );
    rmSync(repo, { recursive: true, force: true });
    rmSync(appHome, { recursive: true, force: true });
  }, 20_000);

  test('all sources fail exits 4', async () => {
    const repo = initRepo();
    const appHome = mkdtempSync(join(tmpdir(), 'orca-collect-home-'));
    writeProfile(appHome);
    await withCollectEnv(
      repo,
      appHome,
      async () => {
        const payload = await runCollectCommand({ cwd: repo });
        assert.equal(payload.exitCode, EXIT_SOURCE_UNAVAILABLE);
        assert.equal(
          payload.sources.filter((s) => s.status === 'error').length,
          3,
        );
      },
      {
        ORCA_TELEMETRY_ORCA: '/no/orca',
        ORCA_TELEMETRY_CODEBURN: '/no/codeburn',
        GH_STUB_SCOPE_ERROR: '1',
      },
    );
    rmSync(repo, { recursive: true, force: true });
    rmSync(appHome, { recursive: true, force: true });
  }, 20_000);

  test('schema drift rejects before mutating sources', async () => {
    const repo = initRepo();
    const appHome = mkdtempSync(join(tmpdir(), 'orca-collect-home-'));
    writeProfile(appHome);
    await withCollectEnv(repo, appHome, async () => {
      await runCollectCommand({ cwd: repo });
    });
    const dbPath = join(appHome, 'telemetry.sqlite');
    const drift = new DatabaseSync(dbPath);
    drift.exec(`PRAGMA user_version = ${SUPPORTED_SCHEMA_VERSION + 50}`);
    drift.close();
    await withCollectEnv(repo, appHome, async () => {
      await assert.rejects(
        () => runCollectCommand({ cwd: repo }),
        (err) => err.code === 'db_schema_drift',
      );
    });
    rmSync(repo, { recursive: true, force: true });
    rmSync(appHome, { recursive: true, force: true });
  }, 20_000);

  test('rejects telemetry home inside git root', async () => {
    const repo = initRepo();
    const insideHome = join(repo, '.orca-telemetry-inside');
    mkdirSync(insideHome, { recursive: true });
    writeProfile(insideHome);
    await assert.rejects(
      () =>
        withCollectEnv(repo, insideHome, () => runCollectCommand({ cwd: repo })),
      (err) => err.code === 'paths_error',
    );
    assert.equal(existsSync(join(insideHome, 'telemetry.sqlite')), false);
    rmSync(repo, { recursive: true, force: true });
  }, 15_000);

  test('rejects telemetry home via symlink into git root when canonical path is inside', async () => {
    const repo = initRepo();
    const insideHome = join(repo, '.orca-telemetry-symlink-target');
    mkdirSync(insideHome, { recursive: true });
    writeProfile(insideHome);
    const linkPath = mkdtempSync(join(tmpdir(), 'orca-collect-symlink-'));
    try {
      symlinkSync(insideHome, join(linkPath, 'home'), 'dir');
      const linkedHome = join(linkPath, 'home');
      await assert.rejects(
        () =>
          withCollectEnv(repo, linkedHome, () => runCollectCommand({ cwd: repo })),
        (err) => err.code === 'paths_error',
      );
    } catch (err) {
      if (err.code !== 'ERR_OP_NOT_PERMITTED' && err.code !== 'EPERM') {
        throw err;
      }
    }
    rmSync(repo, { recursive: true, force: true });
    rmSync(linkPath, { recursive: true, force: true });
  }, 15_000);

  test('CLI collect --json partial: single JSON line, exit 5, sanitized errors', async () => {
    const repo = initRepo();
    const appHome = mkdtempSync(join(tmpdir(), 'orca-collect-home-'));
    writeProfile(appHome);
    const env = stubEnv(appHome, repo, { ORCA_TELEMETRY_ORCA: '/no/orca' });
    const result = runCliCollect(repo, env, '--json');
    assert.equal(result.status, EXIT_PARTIAL);
    const stdoutLines = result.stdout.trim().split('\n').filter((l) => l.length > 0);
    assert.equal(stdoutLines.length, 1);
    const body = JSON.parse(stdoutLines[0]);
    assert.equal(body.ok, true);
    const orca = body.data.sources.find((s) => s.source === 'orca');
    assert.equal(orca.status, 'error');
    assert.equal(body.data.sources.find((s) => s.source === 'github').status, 'ok');
    assertNoSecrets(result.stdout);
    assertNoSecrets(result.stderr);
    rmSync(repo, { recursive: true, force: true });
    rmSync(appHome, { recursive: true, force: true });
  }, 25_000);

  test('CLI collect --json all-fail exit 4', async () => {
    const repo = initRepo();
    const appHome = mkdtempSync(join(tmpdir(), 'orca-collect-home-'));
    writeProfile(appHome);
    const env = stubEnv(appHome, repo, {
      ORCA_TELEMETRY_ORCA: '/no/orca',
      ORCA_TELEMETRY_CODEBURN: '/no/codeburn',
      GH_STUB_SCOPE_ERROR: '1',
    });
    const result = runCliCollect(repo, env, '--json');
    assert.equal(result.status, EXIT_SOURCE_UNAVAILABLE);
    const body = parseStdoutJson(result);
    assert.equal(body.ok, true);
    assert.equal(body.data.sources.filter((s) => s.status === 'error').length, 3);
    rmSync(repo, { recursive: true, force: true });
    rmSync(appHome, { recursive: true, force: true });
  }, 25_000);

  test('successful collect does not modify target git tree', async () => {
    const repo = initRepo();
    const appHome = mkdtempSync(join(tmpdir(), 'orca-collect-home-'));
    writeProfile(appHome);
    const before = gitStatusPorcelain(repo);
    const env = stubEnv(appHome, repo);
    const result = runCliCollect(repo, env, '--json');
    assert.equal(result.status, EXIT_SUCCESS);
    assert.equal(gitStatusPorcelain(repo), before);
    const handle = openTelemetryDatabase({ dbPath: join(appHome, 'telemetry.sqlite'), gitRoot: repo });
    assert.ok(handle.db.prepare('SELECT COUNT(*) AS c FROM issues').get().c > 0);
    handle.close();
    rmSync(repo, { recursive: true, force: true });
    rmSync(appHome, { recursive: true, force: true });
  }, 25_000);
});
