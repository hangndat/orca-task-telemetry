import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import {
  assertAllowlistedCodeburnArgv,
  assertSupportedCodeburnVersion,
  invokeCodeburn,
  parseSessionsJsonArray,
  readCodeburnVersion,
} from '../dist/codeburn/adapter.js';

const dir = dirname(fileURLToPath(import.meta.url));
const stub = resolve(dir, 'helpers/codeburn-stub.mjs');

test('allowlist permits version and sessions json', () => {
  assert.doesNotThrow(() => assertAllowlistedCodeburnArgv(['--version']));
  assert.doesNotThrow(() =>
    assertAllowlistedCodeburnArgv([
      'sessions',
      '--provider',
      'claude',
      '--period',
      'all',
      '--format',
      'json',
      '--no-pager',
    ]),
  );
});

test('deny export and sessions without json format', () => {
  assert.throws(
    () => assertAllowlistedCodeburnArgv(['export', '-f', 'json']),
    (err) => err.code === 'codeburn_command_denied',
  );
  assert.throws(
    () => assertAllowlistedCodeburnArgv(['sessions', '--provider', 'claude']),
    (err) => err.code === 'codeburn_command_denied',
  );
});

test('stub logs argv and empty array parses', async () => {
  const logDir = mkdtempSync(join(tmpdir(), 'cb-stub-'));
  const logFile = join(logDir, 'log.ndjson');
  process.env.CODEBURN_STUB_LOG_PATH = logFile;
  process.env.CODEBURN_STUB_STDOUT = '[]';
  await invokeCodeburn(
    [
      'sessions',
      '--provider',
      'codex',
      '--period',
      'all',
      '--format',
      'json',
      '--no-pager',
    ],
    { codeburnPath: stub },
  );
  const line = JSON.parse(readFileSync(logFile, 'utf8').trim());
  assert.equal(line.argv[0], 'sessions');
  assert.deepEqual(parseSessionsJsonArray('[]'), []);
  rmSync(logDir, { recursive: true, force: true });
  delete process.env.CODEBURN_STUB_LOG_PATH;
  delete process.env.CODEBURN_STUB_STDOUT;
});

test('unsupported version rejected', () => {
  assert.throws(
    () => assertSupportedCodeburnVersion('0.9.26'),
    (err) => err.code === 'codeburn_version_unsupported',
  );
});

test('readCodeburnVersion via stub', async () => {
  process.env.CODEBURN_STUB_STDOUT = '0.9.27\n';
  const v = await readCodeburnVersion({ codeburnPath: stub });
  assert.equal(v, '0.9.27');
  delete process.env.CODEBURN_STUB_STDOUT;
});

test('schema drift when stdout is not array', () => {
  assert.throws(
    () => parseSessionsJsonArray('{"sessions":[]}'),
    (err) => err.code === 'codeburn_schema_drift',
  );
});

test('optional live codeburn --version when available', async () => {
  const binary = process.env.ORCA_TELEMETRY_CODEBURN ?? 'codeburn';
  try {
    const v = await readCodeburnVersion({ codeburnPath: binary, timeoutMs: 15_000 });
    assert.equal(v, '0.9.27');
  } catch (err) {
    if (err.code !== 'codeburn_runtime_unavailable' && err.code !== 'codeburn_version_unsupported') {
      throw err;
    }
  }
});

test('missing binary surfaces codeburn_runtime_unavailable', async () => {
  await assert.rejects(
    () => invokeCodeburn(['--version'], { codeburnPath: '/no/such/codeburn' }),
    (err) => err.code === 'codeburn_runtime_unavailable',
  );
});

test('T22-SEC-F01: stub stderr secrets are not exposed on success result', async () => {
  const sentinel = 'LEAK_SENTINEL_TOKEN_codeburn_stub_test';
  process.env.CODEBURN_STUB_STDOUT = '[{"sessionId":"s1","provider":"claude"}]';
  process.env.CODEBURN_STUB_STDERR = `${sentinel}\n`;
  const result = await invokeCodeburn(
    [
      'sessions',
      '--provider',
      'claude',
      '--period',
      'all',
      '--format',
      'json',
      '--no-pager',
    ],
    { codeburnPath: stub },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, '');
  assert.ok(!JSON.stringify(result).includes(sentinel));
  assert.equal(parseSessionsJsonArray(result.stdout).length, 1);
  delete process.env.CODEBURN_STUB_STDOUT;
  delete process.env.CODEBURN_STUB_STDERR;
});

test('T22-SEC-F01: nonzero exit still discards stderr from public result', async () => {
  const sentinel = 'LEAK_SENTINEL_TOKEN_codeburn_exit_stderr';
  process.env.CODEBURN_STUB_STDOUT = 'not-json';
  process.env.CODEBURN_STUB_STDERR = `${sentinel}\n`;
  process.env.CODEBURN_STUB_EXIT_CODE = '1';
  const result = await invokeCodeburn(
    [
      'sessions',
      '--provider',
      'claude',
      '--period',
      'all',
      '--format',
      'json',
      '--no-pager',
    ],
    { codeburnPath: stub },
  );
  assert.equal(result.exitCode, 1);
  assert.equal(result.stderr, '');
  assert.ok(!JSON.stringify(result).includes(sentinel));
  assert.throws(
    () => parseSessionsJsonArray(result.stdout),
    (err) => err.code === 'codeburn_schema_drift',
  );
  assert.ok(!JSON.stringify({ code: 'codeburn_schema_drift' }).includes(sentinel));
  delete process.env.CODEBURN_STUB_STDOUT;
  delete process.env.CODEBURN_STUB_STDERR;
  delete process.env.CODEBURN_STUB_EXIT_CODE;
});

test('T22-SEC-F01: runtime errors use stable codes without subprocess stderr', async () => {
  const sentinel = 'LEAK_SENTINEL_TOKEN_codeburn_enoent';
  process.env.CODEBURN_STUB_STDERR = sentinel;
  await assert.rejects(
    () => invokeCodeburn(['--version'], { codeburnPath: '/no/such/codeburn' }),
    (err) => {
      assert.equal(err.code, 'codeburn_runtime_unavailable');
      assert.ok(!JSON.stringify(err).includes(sentinel));
      assert.ok(!err.message.includes(sentinel));
      return true;
    },
  );
  delete process.env.CODEBURN_STUB_STDERR;
});
