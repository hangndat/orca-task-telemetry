import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { sessionKey } from '../dist/contracts.js';
import { parseCountedSessions, parseClaudeSessions, parseCodexSessions } from '../dist/usage/sessions.js';
import { parseSessionsJsonArray } from '../dist/usage/adapter.js';

const dir = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(dir, 'fixtures/agent-top');
const OBSERVED = '2026-10-23T12:00:00.000Z';
const VERSION = '0.27.1';
const SHARED_RAW = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee01';

function loadSessionRows(path) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  return Array.isArray(parsed) ? parsed : [parsed];
}

test('sonnet fixture maps token buckets exactly', () => {
  const rows = loadSessionRows(join(fixtureDir, 'claude/session-sonnet-aggregated.json'));
  const parsed = parseCountedSessions(rows, OBSERVED, VERSION);
  assert.equal(parsed.length, 1);
  const snap = parsed[0].snapshot;
  assert.equal(snap.tokens.input, 32);
  assert.equal(snap.tokens.output, 4732);
  assert.equal(snap.tokens.cacheRead, 1252461);
  assert.equal(snap.tokens.cacheWrite, 48529);
  assert.equal(snap.sessionKey, sessionKey('claude', 'agent-top', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee01'));
});

test('subagent row is separate session from parent', () => {
  const rows = loadSessionRows(join(fixtureDir, 'claude/session-with-subagent-aggregated.json'));
  const parsed = parseCountedSessions(rows, OBSERVED, VERSION);
  assert.equal(parsed.length, 2);
  const parent = parsed.find((p) => p.session.rawId.endsWith('ee02'));
  const child = parsed.find((p) => p.session.rawId.startsWith('agent-'));
  assert.ok(parent);
  assert.ok(child);
  assert.equal(parent.snapshot.tokens.output, 6427481);
  assert.equal(child.snapshot.tokens.output, 44145);
  assert.notEqual(parent.snapshot.sessionKey, child.snapshot.sessionKey);
  assert.equal(child.metadata.parentSessionId, parent.session.rawId);
});

test('null model keeps unknown token allocation', () => {
  const rows = parseSessionsJsonArray(
    readFileSync(join(fixtureDir, 'synthetic-claude-null-model.json'), 'utf8'),
  );
  const parsed = parseClaudeSessions(rows, OBSERVED, VERSION);
  assert.equal(parsed[0].metadata.tokenAllocation, 'unknown');
  assert.equal(parsed[0].metadata.models, null);
});

test('schema drift reports field path', () => {
  const rows = parseSessionsJsonArray(
    readFileSync(join(fixtureDir, 'synthetic-schema-drift.json'), 'utf8'),
  );
  assert.throws(
    () => parseCountedSessions(rows, OBSERVED, VERSION),
    (err) => err.code === 'agent_top_schema_drift' && /input/.test(err.message),
  );
});

test('codex fixture maps buckets; reasoning null; cacheWrite zero', () => {
  const rows = loadSessionRows(join(fixtureDir, 'codex/session-gpt-small-aggregated.json'));
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
      harness: 'codex',
      session_id: SHARED_RAW,
      input: 1,
      output: 2,
      cache_read: 3,
      cache_write_5m: 0,
      cache_write_1h: 0,
      cache_write_unsplit: 0,
      cost_usd: 0,
      unpriced_tokens: 0,
    },
  ];
  const codexKey = parseCodexSessions(rows, OBSERVED, VERSION)[0].session.sessionKey;
  const claudeKey = sessionKey('claude', 'agent-top', SHARED_RAW);
  assert.notEqual(codexKey, claudeKey);
});

test('missing cost maps to unknown', () => {
  const rows = parseSessionsJsonArray(
    readFileSync(join(fixtureDir, 'synthetic-codex-missing-cost.json'), 'utf8'),
  );
  const parsed = parseCodexSessions(rows, OBSERVED, VERSION);
  assert.equal(parsed[0].snapshot.cost.kind, 'unknown');
  assert.equal(parsed[0].snapshot.cost.amountUsd, null);
});
