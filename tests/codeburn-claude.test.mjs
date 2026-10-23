import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { sessionKey } from '../dist/contracts.js';
import { parseClaudeSessions } from '../dist/codeburn/claude.js';
import { parseSessionsJsonArray } from '../dist/codeburn/adapter.js';

const dir = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(dir, 'fixtures/codeburn/claude');
const synthDir = join(dir, 'fixtures/codeburn');
const OBSERVED = '2026-10-23T12:00:00.000Z';
const VERSION = '0.9.27';

function loadSessionRows(path) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  return Array.isArray(parsed) ? parsed : [parsed];
}

test('sonnet fixture maps token buckets exactly', () => {
  const rows = loadSessionRows(join(fixtureDir, 'session-sonnet-aggregated.json'));
  const parsed = parseClaudeSessions(rows, OBSERVED, VERSION);
  assert.equal(parsed.length, 1);
  const snap = parsed[0].snapshot;
  assert.equal(snap.tokens.input, 32);
  assert.equal(snap.tokens.output, 4732);
  assert.equal(snap.tokens.cacheRead, 1252461);
  assert.equal(snap.tokens.cacheWrite, 48529);
  assert.equal(snap.sessionKey, sessionKey('claude', 'codeburn', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee01'));
});

test('subagent is separate session from parent', () => {
  const rows = loadSessionRows(join(fixtureDir, 'session-with-subagent-aggregated.json'));
  const parsed = parseClaudeSessions(rows, OBSERVED, VERSION);
  assert.equal(parsed.length, 2);
  const parent = parsed.find((p) => p.session.rawId.endsWith('ee02'));
  const child = parsed.find((p) => p.session.rawId.startsWith('agent-'));
  assert.ok(parent);
  assert.ok(child);
  assert.equal(parent.snapshot.tokens.output, 6427481);
  assert.equal(child.snapshot.tokens.output, 44145);
  assert.notEqual(parent.snapshot.sessionKey, child.snapshot.sessionKey);
});

test('multi-model row keeps unknown token allocation metadata', () => {
  const rows = parseSessionsJsonArray(
    readFileSync(join(synthDir, 'synthetic-claude-mixed-models.json'), 'utf8'),
  );
  const parsed = parseClaudeSessions(rows, OBSERVED, VERSION);
  assert.equal(parsed[0].metadata.tokenAllocation, 'unknown');
  assert.equal(parsed[0].metadata.models?.length, 2);
});

test('schema drift reports field path', () => {
  const rows = parseSessionsJsonArray(
    readFileSync(join(synthDir, 'synthetic-schema-drift.json'), 'utf8'),
  );
  assert.throws(
    () => parseClaudeSessions(rows, OBSERVED, VERSION),
    (err) => err.code === 'codeburn_schema_drift' && /inputTokens/.test(err.message),
  );
});
