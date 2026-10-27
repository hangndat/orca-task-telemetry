import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { linkSessionToIssue } from '../dist/attribution/link.js';
import { confirmApply, parseWritebackArgs } from '../dist/commands/writeback.js';
import { CliError, EXIT_PARTIAL, EXIT_USAGE } from '../dist/errors.js';
import { applyExitCode, applyWritebackPreview, formatWritebackApplyText } from '../dist/writeback/apply.js';
import { setProjectItemNumberField } from '../dist/writeback/gh-apply.js';
import {
  initBareRepo,
  installDatasetInHome,
  writeReportsProfile,
} from './helpers/reports-harness.mjs';
import { runCliWriteback } from './helpers/writeback-harness.mjs';

const dir = dirname(fileURLToPath(import.meta.url));
const ghStub = resolve(dir, 'helpers/gh-writeback-stub.mjs');
const itemEditStub = resolve(dir, 'helpers/gh-project-item-edit-stub.mjs');

function item(number, amount, action = 'set') {
  return {
    issue: {
      issueNodeId: `I_${number}`,
      repository: { nameWithOwner: 'org-a/repo' },
      number,
      url: `https://github.com/org-a/repo/issues/${number}`,
      title: `Issue ${number}`,
      state: 'OPEN',
    },
    projectItemId: `PVTI_${number}`,
    computed: {
      knownAmountUsd: amount,
      sessionCount: action === 'set' ? 1 : 0,
      rollup: 'direct',
      costLabel: 'estimated_api_equivalent',
    },
    remote: null,
    ...(action === 'set' ? { proposed: amount } : { skipReason: 'no_usage' }),
    action,
  };
}

function preview(items) {
  return {
    kind: 'writeback_preview',
    mode: 'dry_run',
    project: {
      id: 'PVT_profile',
      number: 1,
      url: 'https://github.com/orgs/org-a/projects/1',
      owner: { kind: 'organization', login: 'org-a' },
    },
    field: { id: 'PVTF_cost', name: 'Estimated cost', dataType: 'NUMBER' },
    rollup: 'direct',
    freshness: [],
    warnings: ['estimated API equivalent only'],
    items,
    summary: { wouldSet: items.filter((i) => i.action === 'set').length, skips: items.filter((i) => i.action === 'skip').length },
  };
}

test('apply re-reads before each set, skips a changed remote, and writes only profile IDs', async () => {
  const calls = [];
  const p = preview([item(1, 1.5), item(2, 2.5), item(3, 0, 'skip')]);
  const result = await applyWritebackPreview(p, { confirmed: true, forceOverwrite: false }, {
    readProjectItemNumberFieldValue: async (id, fieldId) => {
      calls.push(['read', id, fieldId]);
      return id === 'PVTI_1' ? 9 : null;
    },
    setProjectItemNumberField: async (input) => { calls.push(['write', input]); },
  });
  assert.deepEqual(calls, [
    ['read', 'PVTI_1', 'PVTF_cost'],
    ['read', 'PVTI_2', 'PVTF_cost'],
    ['write', { projectItemId: 'PVTI_2', fieldId: 'PVTF_cost', projectId: 'PVT_profile', number: 2.5 }],
  ]);
  assert.equal(result.items[0].skipReason, 'remote_conflict');
  assert.deepEqual(result.summary, { plannedSets: 2, applied: 1, skips: 2, failed: 0, cancelled: 0 });
  assert.equal(result.kind, 'writeback_apply');
  assert.equal(result.mode, 'apply');
  assert.deepEqual(result.warnings, p.warnings);
});

test('force overwrite is explicit; rerun with matching remote skips unchanged', async () => {
  const remote = new Map([['PVTI_1', 9]]);
  const writes = [];
  const deps = {
    readProjectItemNumberFieldValue: async (id) => remote.get(id) ?? null,
    setProjectItemNumberField: async (input) => { writes.push(input); remote.set(input.projectItemId, input.number); },
  };
  const p = preview([item(1, 1.5)]);
  const first = await applyWritebackPreview(p, { confirmed: true, forceOverwrite: true }, deps);
  const second = await applyWritebackPreview(p, { confirmed: true, forceOverwrite: true }, deps);
  assert.equal(first.summary.applied, 1);
  assert.equal(second.items[0].skipReason, 'unchanged');
  assert.equal(writes.length, 1);
});

