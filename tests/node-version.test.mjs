import assert from 'node:assert/strict';
import { test } from 'vitest';
import { checkNodeVersion } from '../dist/node-version.js';

test('rejects Node 22.x', () => {
  const result = checkNodeVersion('v22.11.0');
  assert.equal(result.ok, false);
  assert.match(result.message, />= 24/);
});

test('rejects Node 23.x', () => {
  const result = checkNodeVersion('23.5.0');
  assert.equal(result.ok, false);
  assert.match(result.message, /not supported/);
});

test('accepts Node 24.0.0', () => {
  assert.deepEqual(checkNodeVersion('v24.0.0'), { ok: true });
});

test('accepts Node 26.x', () => {
  assert.deepEqual(checkNodeVersion('v26.11.0'), { ok: true });
});
