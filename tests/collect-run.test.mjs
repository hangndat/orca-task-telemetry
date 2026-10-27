import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { runCollectCommand, runCollect } from '../dist/commands/collect.js';
import { emptyConfig, saveConfig } from '../dist/config.js';
import { openTelemetryDatabase } from '../dist/db/index.js';
import { upsertProfile } from '../dist/profiles.js';
import { collectOrcaRunProvenance } from '../dist/orca/run-provenance.js';
import {
  persistOrcaRunProvenance,
  scopedExecutionKey,
} from '../dist/db/run-provenance.js';
import { storageHostIdForRuntime } from '../dist/orca/source-host.js';

const here = dirname(fileURLToPath(import.meta.url));
const RUNTIME_A = '11111111-1111-4111-8111-111111111111';
const RUNTIME_B = '22222222-2222-4222-8222-222222222222';
const reply = (result, exitCode = 0, runtimeId = RUNTIME_A) => ({
  stdout: JSON.stringify({ ok: exitCode === 0, result, _meta: { runtimeId } }),
  stderr: '',
  exitCode,
});

test('failed Dispatch read leaves Run partial without trusting a worker row', async () => {
  const calls = [];
  const provenance = await collectOrcaRunProvenance('run_A', {
    sourceHostId: 'local', readVersion: async () => '1.4.241',
    expectedRuntimeId: RUNTIME_A,
    invoke: async (argv) => {
      calls.push(argv);
      if (argv[1] === 'run-show') return reply({ run: { id: 'run_A' } });
      if (argv[1] === 'task-list') return reply({ count: 1, tasks: [
        { id: 'task_1', run_id: 'run_A', parent_id: null, spec: 'SECRET' }] });
      if (argv[1] === 'dispatch-show') return reply(null, 1);
      return reply({ scope: { run: 'run_A', source: 'flag' }, workers: [],
        page: { limit: 100, total: 0, hasMore: false, nextCursor: null } });
    },
  });
  assert.equal(provenance.complete, false);
  assert.equal(provenance.dispatches.length, 0);
  assert.ok(provenance.errors.some((error) => error.source === 'dispatch-show' && error.code === 'source_failure'));
  assert.ok(!JSON.stringify(provenance).includes('SECRET'));
  assert.ok(calls.every((argv) => !argv.includes('--preamble')));
});

test('advertised worker total over 10000 stops after one bounded page', async () => {
  let pages = 0;
  const provenance = await collectOrcaRunProvenance('run_A', {
    sourceHostId: 'local', readVersion: async () => '1.4.241',
    expectedRuntimeId: RUNTIME_A,
    invoke: async (argv) => {
      if (argv[1] === 'run-show') return reply({ run: { id: 'run_A' } });
      if (argv[1] === 'task-list') return reply({ count: 0, tasks: [] });
      pages += 1;
      return reply({ scope: { run: 'run_A', source: 'flag' }, workers: [],
        page: { limit: 100, total: 10001, hasMore: true, nextCursor: 'more' } });
    },
  });
  assert.equal(pages, 1);
  assert.equal(provenance.complete, false);
  assert.ok(provenance.errors.some((error) => error.code === 'row_limit'));
});

test('endpoint runtimeId mismatch mid-collect marks provenance incomplete', async () => {
  const provenance = await collectOrcaRunProvenance('run_A', {
    sourceHostId: 'local', readVersion: async () => '1.4.241',
    expectedRuntimeId: RUNTIME_A,
    invoke: async (argv) => {
      if (argv[1] === 'run-show') return reply({ run: { id: 'run_A' } }, 0, RUNTIME_B);
      if (argv[1] === 'task-list') return reply({ count: 0, tasks: [] });
      return reply({ scope: { run: 'run_A', source: 'flag' }, workers: [],
        page: { limit: 100, total: 0, hasMore: false, nextCursor: null } });
    },
  });
  assert.equal(provenance.complete, false);
  assert.ok(provenance.errors.some((e) => e.code === 'endpoint_changed'));
});

