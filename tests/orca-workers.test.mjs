import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { parseWorkerListJson, parseWorkerShowJson } from '../dist/orca/workers.js';

const dir = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(dir, 'fixtures/orca');

test('parse worker-list fixture and synthetic multi-host', () => {
  const text = readFileSync(join(fixtureDir, 'worker-list-snippet.json'), 'utf8');
  const rows = parseWorkerListJson(text);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dispatchId, 'ctx_2f955cbba22d');
  assert.equal(rows[0].hostId, 'local');
  assert.equal(rows[0].providerSessionId, null);

  const synthetic = readFileSync(join(fixtureDir, 'synthetic-worker-list.json'), 'utf8');
  const syn = parseWorkerListJson(synthetic);
  assert.equal(syn.length, 2);
  assert.equal(syn[1].hostId, 'remote-host-1');
  assert.equal(syn[1].runId, null);
});

test('parse worker-show settled fixture without preview fields', () => {
  const text = readFileSync(join(fixtureDir, 'worker-show-settled.json'), 'utf8');
  const row = parseWorkerShowJson(text);
  assert.equal(row.dispatchId, 'ctx_005f2513ac06');
  assert.equal(row.taskId, 'task_6be81dd44e83');
  assert.equal(row.runId, 'run_1a060327fe49');
  assert.equal(row.hostId, 'local');
  assert.equal(row.providerSessionId, null);
  assert.equal(row.issueRefHint, null);
});

test('parse partial synthetic worker-show', () => {
  const text = readFileSync(join(fixtureDir, 'synthetic-worker-show-partial.json'), 'utf8');
  const row = parseWorkerShowJson(text);
  assert.equal(row.dispatchId, 'ctx_synthetic00000003');
  assert.equal(row.runId, null);
  assert.equal(row.taskId, null);
  assert.match(row.worktreeId, /SYNTH/);
});

test('schema drift on invalid worker-list', () => {
  assert.throws(
    () => parseWorkerListJson('{"ok":true}'),
    (err) => err.code === 'orca_schema_drift' && /result/.test(err.message),
  );
});
