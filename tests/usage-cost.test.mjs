import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { aggregateCosts, mapAgentTopCost, zeroKnownCost } from '../dist/usage/cost.js';
import { parseCountedSessions } from '../dist/usage/sessions.js';
import { parseSessionsJsonArray } from '../dist/usage/adapter.js';

const dir = dirname(fileURLToPath(import.meta.url));
const VERSION = '0.27.1';
const OBSERVED = '2026-10-23T12:00:00.000Z';

test('mapAgentTopCost uses estimated_api_equivalent source', () => {
  const cost = mapAgentTopCost(0.12, 0, VERSION);
  assert.equal(cost.kind, 'estimated_api_equivalent');
  assert.equal(cost.amountUsd, 0.12);
  assert.deepEqual(cost.source, { tool: 'agent-top', version: VERSION });
});

test('missing and zero costs', () => {
  const unknown = mapAgentTopCost(null, 0, VERSION);
  assert.equal(unknown.kind, 'unknown');
  assert.equal(unknown.amountUsd, null);
  const zero = zeroKnownCost(VERSION);
  assert.equal(zero.amountUsd, 0);
  assert.equal(zero.kind, 'estimated_api_equivalent');
});

test('unpriced tokens force unknown even if cost_usd is 0', () => {
  const cost = mapAgentTopCost(0, 100, VERSION);
  assert.equal(cost.kind, 'unknown');
  assert.equal(cost.amountUsd, null);
});

test('negative cost invalid', () => {
  assert.throws(
    () => mapAgentTopCost(-1, 0, VERSION),
    (err) => err.code === 'agent_top_schema_drift',
  );
});

test('aggregate known total and unknown count', () => {
  const claude = parseCountedSessions(
    [
      {
        harness: 'claude',
        session_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee77',
        input: 0,
        output: 0,
        cache_read: 0,
        cache_write_5m: 0,
        cache_write_1h: 0,
        cache_write_unsplit: 0,
        cost_usd: 1,
        unpriced_tokens: 0,
      },
    ],
    OBSERVED,
    VERSION,
  );
  const codexMissing = parseSessionsJsonArray(
    readFileSync(join(dir, 'fixtures/agent-top/synthetic-codex-missing-cost.json'), 'utf8'),
  );
  const codexParsed = parseCountedSessions(codexMissing, OBSERVED, VERSION);
  const agg = aggregateCosts([
    claude[0].snapshot.cost,
    codexParsed[0].snapshot.cost,
  ]);
  assert.equal(agg.knownTotalUsd, 1);
  assert.equal(agg.unknownCount, 1);
});

test('zero-token session still produces snapshot with known zero cost', () => {
  const parsed = parseCountedSessions(
    [
      {
        harness: 'claude',
        session_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee66',
        input: 0,
        output: 0,
        cache_read: 0,
        cache_write_5m: 0,
        cache_write_1h: 0,
        cache_write_unsplit: 0,
        cost_usd: 0,
        unpriced_tokens: 0,
      },
    ],
    OBSERVED,
    VERSION,
  );
  assert.equal(parsed[0].snapshot.cost.amountUsd, 0);
  assert.equal(parsed[0].snapshot.tokens.input, 0);
});
