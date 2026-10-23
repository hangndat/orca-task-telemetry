import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { sessionKey } from '../dist/contracts.js';
import { parseCodexSessions } from '../dist/codeburn/codex.js';
import { parseSessionsJsonArray } from '../dist/codeburn/adapter.js';

const dir = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(dir, 'fixtures/codeburn/codex');
const synthDir = join(dir, 'fixtures/codeburn');
const OBSERVED = '2026-10-23T12:00:00.000Z';
const VERSION = '0.9.27';

const SHARED_RAW = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee01';

test('codex fixture maps buckets; reasoning null; cacheWrite zero', () => {
  const parsedFile = JSON.parse(
    readFileSync(join(fixtureDir, 'session-gpt-small-aggregated.json'), 'utf8'),
  );
  const rows = Array.isArray(parsedFile) ? parsedFile : [parsedFile];
  const parsed = parseCodexSessions(rows, OBSERVED, VERSION);
  assert.equal(parsed.length, 1);
  const snap = parsed[0].snapshot;
  assert.equal(snap.tokens.input, 51600);
  assert.equal(snap.tokens.cacheRead, 661504);
  assert.equal(snap.tokens.cacheWrite, 0);
  assert.equal(snap.tokens.reasoning, null);
});

test('same rawId as claude yields different sessionKey', () => {
  const rows = [
    {
      sessionId: SHARED_RAW,
      provider: 'codex',
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: 0,
      cost: 0,
    },
  ];
  const codexKey = parseCodexSessions(rows, OBSERVED, VERSION)[0].session.sessionKey;
  const claudeKey = sessionKey('claude', 'codeburn', SHARED_RAW);
  assert.notEqual(codexKey, claudeKey);
});

test('missing cost maps to unknown', () => {
  const rows = parseSessionsJsonArray(
    readFileSync(join(synthDir, 'synthetic-codex-missing-cost.json'), 'utf8'),
  );
  const parsed = parseCodexSessions(rows, OBSERVED, VERSION);
  assert.equal(parsed[0].snapshot.cost.kind, 'unknown');
  assert.equal(parsed[0].snapshot.cost.amountUsd, null);
});
