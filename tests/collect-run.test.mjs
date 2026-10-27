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

const here = dirname(fileURLToPath(import.meta.url));
const reply = (result, exitCode = 0) => ({ stdout: JSON.stringify({ ok: exitCode === 0, result }),
  stderr: '', exitCode });

test('failed Dispatch read leaves Run partial without trusting a worker row', async () => {
  const calls = [];
  const provenance = await collectOrcaRunProvenance('run_A', {
    sourceHostId: 'local', readVersion: async () => '1.4.241',
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

test('explicit Run reads bounded metadata but records no unverified local host provenance', async () => {
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
    writeFileSync(stub, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('1.4.241'); process.exit(0); }
if (args[0] === 'status' && process.env.ORCA_STUB_MALFORMED_STATUS === '1') {
  console.log('SECRET_STATUS_STDOUT_FROM_CLI');
  console.error('SECRET_STATUS_STDERR_FROM_CLI');
  process.exit(0);
}
const command = args[1];
let result;
if (args[0] === 'status') result = { target: { kind: 'local' }, runtime: { reachable: true } };
else if (command === 'run-show') result = { run: { id: 'run_A', coordinator_handle: null, objective: 'SECRET' } };
else if (command === 'task-list') result = { count: 1, tasks: [{ id: 'task_1', run_id: 'run_A', parent_id: null, spec: 'SECRET' }] };
else if (command === 'dispatch-show') result = { dispatch: { id: 'ctx_1', run_id: 'run_A', task_id: 'task_1', host_scope: JSON.stringify({ hostId: 'local' }), preview: 'SECRET' } };
else if (command === 'worker-list') result = { scope: { run: 'run_A', source: 'flag' }, page: { limit: 100, total: 1, hasMore: false, nextCursor: null }, workers: [{ dispatchId: 'ctx_1', taskId: 'task_1', runId: 'run_A', projection: { dispatchId: 'ctx_1', taskId: 'task_1', runId: 'run_A', host: { id: 'local' } }, resource: { worktreeId: null, preview: 'SECRET' } }] };
else process.exit(3);
console.log(JSON.stringify({ ok: true, result }));
`);
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
      assert.equal(result.exitCode, 5);
      const orca = result.sources.find((source) => source.source === 'orca');
      assert.equal(orca.status, 'partial');
      assert.equal(orca.error.code, 'orca_source_host_unverified');
      assert.deepEqual(orca.counts, { runs: 1, tasks: 1, dispatches: 1, workers: 1, pages: 1 });
      assert.equal(result.sources.find((source) => source.source === 'agent-top').status, 'ok');
      assert.ok(!JSON.stringify(result).includes('SECRET'));
      process.env.ORCA_STUB_MALFORMED_STATUS = '1';
      const jsonOutput = await runCollect(['--run', 'run_A'], { json: true, cwd: repo });
      assert.equal(jsonOutput.exitCode, 5);
      const malformedOrca = jsonOutput.data.sources.find((source) => source.source === 'orca');
      assert.equal(malformedOrca.status, 'partial');
      assert.deepEqual(malformedOrca.error, {
        code: 'collect_source_error', message: 'Orca status returned invalid JSON.',
      });
      assert.ok(!JSON.stringify(jsonOutput).includes('SECRET_STATUS_'));
      const textOutput = await runCollect(['--run', 'run_A'], { json: false, cwd: repo });
      assert.equal(textOutput.exitCode, 5);
      let rendered = '';
      const originalWrite = process.stdout.write;
      process.stdout.write = (chunk) => { rendered += chunk; return true; };
      try { textOutput.write(); } finally { process.stdout.write = originalWrite; }
      assert.match(rendered, /orca: partial collect_source_error — Orca status returned invalid JSON\./);
      assert.ok(!rendered.includes('SECRET_STATUS_'));
      const db = openTelemetryDatabase({ dbPath: join(home, 'telemetry.sqlite') });
      for (const table of ['orca_runs', 'orca_tasks', 'orca_dispatches', 'scoped_executions']) {
        assert.equal(db.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
      }
      assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM collection_attempts WHERE source = 'orca'").get().n, 0);
      assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM collection_attempts WHERE source = 'agent-top'").get().n, 6);
      db.close();
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
});
