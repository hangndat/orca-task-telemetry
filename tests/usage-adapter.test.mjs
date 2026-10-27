import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import {
  assertAllowlistedAgentTopArgv,
  assertSupportedAgentTopVersion,
  COUNTED_SESSIONS_QUERY,
  invokeAgentTop,
  parseSessionsJsonArray,
  readAgentTopVersion,
} from '../dist/usage/adapter.js';

const dir = dirname(fileURLToPath(import.meta.url));
const stub = resolve(dir, 'helpers/agent-top-stub.mjs');

test('allowlist permits version and sql json', () => {
  assert.doesNotThrow(() => assertAllowlistedAgentTopArgv(['--version']));
  assert.doesNotThrow(() =>
    assertAllowlistedAgentTopArgv(['sql', '--json', COUNTED_SESSIONS_QUERY]),
  );
});

test('deny sync and sql without allowlisted query', () => {
  assert.throws(
    () => assertAllowlistedAgentTopArgv(['sync']),
    (err) => err.code === 'agent_top_command_denied',
  );
  assert.throws(
    () => assertAllowlistedAgentTopArgv(['sql', '--json', 'SELECT 1']),
    (err) => err.code === 'agent_top_command_denied',
  );
});

test('stub logs argv and empty array parses', async () => {
  const logDir = mkdtempSync(join(tmpdir(), 'at-stub-'));
  const logFile = join(logDir, 'log.ndjson');
  process.env.AGENT_TOP_STUB_LOG_PATH = logFile;
  process.env.AGENT_TOP_STUB_STDOUT = '[]';
  await invokeAgentTop(['sql', '--json', COUNTED_SESSIONS_QUERY], { agentTopPath: stub });
  const line = JSON.parse(readFileSync(logFile, 'utf8').trim());
  assert.equal(line.argv[0], 'sql');
  assert.deepEqual(parseSessionsJsonArray('[]'), []);
  rmSync(logDir, { recursive: true, force: true });
  delete process.env.AGENT_TOP_STUB_LOG_PATH;
  delete process.env.AGENT_TOP_STUB_STDOUT;
});

test('unsupported version rejected', () => {
  assert.throws(
    () => assertSupportedAgentTopVersion('0.27.0'),
    (err) => err.code === 'agent_top_version_unsupported',
  );
});

test('readAgentTopVersion via stub', async () => {
  process.env.AGENT_TOP_STUB_STDOUT = 'agent-top 0.27.1\n';
  const v = await readAgentTopVersion({ agentTopPath: stub });
  assert.equal(v, '0.27.1');
  delete process.env.AGENT_TOP_STUB_STDOUT;
});

test('schema drift when stdout is not array', () => {
  assert.throws(
    () => parseSessionsJsonArray('{"sessions":[]}'),
    (err) => err.code === 'agent_top_schema_drift',
  );
});

test('optional live agent-top --version when available', async () => {
  const binary = process.env.ORCA_TELEMETRY_AGENT_TOP ?? 'agent-top';
  try {
    const v = await readAgentTopVersion({ agentTopPath: binary, timeoutMs: 15_000 });
    assert.equal(v, '0.27.1');
  } catch (err) {
    if (err.code !== 'agent_top_runtime_unavailable' && err.code !== 'agent_top_version_unsupported') {
      throw err;
    }
  }
});

test('missing binary surfaces agent_top_runtime_unavailable', async () => {
  await assert.rejects(
    () => invokeAgentTop(['--version'], { agentTopPath: '/no/such/agent-top' }),
    (err) => err.code === 'agent_top_runtime_unavailable',
  );
});

test('stub stderr secrets are not exposed on success result', async () => {
  const sentinel = 'LEAK_SENTINEL_TOKEN_agent_top_stub_test';
  process.env.AGENT_TOP_STUB_STDOUT = '[{"harness":"claude","session_id":"s1"}]';
  process.env.AGENT_TOP_STUB_STDERR = `${sentinel}\n`;
  const result = await invokeAgentTop(['sql', '--json', COUNTED_SESSIONS_QUERY], {
    agentTopPath: stub,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, '');
  assert.ok(!JSON.stringify(result).includes(sentinel));
  assert.equal(parseSessionsJsonArray(result.stdout).length, 1);
  delete process.env.AGENT_TOP_STUB_STDOUT;
  delete process.env.AGENT_TOP_STUB_STDERR;
});

test('nonzero exit still discards stderr from public result', async () => {
  const sentinel = 'LEAK_SENTINEL_TOKEN_agent_top_exit_stderr';
  process.env.AGENT_TOP_STUB_STDOUT = 'not-json';
  process.env.AGENT_TOP_STUB_STDERR = `${sentinel}\n`;
  process.env.AGENT_TOP_STUB_EXIT_CODE = '1';
  const result = await invokeAgentTop(['sql', '--json', COUNTED_SESSIONS_QUERY], {
    agentTopPath: stub,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.stderr, '');
  assert.ok(!JSON.stringify(result).includes(sentinel));
  assert.throws(
    () => parseSessionsJsonArray(result.stdout),
    (err) => err.code === 'agent_top_schema_drift',
  );
  delete process.env.AGENT_TOP_STUB_STDOUT;
  delete process.env.AGENT_TOP_STUB_STDERR;
  delete process.env.AGENT_TOP_STUB_EXIT_CODE;
});

test('runtime errors use stable codes without subprocess stderr', async () => {
  const sentinel = 'LEAK_SENTINEL_TOKEN_agent_top_enoent';
  process.env.AGENT_TOP_STUB_STDERR = sentinel;
  await assert.rejects(
    () => invokeAgentTop(['--version'], { agentTopPath: '/no/such/agent-top' }),
    (err) => {
      assert.equal(err.code, 'agent_top_runtime_unavailable');
      assert.ok(!JSON.stringify(err).includes(sentinel));
      assert.ok(!err.message.includes(sentinel));
      return true;
    },
  );
  delete process.env.AGENT_TOP_STUB_STDERR;
});
