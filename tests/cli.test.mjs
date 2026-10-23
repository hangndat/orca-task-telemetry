import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const dir = dirname(fileURLToPath(import.meta.url));
const cli = resolve(dir, '../dist/cli.js');

function run(...args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
}

test('--help documents the actual MVP state', () => {
  const result = run('--help');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /foundation scaffold/);
  assert.match(result.stdout, /Planned MVP commands/);
});

test('--version prints the package version', () => {
  const result = run('--version');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /0\.1\.0/);
});

test('doctor does not require an active GitHub session', () => {
  const result = run('doctor');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Node\.js:/);
  assert.match(result.stdout, /gh:/);
});

test('not-yet-built commands fail explicitly', () => {
  const result = run('collect');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /not implemented/);
});
