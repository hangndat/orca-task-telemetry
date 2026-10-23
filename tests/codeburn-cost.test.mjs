import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { aggregateCosts, mapRowCost, zeroKnownCost } from '../dist/codeburn/cost.js';
import { parseClaudeSessions } from '../dist/codeburn/claude.js';
import { parseCodexSessions } from '../dist/codeburn/codex.js';
import { parseSessionsJsonArray } from '../dist/codeburn/adapter.js';

const dir = dirname(fileURLToPath(import.meta.url));
const VERSION = '0.9.27';
const OBSERVED = '2026-10-23T12:00:00.000Z';

test('mapRowCost uses estimated_api_equivalent source', () => {
  const cost = mapRowCost(0.12, VERSION);
  assert.equal(cost.kind, 'estimated_api_equivalent');
  assert.equal(cost.amountUsd, 0.12);
  assert.deepEqual(cost.source, { tool: 'codeburn', version: VERSION });
});

test('missing and zero costs', () => {
  const unknown = mapRowCost(null, VERSION);
  assert.equal(unknown.kind, 'unknown');
  assert.equal(unknown.amountUsd, null);
  const zero = zeroKnownCost(VERSION);
  assert.equal(zero.amountUsd, 0);
  assert.equal(zero.kind, 'estimated_api_equivalent');
});

test('negative cost invalid', () => {
  assert.throws(
    () => mapRowCost(-1, VERSION),
    (err) => err.code === 'codeburn_schema_drift',
  );
});

test('aggregate known total and unknown count', () => {
  const claude = parseClaudeSessions(
    [
      {
        sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee77',
        provider: 'claude',
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cost: 1,
      },
    ],
    OBSERVED,
    VERSION,
  );
  const codexMissing = parseSessionsJsonArray(
    readFileSync(join(dir, 'fixtures/codeburn/synthetic-codex-missing-cost.json'), 'utf8'),
  );
  const codexParsed = parseCodexSessions(codexMissing, OBSERVED, VERSION);
  const agg = aggregateCosts([
    claude[0].snapshot.cost,
    codexParsed[0].snapshot.cost,
  ]);
  assert.equal(agg.knownTotalUsd, 1);
  assert.equal(agg.unknownCount, 1);
});

test('zero-token session still produces snapshot with known zero cost', () => {
  const parsed = parseClaudeSessions(
    [
      {
        sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee66',
        provider: 'claude',
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cost: 0,
      },
    ],
    OBSERVED,
    VERSION,
  );
  assert.equal(parsed[0].snapshot.cost.amountUsd, 0);
  assert.equal(parsed[0].snapshot.tokens.input, 0);
});
