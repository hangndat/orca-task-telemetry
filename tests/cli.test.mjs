import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'vitest';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const dir = dirname(fileURLToPath(import.meta.url));
const cli = resolve(dir, '../dist/cli.js');

function run(...args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
}

function runWithEnv(env, ...args) {
  return spawnSync(process.execPath, [cli, ...args], {
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
  ['projects'],
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

test('ORCA_TELEMETRY_DEBUG prints stack to stderr', () => {
  const result = runWithEnv(
    { ORCA_TELEMETRY_DEBUG: '1' },
    '__internal_test_unexpected_error',
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /internal test unexpected error/);
});