test('persistOrcaRunProvenance keeps two runtime hosts isolated for the same run id', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-host-collision-'));
  try {
    const handle = openTelemetryDatabase({ dbPath: join(dir, 'telemetry.sqlite') });
    const payload = {
      runId: 'run_A',
      observedAt: '2026-10-27T00:00:00.000Z',
      sourceVersion: '1.4.241',
      tasks: [{ taskId: 'task_1', parentTaskId: null, status: null }],
      dispatches: [{
        dispatchId: 'ctx_1', taskId: 'task_1',
        creatorOrcaSessionId: null, creatorDispatchId: null,
        retryOfDispatchId: null, assigneeOrcaSessionId: null, status: null,
      }],
    };
    const hostA = storageHostIdForRuntime(RUNTIME_A);
    const hostB = storageHostIdForRuntime(RUNTIME_B);
    persistOrcaRunProvenance(handle.db, { ...payload, hostId: hostA });
    persistOrcaRunProvenance(handle.db, { ...payload, hostId: hostB });
    assert.equal(handle.db.prepare('SELECT COUNT(*) AS n FROM orca_runs').get().n, 2);
    assert.equal(
      handle.db.prepare('SELECT COUNT(*) AS n FROM scoped_executions').get().n,
      2,
    );
    assert.notEqual(
      scopedExecutionKey(hostA, 'run_A', 'ctx_1'),
      scopedExecutionKey(hostB, 'run_A', 'ctx_1'),
    );
    handle.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeOrcaStub(stubPath, { runtimeId = RUNTIME_A, malformedStatus = false } = {}) {
  writeFileSync(stubPath, `#!/usr/bin/env node
const args = process.argv.slice(2);
const runtimeId = ${JSON.stringify(runtimeId)};
const envelope = (result) => JSON.stringify({ ok: true, result, _meta: { runtimeId } });
if (args[0] === '--version') { console.log('1.4.241'); process.exit(0); }
if (args[0] === 'status' && process.env.ORCA_STUB_MALFORMED_STATUS === '1') {
  console.log('SECRET_STATUS_STDOUT_FROM_CLI');
  console.error('SECRET_STATUS_STDERR_FROM_CLI');
  process.exit(0);
}
if (args[0] === 'status') {
  console.log(envelope({
    target: { kind: 'local' },
    runtime: { reachable: true, runtimeId },
  }));
  process.exit(0);
}
if (args[0] === 'host' && args[1] === 'list') {
  console.log(envelope({
    hosts: [{ kind: 'local', id: 'local', name: 'this machine', machineName: 'box', platform: 'darwin' }],
  }));
  process.exit(0);
}
const command = args[1];
let result;
if (command === 'run-show') result = { run: { id: 'run_A', coordinator_handle: null, objective: 'SECRET' } };
else if (command === 'task-list') result = { count: 1, tasks: [{ id: 'task_1', run_id: 'run_A', parent_id: null, spec: 'SECRET' }] };
else if (command === 'dispatch-show') result = { dispatch: { id: 'ctx_1', run_id: 'run_A', task_id: 'task_1', host_scope: JSON.stringify({ hostId: 'local' }), preview: 'SECRET' } };
else if (command === 'worker-list') result = { scope: { run: 'run_A', source: 'flag' }, page: { limit: 100, total: 1, hasMore: false, nextCursor: null }, workers: [{ dispatchId: 'ctx_1', taskId: 'task_1', runId: 'run_A', projection: { dispatchId: 'ctx_1', taskId: 'task_1', runId: 'run_A', host: { id: 'local' } }, resource: { worktreeId: null, preview: 'SECRET' } }] };
else process.exit(3);
console.log(envelope(result));
`);
  void malformedStatus;
}

test('explicit Run persists scoped provenance under runtime endpoint host id', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'orca-run-repo-'));
  const home = mkdtempSync(join(tmpdir(), 'orca-run-home-'));
  try {
    execFileSync('git', ['init'], { cwd: repo });
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/o/r.git'], { cwd: repo });
    mkdirSync(home, { recursive: true });
    const { config } = upsertProfile(emptyConfig(), {
      id: 'R_collect', nameWithOwner: 'o/r', url: 'https://github.com/o/r',
    }, {
      id: 'PVT_kwHOAGoDWs4BoZ5m', number: 1, title: 'P',
      url: 'https://github.com/users/o/projects/1', closed: false,
      owner: { kind: 'user', login: 'o' }, sources: ['repository'],
    });
    saveConfig(home, config);
    const stub = join(home, 'orca-run-stub.mjs');
    writeOrcaStub(stub, { runtimeId: RUNTIME_A });
    const expectedHost = storageHostIdForRuntime(RUNTIME_A);
    const overlay = {
      ORCA_TELEMETRY_HOME: home,
      ORCA_TELEMETRY_GH: resolve(here, 'helpers/integration-stubs/gh-collect.mjs'),
      GH_STUB_REPO_VIEW_JSON: JSON.stringify({ id: 'R_collect', nameWithOwner: 'o/r', url: 'https://github.com/o/r' }),
      GH_STUB_PAGE1_PATH: resolve(here, 'fixtures/github/project-items-page1.json'),
      GH_STUB_PAGE2_PATH: resolve(here, 'fixtures/github/project-items-page2.json'),
      ORCA_TELEMETRY_ORCA: stub,
      ORCA_STUB_MALFORMED_STATUS: '0',
      ORCA_TELEMETRY_AGENT_TOP: resolve(here, 'helpers/integration-stubs/agent-top-router.mjs'),
      AGENT_TOP_STUB_CLAUDE_PATH: resolve(here, 'fixtures/agent-top/claude/session-sonnet-aggregated.json'),
      AGENT_TOP_STUB_CODEX_PATH: resolve(here, 'fixtures/agent-top/codex/session-gpt-small-aggregated.json'),
    };
    const saved = Object.fromEntries(Object.keys(overlay).map((key) => [key, process.env[key]]));
    Object.assign(process.env, overlay);
    try {
      const result = await runCollectCommand({ cwd: repo, runId: 'run_A' });
      assert.equal(result.exitCode, 0);
      const orca = result.sources.find((source) => source.source === 'orca');
      assert.equal(orca.status, 'ok');
      assert.equal(orca.hostId, expectedHost);
      assert.deepEqual(orca.counts, { runs: 1, tasks: 1, dispatches: 1, workers: 1, pages: 1 });
      assert.equal(result.sources.find((source) => source.source === 'agent-top').status, 'ok');
      assert.ok(!JSON.stringify(result).includes('SECRET'));

      const db = openTelemetryDatabase({ dbPath: join(home, 'telemetry.sqlite') });
      assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM orca_runs').get().n, 1);
      assert.equal(db.db.prepare('SELECT host_id FROM orca_runs').get().host_id, expectedHost);
      assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM orca_tasks').get().n, 1);
      assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM orca_dispatches').get().n, 1);
      assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM scoped_executions').get().n, 1);
      assert.equal(
        db.db.prepare("SELECT COUNT(*) AS n FROM collection_attempts WHERE source = 'orca' AND status = 'success'").get().n,
        1,
      );
      assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM collection_attempts WHERE source = 'agent-top'").get().n, 3);
      db.close();

      // Idempotent re-collect keeps one scoped row.
      const again = await runCollectCommand({ cwd: repo, runId: 'run_A' });
      assert.equal(again.exitCode, 0);
      const db2 = openTelemetryDatabase({ dbPath: join(home, 'telemetry.sqlite') });
      assert.equal(db2.db.prepare('SELECT COUNT(*) AS n FROM scoped_executions').get().n, 1);
      assert.equal(
        db2.db.prepare("SELECT COUNT(*) AS n FROM collection_attempts WHERE source = 'orca' AND status = 'success'").get().n,
        2,
      );
      db2.close();

      process.env.ORCA_STUB_MALFORMED_STATUS = '1';
      const jsonOutput = await runCollect(['--run', 'run_A'], { json: true, cwd: repo });
      assert.equal(jsonOutput.exitCode, 5);
      const malformedOrca = jsonOutput.data.sources.find((source) => source.source === 'orca');
      assert.equal(malformedOrca.status, 'partial');
      assert.deepEqual(malformedOrca.error, {
        code: 'collect_source_error', message: 'Orca status returned invalid JSON.',
      });
      assert.ok(!JSON.stringify(jsonOutput).includes('SECRET_STATUS_'));
      await assert.rejects(() => runCollect(['--run'], { json: true, cwd: repo }), (error) => error.code === 'usage_error');
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);