test('partial failure retains sanitized item error and continues sequentially', async () => {
  const order = [];
  const result = await applyWritebackPreview(preview([item(1, 1), item(2, 2)]), {
    confirmed: true, forceOverwrite: false,
  }, {
    readProjectItemNumberFieldValue: async (id) => { order.push(`read:${id}`); return null; },
    setProjectItemNumberField: async (input) => {
      order.push(`write:${input.projectItemId}`);
      if (input.projectItemId === 'PVTI_1') {
        throw new CliError({ code: 'github_scope_missing', message: 'GitHub token is missing the project scope required for item-edit.', hint: 'gh auth refresh -s project', exitCode: 3 });
      }
    },
  });
  assert.deepEqual(order, ['read:PVTI_1', 'write:PVTI_1', 'read:PVTI_2', 'write:PVTI_2']);
  assert.equal(result.summary.failed, 1);
  assert.equal(result.summary.applied, 1);
  assert.equal(result.items[0].error.hint, 'gh auth refresh -s project');
  assert.equal(applyExitCode(result), EXIT_PARTIAL);
});

test('F03: apply JSON and text preserve uncertain remote state for timeout and overflow', async () => {
  for (const scenario of [
    { code: 'github_apply_timeout', signal: 'ignore', delay: '3000', timeoutMs: 300 },
    { code: 'github_apply_output_overflow', signal: 'zero', stdout: 'x'.repeat(1000), maxBuffer: 10 },
  ]) {
    process.env.GH_ITEM_EDIT_STUB_SIGNAL = scenario.signal;
    process.env.GH_ITEM_EDIT_STUB_DELAY_MS = scenario.delay ?? '0';
    process.env.GH_ITEM_EDIT_STUB_STDOUT = scenario.stdout ?? '';
    process.env.GH_ITEM_EDIT_STUB_STDERR = 'ghp_SUPERSECRET123';
    let writes = 0;
    try {
      const report = await applyWritebackPreview(preview([item(1, 1), item(2, 2)]), {
        confirmed: true, forceOverwrite: false,
      }, {
        readProjectItemNumberFieldValue: async () => null,
        setProjectItemNumberField: async (input) => {
          writes += 1;
          if (input.projectItemId === 'PVTI_1') {
            await setProjectItemNumberField(input, {
              ghPath: itemEditStub,
              timeoutMs: scenario.timeoutMs ?? 5000,
              maxBuffer: scenario.maxBuffer ?? 1024,
            });
          }
        },
      });
      assert.equal(writes, 2);
      assert.equal(report.summary.failed, 1);
      assert.equal(report.summary.applied, 1);
      assert.equal(applyExitCode(report), EXIT_PARTIAL);
      assert.equal(report.items[0].error.code, scenario.code);
      assert.match(report.items[0].error.message, /remote write state is unknown/i);
      assert.match(report.items[0].error.message, /Read the field before retrying manually/);
      assert.match(formatWritebackApplyText(report), /remote write state is unknown/);
      assert.doesNotMatch(JSON.stringify(report) + formatWritebackApplyText(report), /ghp_SUPERSECRET123/);
    } finally {
      delete process.env.GH_ITEM_EDIT_STUB_SIGNAL;
      delete process.env.GH_ITEM_EDIT_STUB_DELAY_MS;
      delete process.env.GH_ITEM_EDIT_STUB_STDOUT;
      delete process.env.GH_ITEM_EDIT_STUB_STDERR;
    }
  }
});

test('invalid proposals and unrecognized exceptions fail closed without exposing secrets', async () => {
  let writes = 0;
  const bad = item(1, Number.POSITIVE_INFINITY);
  const result = await applyWritebackPreview(preview([bad, item(2, 2)]), {
    confirmed: true, forceOverwrite: false,
  }, {
    readProjectItemNumberFieldValue: async () => { throw new Error('ghp_SECRET should not leak'); },
    setProjectItemNumberField: async () => { writes += 1; },
  });
  assert.equal(writes, 0);
  assert.equal(result.items[0].error.code, 'invalid_proposal');
  assert.equal(result.items[1].error.code, 'writeback_item_failed');
  assert.doesNotMatch(JSON.stringify(result), /ghp_SECRET/);
});

