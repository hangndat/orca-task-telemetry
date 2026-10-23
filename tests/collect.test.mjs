import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { EXIT_PARTIAL, EXIT_SOURCE_UNAVAILABLE, EXIT_SUCCESS } from '../dist/errors.js';
import { runCollectCommand } from '../dist/commands/collect.js';
import { emptyConfig, saveConfig } from '../dist/config.js';
import { upsertProfile } from '../dist/profiles.js';

const dir = dirname(fileURLToPath(import.meta.url));
const ghItemsStub = resolve(dir, 'helpers/gh-project-items-stub.mjs');
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

function ghRepoStub() {
  return resolve(dir, 'helpers/gh-repo-stub.mjs');
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

function withCollectEnv(repo, appHome, fn) {
  const overlay = stubEnv(appHome, repo);
  const saved = {};
  for (const [key, value] of Object.entries(overlay)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  return fn().finally(() => {
    for (const key of Object.keys(overlay)) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  });
}

test('T33: collect all sources ok', async () => {
  const repo = initRepo();
  const appHome = mkdtempSync(join(tmpdir(), 'orca-collect-home-'));
  writeProfile(appHome);
  await withCollectEnv(repo, appHome, async () => {
    const payload = await runCollectCommand({ cwd: repo });
    assert.equal(payload.exitCode, EXIT_SUCCESS);
    assert.equal(payload.sources.every((s) => s.status === 'ok'), true);
    const second = await runCollectCommand({ cwd: repo });
    assert.equal(second.counts.issues, payload.counts.issues);
    assert.equal(second.counts.sessions, payload.counts.sessions);
    assert.ok(second.counts.collectionLogs > payload.counts.collectionLogs);
  });
  rmSync(repo, { recursive: true, force: true });
  rmSync(appHome, { recursive: true, force: true });
});

test('T33: partial exit when orca unavailable', async () => {
  const repo = initRepo();
  const appHome = mkdtempSync(join(tmpdir(), 'orca-collect-home-'));
  writeProfile(appHome);
  await withCollectEnv(repo, appHome, async () => {
    process.env.ORCA_TELEMETRY_ORCA = '/no/orca';
    const payload = await runCollectCommand({ cwd: repo });
    assert.equal(payload.exitCode, EXIT_PARTIAL);
    assert.equal(payload.sources.find((s) => s.source === 'orca')?.status, 'error');
    assert.equal(payload.sources.find((s) => s.source === 'github')?.status, 'ok');
  });
  rmSync(repo, { recursive: true, force: true });
  rmSync(appHome, { recursive: true, force: true });
});

test('T33: all sources fail exits 4', async () => {
  const repo = initRepo();
  const appHome = mkdtempSync(join(tmpdir(), 'orca-collect-home-'));
  writeProfile(appHome);
  await withCollectEnv(repo, appHome, async () => {
    process.env.ORCA_TELEMETRY_ORCA = '/no/orca';
    process.env.ORCA_TELEMETRY_CODEBURN = '/no/codeburn';
    delete process.env.GH_STUB_PAGE1_PATH;
    const payload = await runCollectCommand({ cwd: repo });
    assert.equal(payload.exitCode, EXIT_SOURCE_UNAVAILABLE);
    assert.equal(
      payload.sources.filter((s) => s.status === 'error').length,
      3,
    );
  });
  rmSync(repo, { recursive: true, force: true });
  rmSync(appHome, { recursive: true, force: true });
});
