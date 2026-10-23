import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import {
  parseWorktreeListJson,
  parseWorktreePsRowJson,
  parseWorktreeShowJson,
} from '../dist/orca/worktrees.js';

const dir = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(dir, 'fixtures/orca');

test('manual worktree show fixture', () => {
  const text = readFileSync(join(fixtureDir, 'worktree-manual-show.json'), 'utf8');
  const row = parseWorktreeShowJson(text);
  assert.equal(row.source, 'manual');
  assert.equal(row.hostId, 'local');
  assert.match(row.worktreeId, /OTHER_REPO/);
  assert.equal(row.issueRefHint, null);
});

test('worktree ps manual row (no agents)', () => {
  const text = readFileSync(join(fixtureDir, 'worktree-manual-ps-row.json'), 'utf8');
  const row = parseWorktreePsRowJson(text);
  assert.ok(row);
  assert.equal(row.source, 'manual');
  assert.equal(row.issueRefHint, null);
});

test('genuine empty worktree list is valid', () => {
  assert.deepEqual(
    parseWorktreeListJson('{"ok":true,"result":{"worktrees":[]}}'),
    [],
  );
});

test('missing worktrees array is schema drift', () => {
  assert.throws(
    () => parseWorktreeListJson('{"ok":true,"result":{}}'),
    (err) => err.code === 'orca_schema_drift',
  );
});

test('worktree list row missing id or hostId is schema drift', () => {
  assert.throws(
    () =>
      parseWorktreeListJson(
        '{"ok":true,"result":{"worktrees":[{"hostId":"local"}]}}',
      ),
    (err) => err.code === 'orca_schema_drift' && err.message.includes('.id'),
  );
  assert.throws(
    () =>
      parseWorktreeListJson(
        '{"ok":true,"result":{"worktrees":[{"id":"wt-only"}]}}',
      ),
    (err) => err.code === 'orca_schema_drift' && err.message.includes('hostId'),
  );
});

test('worktree ps with manually launched agent still parses as manual', () => {
  const text = readFileSync(
    join(fixtureDir, 'synthetic-worktree-ps-manual-agent.json'),
    'utf8',
  );
  const row = parseWorktreePsRowJson(text);
  assert.ok(row);
  assert.equal(row.source, 'manual');
  assert.match(row.worktreeId, /manual-agent/);
});

test('synthetic manual worktree', () => {
  const text = readFileSync(join(fixtureDir, 'synthetic-worktree-manual.json'), 'utf8');
  const row = parseWorktreeShowJson(text);
  assert.equal(row.source, 'manual');
  assert.match(row.path, /manual-only/);
});