test('declined confirmation keeps planned sets separate and makes no remote calls', async () => {
  const result = await applyWritebackPreview(preview([item(1, 1.5), item(2, 0, 'skip')]), {
    confirmed: false, forceOverwrite: false,
  }, {
    readProjectItemNumberFieldValue: async () => { throw new Error('must not read'); },
    setProjectItemNumberField: async () => { throw new Error('must not write'); },
  });
  assert.equal(result.cancelled, true);
  assert.deepEqual(result.summary, { plannedSets: 1, applied: 0, skips: 1, failed: 0, cancelled: 1 });
  assert.equal(result.items[0].result, 'cancelled');
});

test('TTY prompt states exact count, project and field; default No requires explicit yes', async () => {
  async function answer(value) {
    const input = new PassThrough();
    const output = new PassThrough();
    let text = '';
    output.on('data', (chunk) => { text += chunk.toString(); });
    const pending = confirmApply(2, 'org-a', 7, 'Estimated cost', { input, output });
    input.end(`${value}\n`);
    return { accepted: await pending, text };
  }
  const no = await answer('');
  const yes = await answer('yes');
  assert.equal(no.accepted, false);
  assert.equal(yes.accepted, true);
  assert.match(yes.text, /Apply 2 changes to project org-a\/7 field "Estimated cost"\? \[y\/N\]/);
});

test('argument gate: apply is explicit; --yes dry-run and project overrides fail', () => {
  assert.equal(parseWritebackArgs(['--field', 'Estimated cost']).apply, false);
  assert.deepEqual(parseWritebackArgs(['--field-id', 'PVTF_cost', '--apply', '--yes']), {
    field: undefined, fieldId: 'PVTF_cost', rollup: 'direct', issues: [], apply: true, yes: true, forceOverwrite: false,
  });
  for (const args of [['--yes'], ['--project', '7'], ['--owner', 'org-a']]) {
    assert.throws(() => parseWritebackArgs(args), (err) => err.exitCode === EXIT_USAGE);
  }
});

