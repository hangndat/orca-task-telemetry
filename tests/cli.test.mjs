import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { test } from 'vitest';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const cli = resolve(dir, '../dist/cli.js');
const ghStub = resolve(dir, 'helpers/gh-projects-stub.mjs');
const repoUserFixture = resolve(
  dir,
  'fixtures/github/project-discovery-repo-user.json',
);
const userOwnerFixture = resolve(
  dir,
  'fixtures/github/project-discovery-user-owner.json',
);

function initTempRepo(remotes) {
  const root = mkdtempSync(join(tmpdir(), 'orca-cli-projects-'));
  execFileSync('git', ['init'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: root });
  writeFileSync(join(root, 'README.md'), '# temp\n');
  execFileSync('git', ['add', 'README.md'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: root });
  for (const [name, url] of remotes) {
    execFileSync('git', ['remote', 'add', name, url], { cwd: root });
  }
  return root;
}

function run(...args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
}

function runWithEnv(env, ...args) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function runInRepo(cwd, env, ...args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function parseStdoutJson(result) {
  const line = result.stdout.trim();
  assert.ok(line.length > 0, 'expected JSON on stdout');
  return JSON.parse(line);
}

test('--help documents implemented vs planned commands', () => {
  const result = run('--help');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /foundation scaffold/);
  assert.match(result.stdout, /doctor.*implemented/i);
  assert.match(result.stdout, /projects.*implemented/i);
  assert.match(result.stdout, /init.*not implemented/i);
  assert.doesNotMatch(result.stdout, /__internal_test/);
});

test('--version prints the package version', () => {
  const result = run('--version');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /0\.1\.0/);
});

test('unknown command exits 2 with help hint', () => {
  const result = run('nosuchcmd');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /error:/);
  assert.match(result.stderr, /--help/);
});

test('unknown command with --json returns unknown_command envelope', () => {
  const result = run('nosuchcmd', '--json');
  assert.equal(result.status, 2);
  const body = parseStdoutJson(result);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'unknown_command');
});

test('invalid global flag exits 2 as usage_error', () => {
  const result = run('--not-a-real-flag');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /error:/);
});

test('invalid global flag with --json returns usage_error', () => {
  const result = run('--not-a-real-flag', '--json');
  assert.equal(result.status, 2);
  const body = parseStdoutJson(result);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'usage_error');
});

test('report without subcommand is usage_error', () => {
  const result = run('report');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /error:/);
});

test('report task without issue id is usage_error', () => {
  const result = run('report', 'task');
  assert.equal(result.status, 2);
});

const NOT_IMPLEMENTED_CASES = [
  ['init'],
  ['collect'],
  ['link'],
  ['report', 'tasks'],
  ['report', 'task', '42'],
  ['report', 'project'],
  ['report', 'unmapped'],
];

for (const args of NOT_IMPLEMENTED_CASES) {
  const label = args.join(' ');
  test(`not implemented: ${label} (text)`, () => {
    const result = run(...args);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /not implemented/i);
  });

  test(`not implemented: ${label} (--json)`, () => {
    const result = run(...args, '--json');
    assert.equal(result.status, 2);
    const body = parseStdoutJson(result);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'not_implemented');
  });
}

test('doctor does not require an active GitHub session', () => {
  const result = run('doctor');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Node\.js:/);
  assert.match(result.stdout, /gh:/);
});

test('--version --json emits a single JSON object', () => {
  const result = run('--version', '--json');
  assert.equal(result.status, 0);
  const body = parseStdoutJson(result);
  assert.equal(body.ok, true);
  assert.equal(body.data.version, '0.1.0');
});

test('doctor --json emits structured data', () => {
  const result = run('doctor', '--json');
  assert.equal(result.status, 0);
  const body = parseStdoutJson(result);
  assert.equal(body.ok, true);
  assert.match(body.data.nodeVersion, /^v\d+/);
  assert.ok(Array.isArray(body.data.tools));
});

test('unexpected internal error exits 1 without stack by default', () => {
  const result = run('__internal_test_unexpected_error');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unexpected error/i);
  assert.doesNotMatch(result.stderr, /internal test unexpected error/);
});

test('unexpected internal error with --json', () => {
  const result = run('__internal_test_unexpected_error', '--json');
  assert.equal(result.status, 1);
  const body = parseStdoutJson(result);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'internal_error');
});

test('AC2: projects --json uses stub gh/git context', () => {
  const root = initTempRepo([
    ['origin', 'https://github.com/hangndat/orca-task-telemetry.git'],
  ]);
  const repoView = JSON.stringify({
    id: 'R_kgDOVUhnYw',
    nameWithOwner: 'hangndat/orca-task-telemetry',
    url: 'https://github.com/hangndat/orca-task-telemetry',
  });
  const result = runInRepo(root, {
    ORCA_TELEMETRY_GH: ghStub,
    GH_STUB_REPO_VIEW_JSON: repoView,
    GH_STUB_GRAPHQL_REPO_JSON: readFileSync(repoUserFixture, 'utf8'),
    GH_STUB_GRAPHQL_OWNER_JSON: readFileSync(userOwnerFixture, 'utf8'),
  }, 'projects', '--json');
  assert.equal(result.status, 0);
  const body = parseStdoutJson(result);
  assert.equal(body.ok, true);
  assert.equal(body.data.repository.nameWithOwner, 'hangndat/orca-task-telemetry');
  assert.ok(body.data.projects.length >= 2);
  rmSync(root, { recursive: true, force: true });
});

test('AC2: projects rejects unknown flag', () => {
  const root = initTempRepo([
    ['origin', 'https://github.com/hangndat/orca-task-telemetry.git'],
  ]);
  const result = runInRepo(root, {}, 'projects', '--nope');
  assert.equal(result.status, 2);
  rmSync(root, { recursive: true, force: true });
});

test('AC2: projects surfaces auth errors from gh', () => {
  const root = initTempRepo([
    ['origin', 'https://github.com/hangndat/orca-task-telemetry.git'],
  ]);
  const repoView = JSON.stringify({
    id: 'R_kgDOVUhnYw',
    nameWithOwner: 'hangndat/orca-task-telemetry',
    url: 'https://github.com/hangndat/orca-task-telemetry',
  });
  const result = runInRepo(root, {
    ORCA_TELEMETRY_GH: ghStub,
    GH_STUB_REPO_VIEW_JSON: repoView,
    GH_STUB_GRAPHQL_REPO_JSON: readFileSync(repoUserFixture, 'utf8'),
    GH_STUB_GRAPHQL_OWNER_JSON: readFileSync(userOwnerFixture, 'utf8'),
    GH_STUB_EXIT_CODE: '1',
    GH_STUB_STDERR: 'To use GitHub CLI, please run: gh auth login',
  }, 'projects', '--json');
  assert.equal(result.status, 3);
  const body = parseStdoutJson(result);
  assert.equal(body.error.code, 'github_auth_required');
  rmSync(root, { recursive: true, force: true });
});

test('ORCA_TELEMETRY_DEBUG prints stack to stderr', () => {
  const result = runWithEnv(
    { ORCA_TELEMETRY_DEBUG: '1' },
    '__internal_test_unexpected_error',
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /internal test unexpected error/);
});
