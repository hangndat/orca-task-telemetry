import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { parseRunListJson, pinnedCollectRunId } from '../dist/orca/runs.js';
import { parseWorkerListPage } from '../dist/orca/workers.js';

const dir = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(dir, 'fixtures/orca');

test('parse run-list fixture ids and null cursor', () => {
  const text = readFileSync(join(fixtureDir, 'run-list-snippet.json'), 'utf8');
  const page = parseRunListJson(text);
  assert.deepEqual(page.runIds, ['run_fixture00000001', 'run_1a060327fe49']);
  assert.equal(page.nextCursor, null);
});

test('parse run-list pagination cursor across pages', () => {
  const p1 = parseRunListJson(
    readFileSync(join(fixtureDir, 'run-list-page1.json'), 'utf8'),
  );
  const p2 = parseRunListJson(
    readFileSync(join(fixtureDir, 'run-list-page2.json'), 'utf8'),
  );
  assert.equal(p1.runIds.length, 1);
  assert.equal(typeof p1.nextCursor, 'string');
  assert.equal(p2.runIds[0], 'run_fixture_page2a');
  assert.equal(p2.nextCursor, null);
});

test('empty run-list is not invented executions', () => {
  const page = parseRunListJson(
    readFileSync(join(fixtureDir, 'run-list-empty.json'), 'utf8'),
  );
  assert.deepEqual(page.runIds, []);
  assert.equal(page.nextCursor, null);
});

test('run-list schema drift and ok=false', () => {
  assert.throws(
    () => parseRunListJson('{"ok":true}'),
    (err) => err.code === 'orca_schema_drift',
  );
  assert.throws(
    () => parseRunListJson('{"ok":false,"result":{"runs":[]}}'),
    (err) => err.code === 'orca_runtime_unavailable',
  );
  assert.doesNotThrow(() =>
    parseRunListJson(
      JSON.stringify({
        ok: true,
        result: { runs: [{ objective: 'no id' }], nextCursor: 1 },
      }),
    ),
  );
});

test('worker-list page.nextCursor from live shape', () => {
  const snippet = parseWorkerListPage(
    readFileSync(join(fixtureDir, 'worker-list-snippet.json'), 'utf8'),
  );
  assert.equal(snippet.nextCursor, null);
  assert.equal(snippet.records.length, 1);

  const paged = parseWorkerListPage(
    JSON.stringify({
      ok: true,
      result: {
        workers: snippet.records.length
          ? JSON.parse(
              readFileSync(join(fixtureDir, 'worker-list-snippet.json'), 'utf8'),
            ).result.workers
          : [],
        page: { limit: 1, total: 2, hasMore: true, nextCursor: 'opaque-worker-page' },
        scope: { run: 'run_1a060327fe49', source: 'flag' },
      },
    }),
  );
  assert.equal(paged.nextCursor, 'opaque-worker-page');
});

test('pinnedCollectRunId treats empty as unset', () => {
  const savedA = process.env.ORCA_TELEMETRY_COLLECT_RUN;
  const savedB = process.env.ORCA_COLLECT_RUN_ID;
  delete process.env.ORCA_TELEMETRY_COLLECT_RUN;
  delete process.env.ORCA_COLLECT_RUN_ID;
  assert.equal(pinnedCollectRunId(), undefined);
  process.env.ORCA_TELEMETRY_COLLECT_RUN = '  ';
  process.env.ORCA_COLLECT_RUN_ID = 'run_alias';
  assert.equal(pinnedCollectRunId(), 'run_alias');
  process.env.ORCA_TELEMETRY_COLLECT_RUN = 'run_pin';
  assert.equal(pinnedCollectRunId(), 'run_pin');
  if (savedA === undefined) {
    delete process.env.ORCA_TELEMETRY_COLLECT_RUN;
  } else {
    process.env.ORCA_TELEMETRY_COLLECT_RUN = savedA;
  }
  if (savedB === undefined) {
    delete process.env.ORCA_COLLECT_RUN_ID;
  } else {
    process.env.ORCA_COLLECT_RUN_ID = savedB;
  }
});