test('CLI stub: dry-run never edits; apply JSON writes once and rerun is unchanged', () => {
  const repo = initBareRepo();
  const home = mkdtempSync(join(tmpdir(), 'orca-wb-apply-'));
  const statePath = join(home, 'remote.json');
  const logPath = join(home, 'gh-log.ndjson');
  try {
    writeReportsProfile(home, 'PVT_attr_synthetic_project');
    installDatasetInHome(home, (ctx) => {
      linkSessionToIssue(ctx.db, {
        provider: 'claude', source: 'agent-top',
        rawSessionId: 'aaaaaaaa-claude-4ccc-8ddd-eeeeeeeeee01',
        issueNodeId: 'I_attr_issue_alpha',
        linkedAt: '2026-06-01T10:00:00Z',
      });
    });
    const env = {
      ORCA_TELEMETRY_HOME: home,
      ORCA_TELEMETRY_GH: ghStub,
      GH_WRITEBACK_STATE_PATH: statePath,
      GH_WRITEBACK_LOG_PATH: logPath,
    };
    const dry = runCliWriteback(['--field', 'Estimated cost', '--issue', 'org-a/repo#1', '--json'], { cwd: repo, env });
    assert.equal(dry.status, 0, dry.stderr);
    assert.equal(JSON.parse(dry.stdout).data.mode, 'dry_run');
    assert.equal(readFileSync(logPath, 'utf8').includes('item-edit'), false);
    const gated = runCliWriteback(['--field', 'Estimated cost', '--issue', 'org-a/repo#1', '--apply', '--json'], { cwd: repo, env });
    assert.equal(gated.status, EXIT_USAGE);
    assert.equal(JSON.parse(gated.stdout).error.code, 'usage_error');
    assert.equal(readFileSync(logPath, 'utf8').includes('item-edit'), false);
    const applied = runCliWriteback(['--field', 'Estimated cost', '--issue', 'org-a/repo#1', '--apply', '--yes', '--json'], { cwd: repo, env });
    assert.equal(applied.status, 0, applied.stderr);
    const body = JSON.parse(applied.stdout);
    assert.equal(body.ok, true);
    assert.equal(body.data.kind, 'writeback_apply');
    assert.equal(body.data.summary.applied, 1);
    assert.equal(body.data.items[0].computed.costLabel, 'estimated_api_equivalent');
    assert.equal(readFileSync(statePath, 'utf8').includes('1.5'), true);
    const rerun = runCliWriteback(['--field', 'Estimated cost', '--issue', 'org-a/repo#1', '--apply', '--yes', '--json'], { cwd: repo, env });
    assert.equal(rerun.status, 0, rerun.stderr);
    assert.equal(JSON.parse(rerun.stdout).data.items[0].skipReason, 'unchanged');
    const log = readFileSync(logPath, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(log.filter((entry) => entry.kind === 'item-edit').length, 1);
    assert.equal(log.filter((entry) => entry.kind === 'remote').length, 4);
    assert.deepEqual(log.find((entry) => entry.kind === 'item-edit').argv, [
      'project', 'item-edit', '--id', 'PVTI_alpha', '--field-id', 'PVTF_cost',
      '--project-id', 'PVT_attr_synthetic_project', '--number', '1.5',
    ]);
    assert.equal(existsSync(statePath), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('CLI stub: scope revoked after preflight is a partial item failure with sanitized error', () => {
  const repo = initBareRepo();
  const home = mkdtempSync(join(tmpdir(), 'orca-wb-scope-'));
  try {
    writeReportsProfile(home, 'PVT_attr_synthetic_project');
    installDatasetInHome(home, (ctx) => {
      linkSessionToIssue(ctx.db, {
        provider: 'claude', source: 'agent-top',
        rawSessionId: 'aaaaaaaa-claude-4ccc-8ddd-eeeeeeeeee01',
        issueNodeId: 'I_attr_issue_alpha', linkedAt: '2026-06-01T10:00:00Z',
      });
    });
    const result = runCliWriteback(['--field-id', 'PVTF_cost', '--issue', 'org-a/repo#1', '--apply', '--yes', '--json'], {
      cwd: repo,
      env: {
        ORCA_TELEMETRY_HOME: home,
        ORCA_TELEMETRY_GH: ghStub,
        GH_WRITEBACK_STATE_PATH: join(home, 'remote.json'),
        GH_WRITEBACK_LOG_PATH: join(home, 'log.ndjson'),
        GH_WRITEBACK_FAIL: 'scope',
      },
    });
    assert.equal(result.status, EXIT_PARTIAL, result.stderr);
    const data = JSON.parse(result.stdout).data;
    assert.equal(data.summary.failed, 1);
    assert.equal(data.items[0].error.code, 'github_scope_missing');
    assert.equal(data.items[0].error.hint, 'gh auth refresh -s project');
    assert.doesNotMatch(result.stdout + result.stderr, /ghp_SUPERSECRET123/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('F02: read:project permits preview but missing project rejects apply before any edit', () => {
  const repo = initBareRepo();
  const home = mkdtempSync(join(tmpdir(), 'orca-wb-preflight-'));
  const logPath = join(home, 'log.ndjson');
  try {
    writeReportsProfile(home, 'PVT_attr_synthetic_project');
    installDatasetInHome(home, (ctx) => {
      linkSessionToIssue(ctx.db, {
        provider: 'claude', source: 'agent-top',
        rawSessionId: 'aaaaaaaa-claude-4ccc-8ddd-eeeeeeeeee01',
        issueNodeId: 'I_attr_issue_alpha', linkedAt: '2026-06-01T10:00:00Z',
      });
    });
    const env = {
      ORCA_TELEMETRY_HOME: home, ORCA_TELEMETRY_GH: ghStub,
      GH_WRITEBACK_STATE_PATH: join(home, 'remote.json'), GH_WRITEBACK_LOG_PATH: logPath,
      GH_WRITEBACK_AUTH: 'read',
    };
    const dry = runCliWriteback(['--field-id', 'PVTF_cost', '--json'], { cwd: repo, env });
    assert.equal(dry.status, 0, dry.stderr);
    assert.equal(JSON.parse(dry.stdout).data.summary.wouldSet, 1);
    const apply = runCliWriteback(['--field-id', 'PVTF_cost', '--apply', '--yes', '--json'], { cwd: repo, env });
    assert.equal(apply.status, EXIT_USAGE, apply.stderr);
    assert.equal(JSON.parse(apply.stdout).error.code, 'github_scope_missing');
    assert.equal(JSON.parse(apply.stdout).error.hint, 'gh auth refresh -s project');
    assert.equal(readFileSync(logPath, 'utf8').includes('item-edit'), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('F04: auth child ignoring SIGTERM fails closed before preview or edit', () => {
  const repo = initBareRepo();
  const home = mkdtempSync(join(tmpdir(), 'orca-wb-auth-timeout-'));
  const logPath = join(home, 'log.ndjson');
  try {
    writeReportsProfile(home, 'PVT_attr_synthetic_project');
    installDatasetInHome(home);
    const started = Date.now();
    const result = runCliWriteback(['--field-id', 'PVTF_cost', '--apply', '--yes', '--json'], {
      cwd: repo,
      timeout: 19_000,
      env: {
        ORCA_TELEMETRY_HOME: home,
        ORCA_TELEMETRY_GH: ghStub,
        GH_WRITEBACK_STATE_PATH: join(home, 'remote.json'),
        GH_WRITEBACK_LOG_PATH: logPath,
        GH_WRITEBACK_AUTH: 'ignore-term',
      },
    });
    assert.equal(result.status, EXIT_USAGE, result.stderr);
    assert.ok(Date.now() - started < 13_000, 'preflight exceeded the bounded stop window');
    assert.equal(JSON.parse(result.stdout).error.code, 'github_auth_unverified');
    const kinds = readFileSync(logPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line).kind);
    assert.deepEqual(kinds, ['auth']);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
}, 20_000);

test('F02: apply validates scope even when preview would plan no sets', () => {
  const repo = initBareRepo();
  const home = mkdtempSync(join(tmpdir(), 'orca-wb-no-sets-'));
  const logPath = join(home, 'log.ndjson');
  try {
    writeReportsProfile(home, 'PVT_attr_synthetic_project');
    installDatasetInHome(home);
    const env = {
      ORCA_TELEMETRY_HOME: home, ORCA_TELEMETRY_GH: ghStub,
      GH_WRITEBACK_STATE_PATH: join(home, 'remote.json'), GH_WRITEBACK_LOG_PATH: logPath,
      GH_WRITEBACK_AUTH: 'read',
    };
    const dry = runCliWriteback(['--field-id', 'PVTF_cost', '--json'], { cwd: repo, env });
    assert.equal(dry.status, 0, dry.stderr);
    assert.equal(JSON.parse(dry.stdout).data.summary.wouldSet, 0);
    const apply = runCliWriteback(['--field-id', 'PVTF_cost', '--apply', '--yes', '--json'], { cwd: repo, env });
    assert.equal(apply.status, EXIT_USAGE, apply.stderr);
    assert.equal(JSON.parse(apply.stdout).error.code, 'github_scope_missing');
    assert.equal(readFileSync(logPath, 'utf8').includes('item-edit'), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('F02: unauthenticated and unknown auth fail closed before item edit', () => {
  const repo = initBareRepo();
  const home = mkdtempSync(join(tmpdir(), 'orca-wb-auth-'));
  const logPath = join(home, 'log.ndjson');
  try {
    writeReportsProfile(home, 'PVT_attr_synthetic_project');
    installDatasetInHome(home);
    for (const [mode, code] of [
      ['unauthenticated', 'github_auth_required'],
      ['unknown', 'github_auth_unverified'],
      ['inactive-project', 'github_scope_missing'],
    ]) {
      const result = runCliWriteback(['--field-id', 'PVTF_cost', '--apply', '--yes', '--json'], {
        cwd: repo,
        env: {
          ORCA_TELEMETRY_HOME: home, ORCA_TELEMETRY_GH: ghStub,
          GH_WRITEBACK_STATE_PATH: join(home, 'remote.json'), GH_WRITEBACK_LOG_PATH: logPath,
          GH_WRITEBACK_AUTH: mode,
        },
      });
      assert.equal(result.status, EXIT_USAGE, result.stderr);
      assert.equal(JSON.parse(result.stdout).error.code, code);
    }
    assert.equal(readFileSync(logPath, 'utf8').includes('item-edit'), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});
