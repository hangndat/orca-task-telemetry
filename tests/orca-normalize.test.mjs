import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { parseOrcaExecutionKey } from '../dist/contracts.js';
import { mergeOrcaExecutions, normalizeSupervisedRecords } from '../dist/orca/normalize.js';
import { parseWorktreeShowJson } from '../dist/orca/worktrees.js';
import { parseWorkerListJson } from '../dist/orca/workers.js';

const dir = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(dir, 'fixtures/orca');

const WORKTREE_A =
  '80511ff3-b702-48d3-a1bf-bf9b1c5d0326::<HOME>/orca/workspaces/orca-task-telemetry/Foundation';

test('normalize supervised records to execution keys', () => {
  const list = parseWorkerListJson(
    readFileSync(join(fixtureDir, 'worker-list-snippet.json'), 'utf8'),
  );
  const execs = normalizeSupervisedRecords(list);
  assert.equal(execs.length, 1);
  assert.equal(execs[0].source, 'supervised');
  assert.equal(execs[0].dispatchId, 'ctx_2f955cbba22d');
  assert.equal(
    execs[0].executionKey,
    `orca:local:ctx_2f955cbba22d`,
  );
  assert.deepEqual(parseOrcaExecutionKey(execs[0].executionKey), {
    hostId: 'local',
    rawId: 'ctx_2f955cbba22d',
  });
});

test('merge drops manual fallback when worktree has supervised worker', () => {
  const supervised = parseWorkerListJson(
    readFileSync(join(fixtureDir, 'worker-list-snippet.json'), 'utf8'),
  );
  const manual = parseWorktreeShowJson(
    readFileSync(join(fixtureDir, 'worktree-manual-show.json'), 'utf8'),
  );
  manual.worktreeId = WORKTREE_A;
  const merged = mergeOrcaExecutions(supervised, [manual]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].source, 'supervised');
});

test('merge keeps multiple dispatches on same worktree', () => {
  const supervised = parseWorkerListJson(
    readFileSync(join(fixtureDir, 'synthetic-worker-list.json'), 'utf8'),
  );
  const base = supervised[0];
  const dup = {
    ...base,
    dispatchId: 'ctx_synthetic_dup0001',
  };
  const merged = mergeOrcaExecutions([base, dup], []);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].worktreeId, merged[1].worktreeId);
});

test('manual-only worktree becomes manual execution', () => {
  const manual = parseWorktreeShowJson(
    readFileSync(join(fixtureDir, 'synthetic-worktree-manual.json'), 'utf8'),
  );
  const merged = mergeOrcaExecutions([], [manual]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].source, 'manual');
  assert.equal(merged[0].dispatchId, null);
  assert.equal(merged[0].runId, null);
});

test('same worktree id on different hosts keeps manual and supervised', () => {
  const sharedWt = 'shared-wt-id::<HOME>/path';
  const supervised = parseWorkerListJson(
    readFileSync(join(fixtureDir, 'worker-list-snippet.json'), 'utf8'),
  );
  supervised[0].worktreeId = sharedWt;
  supervised[0].hostId = 'host-b';
  const manual = parseWorktreeShowJson(
    readFileSync(join(fixtureDir, 'synthetic-worktree-manual.json'), 'utf8'),
  );
  manual.worktreeId = sharedWt;
  manual.hostId = 'host-a';
  const merged = mergeOrcaExecutions(supervised, [manual]);
  assert.equal(merged.length, 2);
  assert.ok(merged.some((e) => e.source === 'manual' && e.hostId === 'host-a'));
  assert.ok(merged.some((e) => e.source === 'supervised' && e.hostId === 'host-b'));
});

test('supervised missing dispatchId with worktreeId does not silently drop manual', () => {
  const wtId = WORKTREE_A;
  const supervised = parseWorkerListJson(
    readFileSync(join(fixtureDir, 'worker-list-snippet.json'), 'utf8'),
  );
  supervised[0].dispatchId = null;
  supervised[0].worktreeId = wtId;
  const manual = parseWorktreeShowJson(
    readFileSync(join(fixtureDir, 'worktree-manual-show.json'), 'utf8'),
  );
  manual.worktreeId = wtId;
  assert.throws(
    () => mergeOrcaExecutions(supervised, [manual]),
    (err) => err.code === 'orca_schema_drift',
  );
});

test('distinct host namespaces produce distinct execution keys', () => {
  const supervised = parseWorkerListJson(
    readFileSync(join(fixtureDir, 'synthetic-worker-list.json'), 'utf8'),
  );
  const execs = normalizeSupervisedRecords(supervised);
  const keys = new Set(execs.map((e) => e.executionKey));
  assert.equal(keys.size, execs.length);
  assert.ok(execs.some((e) => e.hostId === 'remote-host-1'));
});
