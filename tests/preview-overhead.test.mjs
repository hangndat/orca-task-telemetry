import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { buildOverheadPreview, formatOverheadPreviewText, parseRolesFile } from '../dist/reports/overhead-preview.js';
import { parseClaudeSessions } from '../dist/codeburn/claude.js';
import { parseCodexSessions } from '../dist/codeburn/codex.js';

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, '../dist/cli.js');
const fx = (name) => JSON.parse(readFileSync(resolve(here, 'fixtures/codeburn', name), 'utf8'));
const COORD = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee02';
const SUB = 'agent-0000000000000001';
const CODEX = '01a10000-bbbb-4ccc-8ddd-eeeeeeeeee01';

const ORCA_STUB = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('1.4.237'); process.exit(0); }
const two = process.env.STUB_TWO_TASKS === '1';
const host = { hostId: 'local' };
const command = args[1];
let result;
if (args[0] === 'status') result = { target: { kind: 'local' }, runtime: { reachable: true } };
else if (command === 'run-show') result = { run: { id: 'run_A', objective: 'SECRET_SPEC' } };
else if (command === 'task-list') {
  const tasks = [{ id: 'task_1', run_id: 'run_A', parent_id: null, spec: 'SECRET_SPEC' }];
  if (two) tasks.push({ id: 'task_2', run_id: 'run_A', parent_id: null });
  result = { count: tasks.length, tasks };
} else if (command === 'dispatch-show') {
  const task = args[args.indexOf('--task') + 1];
  if (task === 'task_2') process.exit(1);
  result = { dispatch: { id: 'ctx_1', run_id: 'run_A', task_id: 'task_1', host_scope: JSON.stringify(host), preview: 'SECRET_SPEC' } };
} else if (command === 'worker-list') {
  result = { scope: { run: 'run_A', source: 'flag' }, page: { limit: 100, total: 1, hasMore: false, nextCursor: null },
    workers: [{ dispatchId: 'ctx_1', taskId: 'task_1', runId: 'run_A',
      projection: { dispatchId: 'ctx_1', taskId: 'task_1', runId: 'run_A', host: { id: 'local' } }, resource: { worktreeId: null } }] };
} else process.exit(3);
console.log(JSON.stringify({ ok: true, result }));
`;

function harness(roles, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'orca-preview-'));
  const home = join(dir, 'home');
  const orca = join(dir, 'orca-stub.mjs');
  const rolesPath = join(dir, 'roles.json');
  writeFileSync(orca, ORCA_STUB);
  writeFileSync(rolesPath, typeof roles === 'string' ? roles : JSON.stringify(roles));
  const result = spawnSync(process.execPath, [cli, 'preview', 'overhead', '--run', env.PREVIEW_RUN ?? 'run_A', '--roles', rolesPath, '--json'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ORCA_TELEMETRY_HOME: home,
      ORCA_TELEMETRY_ORCA: orca,
      ORCA_TELEMETRY_CODEBURN: resolve(here, 'helpers/integration-stubs/codeburn-router.mjs'),
      CODEBURN_STUB_CLAUDE_PATH: resolve(here, 'fixtures/codeburn/claude/session-with-subagent-aggregated.json'),
      CODEBURN_STUB_CODEX_PATH: resolve(here, 'fixtures/codeburn/codex/session-gpt-small-aggregated.json'),
      ...env,
    },
  });
  const out = {
    status: result.status, stdout: result.stdout, stderr: result.stderr, homeExists: existsSync(home),
    json: result.stdout.trim() ? JSON.parse(result.stdout) : null,
  };
  rmSync(dir, { recursive: true, force: true });
  return out;
}

const roles = (entries, runId = 'run_A') => ({ schemaVersion: 1, runId, entries });
const coord = { role: 'coordinator', provider: 'claude', sessionId: COORD };
const claudeWorker = { role: 'worker', provider: 'claude', sessionId: SUB, dispatchId: 'ctx_1' };
const codexWorker = { role: 'worker', provider: 'codex', sessionId: CODEX, dispatchId: 'ctx_1' };

test('valid mapping previews selected totals, provider semantics, and writes nothing', () => {
  const r = harness(roles([coord, claudeWorker, codexWorker]));
  assert.equal(r.status, 0, r.stderr);
  const d = r.json.data;
  assert.equal(d.kind, 'overhead-preview');
  assert.equal(d.mode, 'manual_preview');
  assert.equal(d.persisted, false);
  assert.equal(d.status, 'preview');
  assert.equal(d.coverage, 'unknown');
  assert.equal(d.counts.resolved, 3);
  assert.deepEqual(d.entries.map((entry) => entry.entryIndex), [0, 1, 2]);
  assert.ok(d.entries.every((entry) => entry.verification === 'operator_supplied_unverified'));
  assert.ok(d.entries.every((entry) => !Object.hasOwn(entry, 'sessionId')));
  assert.equal(d.coordinator.costUsd, 1080.8294712500003);
  assert.equal(d.workers.sessionCount, 2);
  assert.equal(d.workers.dispatchCount, 1);
  assert.equal(d.workers.costUsd, 7.280918999999999 + 0.18975039999999999);
  const codex = d.workers.byProvider.find((p) => p.provider === 'codex');
  assert.equal(codex.tokens.reasoning, null);
  const claude = d.workers.byProvider.find((p) => p.provider === 'claude');
  assert.equal(claude.tokens.input, 66);
  assert.deepEqual(claude.knownTokens, claude.tokens);
  assert.equal(claude.tokens.reasoning, null);
  assert.equal(typeof d.selectedOverheadShare.value, 'number');
  assert.deepEqual(d.runWideOverheadShare, { value: null, unknownReason: 'coverage_unknown' });
  assert.equal(r.homeExists, false, 'preview must not create the telemetry home/DB');
  assert.ok(!r.stdout.includes('SECRET'));
  assert.ok(!r.stdout.includes('PROJECT_SLUG') && !r.stdout.includes('Opus'));
  for (const rawId of [COORD, SUB, CODEX]) assert.ok(!r.stdout.includes(rawId));
});

test('roles file binds coordinator mappings to the exact selected Run', () => {
  const mismatch = harness(roles([coord], 'run_other'));
  assert.equal(mismatch.status, 2);
  assert.equal(mismatch.json.error.code, 'preview_roles_run_mismatch');
  assert.ok(!mismatch.stdout.includes(COORD));
  const replay = harness(roles([coord]), { PREVIEW_RUN: 'run_other' });
  assert.equal(replay.status, 2);
  assert.equal(replay.json.error.code, 'preview_roles_run_mismatch');
  const absent = harness({ schemaVersion: 1, entries: [coord] });
  assert.equal(absent.json.error.code, 'preview_roles_invalid');
});

test('missing Dispatch for another Task keeps verified mappings but status partial', () => {
  const r = harness(roles([coord, claudeWorker]), { STUB_TWO_TASKS: '1' });
  assert.equal(r.status, 0, r.stderr);
  const d = r.json.data;
  assert.equal(d.status, 'partial');
  assert.equal(d.orca.complete, false);
  assert.ok(d.orca.errors.some((e) => e.source === 'dispatch-show' && e.code === 'source_failure'));
  assert.equal(d.counts.resolved, 2);
  assert.equal(d.runWideOverheadShare.value, null);
  assert.equal(d.coverage, 'unknown');
});

test('worker mapping to a Dispatch outside the Run fails closed', () => {
  const r = harness(roles([coord, { ...claudeWorker, dispatchId: 'ctx_other' }]));
  assert.equal(r.status, 2);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.error.code, 'preview_dispatch_not_in_run');
  assert.ok(!r.stdout.includes('ctx_other'));
});

test('a Dispatch missing because its read failed cannot be mapped', () => {
  const r = harness(roles([{ ...claudeWorker, dispatchId: 'ctx_2' }]), { STUB_TWO_TASKS: '1' });
  assert.equal(r.json.error.code, 'preview_dispatch_not_in_run');
});

test('duplicate session mapping and invalid roles files fail closed without echoing values', () => {
  const dup = harness(roles([coord, { ...claudeWorker, sessionId: COORD }]));
  assert.equal(dup.json.error.code, 'preview_roles_duplicate');
  const conflict = harness(roles([coord, { ...coord, role: 'worker', dispatchId: 'ctx_1' }]));
  assert.equal(conflict.json.error.code, 'preview_roles_duplicate');
  for (const bad of [
    '{not json SECRET_ROLES',
    roles([]),
    { schemaVersion: 2, entries: [coord] },
    roles([{ ...coord, extra: 'SECRET_ROLES' }]),
    roles([{ ...coord, dispatchId: 'ctx_1' }]),
    roles([{ role: 'worker', provider: 'claude', sessionId: SUB }]),
    roles([{ ...coord, provider: 'gemini' }]),
    roles([{ ...coord, sessionId: 'a\u0000b' }]),
  ]) {
    const r = harness(bad);
    assert.equal(r.json.error.code, 'preview_roles_invalid');
    assert.ok(!r.stdout.includes('SECRET_ROLES'));
  }
});

test('roles file bounds: too many entries rejected', () => {
  const entries = Array.from({ length: 201 }, (_, i) => ({ ...coord, sessionId: `s${i}` }));
  assert.throws(() => parseRolesFile(JSON.stringify(roles(entries)), 'run_A'), (e) => e.code === 'preview_roles_invalid');
});

test('CodeBurn unavailable leaves entries unresolved, cost unknown, with error code only', () => {
  const r = harness(roles([coord, claudeWorker]), {
    CODEBURN_STUB_CLAUDE_EXIT_CODE: '1', CODEBURN_STUB_STDERR: 'SECRET_CB_STDERR',
  });
  assert.equal(r.status, 0, r.stderr);
  const d = r.json.data;
  assert.equal(d.status, 'partial');
  assert.deepEqual(d.codeburn.claude, { status: 'error', errorCode: 'codeburn_runtime_unavailable', sessionRows: null });
  assert.equal(d.codeburn.codex.status, 'not_requested');
  assert.equal(d.counts.unresolved, 2);
  assert.equal(d.coordinator.costUsd, null);
  assert.equal(d.coordinator.knownCostUsd, 0);
  assert.equal(d.coordinator.unknownCostSessionCount, 1);
  assert.equal(d.coordinator.byProvider[0].tokens, null);
  assert.deepEqual(d.coordinator.byProvider[0].knownTokens,
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: null });
  assert.equal(d.selectedOverheadShare.value, null);
  assert.ok(!r.stdout.includes('SECRET'));
  assert.ok(!r.stdout.includes(COORD) && !r.stdout.includes(SUB));
});

test('invalid CodeBurn JSON and unknown session are source error / not found, not leaked', () => {
  const bad = harness(roles([coord]), { CODEBURN_STUB_CLAUDE_INVALID_JSON: '1' });
  assert.equal(bad.json.data.codeburn.claude.errorCode, 'codeburn_schema_drift');
  assert.ok(!bad.stdout.includes('SECRET_INVALID_JSON'));
  const missing = harness(roles([{ ...coord, sessionId: 'no-such-session' }]));
  assert.equal(missing.json.data.entries[0].status, 'session_not_found');
  assert.equal(missing.json.data.entries[0].entryIndex, 0);
  assert.equal(missing.json.data.status, 'partial');
  assert.equal(missing.json.data.coordinator.costUsd, null);
  assert.equal(missing.json.data.coordinator.byProvider[0].tokens, null);
  assert.ok(!missing.stdout.includes('no-such-session'));
});

test('partial provider totals are unknown while resolved contributions remain visible', () => {
  const unresolvedId = 'SENTINEL-UNRESOLVED-SESSION-ID';
  const r = harness(roles([coord, { ...coord, sessionId: unresolvedId }]));
  assert.equal(r.status, 0, r.stderr);
  const provider = r.json.data.coordinator.byProvider[0];
  assert.equal(provider.sessionCount, 2);
  assert.equal(provider.unresolvedCount, 1);
  assert.equal(provider.tokens, null);
  assert.equal(provider.knownTokens.input, 12392);
  assert.match(formatOverheadPreviewText(r.json.data), /claude: sessions=2 unresolved=1 tokens=unknown \(known: in=12392/);
  assert.equal(r.json.data.coordinator.costUsd, null);
  assert.equal(r.json.data.coordinator.unknownCostSessionCount, 1);
  assert.ok(!r.stdout.includes(unresolvedId) && !r.stdout.includes(COORD));
});

test('text output is labelled manual preview', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-preview-text-'));
  try {
    const orca = join(dir, 'orca-stub.mjs');
    const rolesPath = join(dir, 'roles.json');
    writeFileSync(orca, ORCA_STUB);
    writeFileSync(rolesPath, JSON.stringify(roles([coord, claudeWorker])));
    const r = spawnSync(process.execPath, [cli, 'preview', 'overhead', '--run', 'run_A', '--roles', rolesPath], {
      encoding: 'utf8',
      env: { ...process.env, ORCA_TELEMETRY_ORCA: orca,
        ORCA_TELEMETRY_CODEBURN: resolve(here, 'helpers/integration-stubs/codeburn-router.mjs'),
        CODEBURN_STUB_CLAUDE_PATH: resolve(here, 'fixtures/codeburn/claude/session-with-subagent-aggregated.json') },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Overhead PREVIEW \(manual, not persisted\)/);
    assert.match(r.stdout, /runWideOverheadShare: unknown \(coverage_unknown\)/);
    assert.ok(!r.stdout.includes(COORD) && !r.stdout.includes(SUB));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function provenance(overrides = {}) {
  return { hostId: 'local', runId: 'run_A', coordinatorHandle: null, tasks: [], pagesRead: 1,
    dispatches: [{ dispatchId: 'ctx_1', taskId: 't', creatorOrcaSessionId: null, creatorDispatchId: null,
      retryOfDispatchId: null, assigneeOrcaSessionId: null, status: null }],
    workers: [], complete: true, errors: [], ...overrides };
}

test('unknown cost and ambiguous CodeBurn IDs are preserved, never zeroed', () => {
  const row = { ...fx('claude/session-sonnet-aggregated.json'), cost: null };
  const claude = parseClaudeSessions([row], 'now', '0.9.27');
  const d = buildOverheadPreview({
    hostId: 'local', runId: 'run_A', provenance: provenance(),
    entries: [{ role: 'coordinator', provider: 'claude', sessionId: row.sessionId, dispatchId: null }],
    providers: { claude: { status: 'ok', sessions: claude } },
  });
  assert.equal(d.coordinator.costUsd, null);
  assert.equal(d.coordinator.unknownCostSessionCount, 1);
  assert.equal(d.entries[0].costUsd, null);
  assert.equal(d.entries[0].costKind, 'unknown');
  assert.equal(d.entries[0].status, 'resolved');
  assert.equal(d.status, 'preview');
  assert.throws(() => buildOverheadPreview({
    hostId: 'local', runId: 'run_A', provenance: provenance(),
    entries: [{ role: 'coordinator', provider: 'claude', sessionId: row.sessionId, dispatchId: null }],
    providers: { claude: { status: 'ok', sessions: [...claude, ...claude] } },
  }), (e) => e.code === 'preview_session_ambiguous');
  const codex = parseCodexSessions([fx('codex/session-gpt-small-aggregated.json')], 'now', '0.9.27');
  assert.equal(codex[0].snapshot.tokens.reasoning, null);
});

test('unverified Run (run-show error) fails closed', () => {
  assert.throws(() => buildOverheadPreview({
    hostId: 'local', runId: 'run_A',
    provenance: provenance({ complete: false, errors: [{ source: 'run-show', code: 'run_mismatch' }] }),
    entries: [{ role: 'coordinator', provider: 'claude', sessionId: 'x', dispatchId: null }],
    providers: {},
  }), (e) => e.code === 'preview_run_unverified');
  assert.throws(() => buildOverheadPreview({
    hostId: 'local', runId: 'run_A', provenance: provenance({ runId: 'run_other' }),
    entries: [{ role: 'coordinator', provider: 'claude', sessionId: 'x', dispatchId: null }],
    providers: {},
  }), (e) => e.code === 'preview_run_unverified');
});
