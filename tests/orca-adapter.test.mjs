import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import {
  assertAllowlistedOrcaArgv,
  assertRuntimeReachable,
  assertSupportedOrcaVersion,
  classifyOrcaArgv,
  invokeOrcaReadOnly,
  parseOrcaVersionText,
  readOrcaVersion,
} from '../dist/orca/adapter.js';

const dir = dirname(fileURLToPath(import.meta.url));
const stub = resolve(dir, 'helpers/orca-stub.mjs');

test('allowlist accepts verified read-only commands', () => {
  assert.equal(classifyOrcaArgv(['--version']), 'version');
  assert.equal(classifyOrcaArgv(['orchestration', 'worker-list', '--json']), 'orchestration:worker-list');
  assert.doesNotThrow(() =>
    assertAllowlistedOrcaArgv(['orchestration', 'dispatch-show', '--task', 'task_x', '--json']),
  );
});

test('deny-before-spawn blocks orchestration send and worktree rm', () => {
  assert.throws(
    () => assertAllowlistedOrcaArgv(['orchestration', 'send', '--type', 'heartbeat']),
    (err) => err.code === 'orca_command_denied',
  );
  assert.throws(
    () => assertAllowlistedOrcaArgv(['worktree', 'rm', '--worktree', 'x']),
    (err) => err.code === 'orca_command_denied',
  );
  assert.throws(
    () => assertAllowlistedOrcaArgv(['orchestration', 'dispatch-show', '--preamble']),
    (err) => err.code === 'orca_command_denied',
  );
});

test('stub invocation log records argv for allowlisted call', async () => {
  const log = mkdtempSync(join(tmpdir(), 'orca-stub-log-'));
  const logFile = join(log, 'invocations.ndjson');
  process.env.ORCA_STUB_LOG_PATH = logFile;
  process.env.ORCA_STUB_STDOUT = '{"ok":true}\n';
  const result = await invokeOrcaReadOnly(
    ['orchestration', 'worker-list', '--json', '--run', 'run_test'],
    { orcaPath: stub, timeoutMs: 5_000 },
  );
  const lines = readFileSync(logFile, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.deepEqual(entry.argv, [
    'orchestration',
    'worker-list',
    '--json',
    '--run',
    'run_test',
  ]);
  assert.equal(result.exitCode, 0);
  rmSync(log, { recursive: true, force: true });
  delete process.env.ORCA_STUB_LOG_PATH;
  delete process.env.ORCA_STUB_STDOUT;
});

test('only verified Orca build 1.4.241 is accepted', () => {
  assert.equal(parseOrcaVersionText('1.4.241\n'), '1.4.241');
  assert.throws(
    () => assertSupportedOrcaVersion('1.3.0'),
    (err) => err.code === 'orca_version_unsupported',
  );
  assert.throws(
    () => assertSupportedOrcaVersion('1.4.100'),
    (err) => err.code === 'orca_version_unsupported',
  );
  assert.throws(
    () => assertSupportedOrcaVersion('1.4.238'),
    (err) => err.code === 'orca_version_unsupported',
  );
  assert.doesNotThrow(() => assertSupportedOrcaVersion('1.4.241'));
});

test('required selectors validated before spawn', () => {
  assert.throws(
    () => assertAllowlistedOrcaArgv(['worktree', 'show', '--json']),
    (err) => err.code === 'orca_command_denied',
  );
  assert.throws(
    () => assertAllowlistedOrcaArgv(['worktree', 'show', '--worktree', '', '--json']),
    (err) => err.code === 'orca_command_denied',
  );
  assert.throws(
    () => assertAllowlistedOrcaArgv(['worktree', 'show', '--worktree', '--json']),
    (err) => err.code === 'orca_command_denied',
  );
  assert.throws(
    () => assertAllowlistedOrcaArgv(['orchestration', 'dispatch-show', '--json']),
    (err) => err.code === 'orca_command_denied',
  );
  assert.doesNotThrow(() =>
    assertAllowlistedOrcaArgv(['worktree', 'list', '--json']),
  );
  assert.doesNotThrow(() =>
    assertAllowlistedOrcaArgv(['orchestration', 'worker-list', '--json']),
  );
});

test('deny-before-spawn leaves stub invocation log empty for missing selector', async () => {
  const log = mkdtempSync(join(tmpdir(), 'orca-stub-log-'));
  const logFile = join(log, 'invocations.ndjson');
  process.env.ORCA_STUB_LOG_PATH = logFile;
  await assert.rejects(
    () =>
      invokeOrcaReadOnly(['worktree', 'show', '--json'], {
        orcaPath: stub,
        timeoutMs: 5_000,
      }),
    (err) => err.code === 'orca_command_denied',
  );
  assert.throws(() => readFileSync(logFile, 'utf8'), { code: 'ENOENT' });
  rmSync(log, { recursive: true, force: true });
  delete process.env.ORCA_STUB_LOG_PATH;
});

test('stub stderr secrets are not exposed on result', async () => {
  const sentinel = 'LEAK_SENTINEL_TOKEN_orca_stub_test';
  process.env.ORCA_STUB_STDOUT = '{"ok":true}\n';
  process.env.ORCA_STUB_STDERR = `${sentinel}\n`;
  const result = await invokeOrcaReadOnly(['status', '--json'], {
    orcaPath: stub,
    timeoutMs: 5_000,
  });
  assert.equal(result.stderr, '');
  assert.ok(!JSON.stringify(result).includes(sentinel));
  delete process.env.ORCA_STUB_STDOUT;
  delete process.env.ORCA_STUB_STDERR;
});

test('readOrcaVersion uses stub stdout', async () => {
  process.env.ORCA_STUB_STDOUT = '1.4.241\n';
  const version = await readOrcaVersion({ orcaPath: stub });
  assert.equal(version, '1.4.241');
  delete process.env.ORCA_STUB_STDOUT;
});

test('missing binary surfaces orca_runtime_unavailable', async () => {
  await assert.rejects(
    () => invokeOrcaReadOnly(['--version'], { orcaPath: '/no/such/orca-binary' }),
    (err) => err.code === 'orca_runtime_unavailable',
  );
});

test('status schema drift and unreachable runtime', () => {
  assert.throws(
    () => assertRuntimeReachable({ ok: true, result: { runtime: { reachable: false } } }),
    (err) => err.code === 'orca_runtime_unavailable',
  );
  assert.throws(
    () => assertRuntimeReachable({ ok: true }),
    (err) => err.code === 'orca_schema_drift',
  );
  assert.doesNotThrow(() =>
    assertRuntimeReachable({
      ok: true,
      result: { runtime: { reachable: true, state: 'ready' } },
    }),
  );
});

test('optional live orca --version when binary available', async () => {
  const binary = process.env.ORCA_TELEMETRY_ORCA ?? 'orca';
  try {
    const version = await readOrcaVersion({ orcaPath: binary, timeoutMs: 10_000 });
    assert.equal(version, '1.4.241');
  } catch (err) {
    if (err.code !== 'orca_runtime_unavailable' && err.code !== 'orca_version_unsupported') {
      throw err;
    }
  }
});
