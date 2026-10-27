import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'vitest';
import {
  assertUsageIntegrity,
  buildUsageIntegrityReport,
} from '../dist/attribution/unmapped.js';
import { sessionKey } from '../dist/contracts.js';
import { openTelemetryDatabase } from '../dist/db/index.js';
import { EXIT_PARTIAL, EXIT_SUCCESS } from '../dist/errors.js';

const dir = dirname(fileURLToPath(import.meta.url));
const cli = resolve(dir, '../dist/cli.js');
const e2e = resolve(dir, 'fixtures/e2e');
const stubs = resolve(dir, 'helpers/e2e-stubs');

const ghStub = resolve(stubs, 'gh.mjs');
const orcaStub = resolve(stubs, 'orca.mjs');
const agentTopStub = resolve(stubs, 'agent-top.mjs');

for (const stub of [ghStub, orcaStub, agentTopStub]) {
  chmodSync(stub, 0o755);
}

function initGitRepo(remote = 'https://github.com/hangndat/orca-task-telemetry.git') {
  const root = mkdtempSync(join(tmpdir(), 'orca-e2e-repo-'));
  execFileSync('git', ['init'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'e2e@test.example'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: root });
  writeFileSync(join(root, 'README.md'), '# e2e synthetic target\n');
  execFileSync('git', ['add', 'README.md'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: root });
  execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: root });
  return root;
}

function gitInventory(cwd) {
  const status = execFileSync('git', ['status', '--porcelain'], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  }).trimEnd();
  return status;
}

function baseStubEnv(appHome) {
  return {
    ORCA_TELEMETRY_HOME: appHome,
    ORCA_TELEMETRY_GH: ghStub,
    ORCA_TELEMETRY_ORCA: orcaStub,
    ORCA_TELEMETRY_AGENT_TOP: agentTopStub,
    GH_STUB_REPO_VIEW_JSON: JSON.stringify({
      id: 'R_kgDOVUhnYw',
      nameWithOwner: 'hangndat/orca-task-telemetry',
      url: 'https://github.com/hangndat/orca-task-telemetry',
    }),
    GH_STUB_GRAPHQL_REPO_JSON: readFileSync(join(e2e, 'github-init-repo.json'), 'utf8'),
    GH_STUB_GRAPHQL_OWNER_JSON: readFileSync(join(e2e, 'github-init-owner.json'), 'utf8'),
    GH_STUB_PAGE1_PATH: join(e2e, 'github-project-page1.json'),
    GH_STUB_PAGE2_PATH: join(e2e, 'github-project-page2.json'),
    ORCA_STUB_STATUS_PATH: join(e2e, 'orca-status.json'),
    ORCA_STUB_WORKER_LIST_PATH: join(e2e, 'orca-workers.json'),
    ORCA_STUB_RUN_LIST_PATH: join(e2e, 'orca-run-list.json'),
    ORCA_TELEMETRY_COLLECT_RUN: 'run_e2e_synthetic',
    AGENT_TOP_STUB_CLAUDE_PATH: join(e2e, 'agent-top-claude.json'),
    AGENT_TOP_STUB_CODEX_PATH: join(e2e, 'agent-top-codex.json'),
    AGENT_TOP_STUB_CURSOR_PATH: join(e2e, 'agent-top-cursor.json'),
  };
}

function runCli(cwd, env, ...args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function parseJsonLine(result) {
  const line = result.stdout.trim().split('\n').filter(Boolean).pop();
  const body = JSON.parse(line);
  return body.ok === true ? body.data : body;
}

function stripFreshness(report) {
  const { freshness: _f, ...rest } = report;
  return rest;
}

function stableTasksSnapshot(report) {
  return {
    kind: report.kind,
    projectId: report.projectId,
    issues: report.issues.map((item) => ({
      issueNodeId: item.issue.issueNodeId,
      number: item.issue.number,
      mappingStatus: item.mappingStatus,
      usageStatus: item.usageStatus,
      sessionCount: item.sessionCount,
      cost: item.cost,
      byProvider: item.byProvider,
      sessions: item.sessions.map((s) => ({
        sessionKey: s.sessionKey,
        tokens: s.tokens,
        cost: s.cost,
      })),
    })),
  };
}

function stableProjectSnapshot(report) {
  const base = stripFreshness(report);
  return {
    linkedSessionCount: base.linkedSessionCount,
    totalsByProvider: base.totalsByProvider,
    totalsByModel: base.totalsByModel,
    cost: base.cost,
    unmappedNotInProjectTotals: base.unmappedNotInProjectTotals,
    issuesInProject: base.issuesInProject,
  };
}

function stableUnmappedSnapshot(report) {
  return {
    kind: report.kind,
    sessions: report.sessions.map((s) => ({
      provider: s.provider,
      rawSessionId: s.rawSessionId,
      tokens: s.tokens,
      cost: s.cost,
    })),
  };
}

function stableTaskSnapshot(report) {
  const t = stripFreshness(report);
  return stableTasksSnapshot({ ...t, issues: [t.issue] }).issues[0];
}

function fetchReports(repo, env) {
  const out = {};
  for (const spec of [
    ['tasks', ['report', 'tasks', '--json']],
    ['project', ['report', 'project', '--json']],
    ['unmapped', ['report', 'unmapped', '--json']],
    ['task3', ['report', 'task', '3', '--json']],
  ]) {
    const [key, args] = spec;
    const result = runCli(repo, env, ...args);
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr || result.stdout}`);
    out[key] = parseJsonLine(result);
  }
  return out;
}

function assertReportCostPartition(db, project, unmapped) {
  let unmappedKnown = 0;
  let unmappedUnknown = 0;
  for (const s of unmapped.sessions) {
    if (s.cost.kind === 'unknown' || s.cost.amountUsd === null) {
      unmappedUnknown += 1;
    } else {
      unmappedKnown += s.cost.amountUsd;
    }
  }
  assert.equal(project.unmappedNotInProjectTotals.costKnownUsd, unmappedKnown);
  assert.equal(project.unmappedNotInProjectTotals.costUnknownCount, unmappedUnknown);

  const integrity = buildUsageIntegrityReport(db);
  let totalKnown = 0;
  let totalUnknown = 0;
  for (const slice of integrity.providers) {
    totalKnown += slice.costKnownUsd;
    totalUnknown += slice.costUnknownCount;
  }
  const mappedKnown = project.cost.knownAmountUsd;
  const mappedUnknown = project.cost.unknownAmountCount;
  assert.ok(
    Math.abs(totalKnown - (mappedKnown + unmappedKnown)) < 1e-6,
    `knownCost total=${totalKnown} mapped=${mappedKnown} unmapped=${unmappedKnown}`,
  );
  assert.equal(
    totalUnknown,
    mappedUnknown + unmappedUnknown,
    'unknownCostCount partition',
  );
}

function assertNoSecrets(text) {
  assert.doesNotMatch(text, /ghp_[A-Za-z0-9]+/);
  assert.doesNotMatch(text, /github_pat_/);
}

describe.sequential('T38 E2E offline pipeline', () => {
  test('init → collect → link → reports → collect#2 keeps report totals (fixture)', () => {
    const repo = initGitRepo();
    const appHome = mkdtempSync(join(tmpdir(), 'orca-e2e-home-'));
    const env = baseStubEnv(appHome);
    const statusBefore = gitInventory(repo);

    const init = runCli(repo, env, 'init', '--project', '4', '--json');
    assert.equal(init.status, 0, init.stderr || init.stdout);
    assert.equal(parseJsonLine(init).profile.project.number, 4);

    const collect1 = runCli(repo, env, 'collect', '--json');
    assert.equal(collect1.status, EXIT_SUCCESS, collect1.stderr || collect1.stdout);
    assertNoSecrets(collect1.stdout);

    const codexSession = '01a10000-bbbb-4ccc-8ddd-eeeeeeeeee01';
    const linkEnv = {
      ...env,
      GH_STUB_GRAPHQL_JSON: readFileSync(join(e2e, 'link-issue-3.json'), 'utf8'),
    };
    const link = runCli(
      repo,
      linkEnv,
      'link',
      '--issue',
      'hangndat/orca-task-telemetry#3',
      '--provider',
      'codex',
      '--session',
      codexSession,
      '--json',
    );
    assert.equal(link.status, 0, link.stderr || link.stdout);
    assert.equal(parseJsonLine(link).outcome, 'created');

    const reports1 = fetchReports(repo, env);

    const dbPath = join(appHome, 'telemetry.sqlite');
    const dbHandle = openTelemetryDatabase({ dbPath, gitRoot: repo });
    assertReportCostPartition(dbHandle.db, reports1.project, reports1.unmapped);
    assertUsageIntegrity(dbHandle.db);
    const claudeKey = sessionKey('claude', 'agent-top', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee01');
    const subKey = sessionKey('claude', 'agent-top', 'agent-0000000000000001');
    assert.notEqual(claudeKey, subKey, 'subagent is separate session namespace');
    const cursorKey = sessionKey('cursor', 'agent-top', 'cursor-e2e-zero-0001');
    const cursorSnap = dbHandle.db
      .prepare(
        `SELECT cost_kind, cost_amount_usd, claude_token_allocation
         FROM usage_snapshots WHERE session_key = ?`,
      )
      .get(cursorKey);
    assert.ok(cursorSnap, 'cursor zero-token row must import');
    assert.equal(cursorSnap.cost_kind, 'unknown');
    assert.equal(cursorSnap.cost_amount_usd, null);
    assert.equal(cursorSnap.claude_token_allocation, 'unknown');
    const sessionRows = dbHandle.db
      .prepare('SELECT COUNT(*) AS c FROM usage_sessions')
      .get().c;
    dbHandle.close();

    const collect2 = runCli(repo, env, 'collect', '--json');
    assert.equal(collect2.status, EXIT_SUCCESS);
    const reports2 = fetchReports(repo, env);
    assert.deepEqual(stableTasksSnapshot(reports2.tasks), stableTasksSnapshot(reports1.tasks));
    assert.deepEqual(
      stableProjectSnapshot(reports2.project),
      stableProjectSnapshot(reports1.project),
    );
    assert.deepEqual(
      stableUnmappedSnapshot(reports2.unmapped),
      stableUnmappedSnapshot(reports1.unmapped),
    );
    assert.deepEqual(stableTaskSnapshot(reports2.task3), stableTaskSnapshot(reports1.task3));

    const dbAfter = openTelemetryDatabase({ dbPath, gitRoot: repo });
    assert.equal(
      dbAfter.db.prepare('SELECT COUNT(*) AS c FROM usage_sessions').get().c,
      sessionRows,
      'duplicate collect must not multiply sessions',
    );
    dbAfter.close();

    assert.equal(gitInventory(repo), statusBefore);

    rmSync(repo, { recursive: true, force: true });
    rmSync(appHome, { recursive: true, force: true });
  }, 120_000);

  test('partial collect then full collect preserves prior usage in reports', () => {
    const repo = initGitRepo();
    const appHome = mkdtempSync(join(tmpdir(), 'orca-e2e-home-'));
    const env = baseStubEnv(appHome);
    const init = runCli(repo, env, 'init', '--project', '4', '--json');
    assert.equal(init.status, 0);

    const partialEnv = { ...env, ORCA_TELEMETRY_ORCA: '/no/orca-binary' };
    const partial = runCli(repo, partialEnv, 'collect', '--json');
    assert.equal(partial.status, EXIT_PARTIAL);
    const reportsPartial = fetchReports(repo, env);

    const full = runCli(repo, env, 'collect', '--json');
    assert.equal(full.status, EXIT_SUCCESS);
    const reportsFull = fetchReports(repo, env);
    assert.ok(
      reportsFull.project.totalsByProvider.length >=
        reportsPartial.project.totalsByProvider.length,
    );

    rmSync(repo, { recursive: true, force: true });
    rmSync(appHome, { recursive: true, force: true });
  }, 90_000);

  test('link conflict rejects second issue for same session', () => {
    const repo = initGitRepo();
    const appHome = mkdtempSync(join(tmpdir(), 'orca-e2e-home-'));
    const env = baseStubEnv(appHome);
    runCli(repo, env, 'init', '--project', '4', '--json');
    runCli(repo, env, 'collect', '--json');

    const codexSession = '01a10000-bbbb-4ccc-8ddd-eeeeeeeeee01';
    const linkEnv = {
      ...env,
      GH_STUB_GRAPHQL_JSON: readFileSync(join(e2e, 'link-issue-3.json'), 'utf8'),
    };
    assert.equal(
      runCli(
        repo,
        linkEnv,
        'link',
        '--issue',
        'hangndat/orca-task-telemetry#3',
        '--provider',
        'codex',
        '--session',
        codexSession,
        '--json',
      ).status,
      0,
    );

    const otherIssue = JSON.stringify({
      data: {
        repository: {
          issue: {
            id: 'I_e2e_other_issue',
            number: 99,
            url: 'https://github.com/hangndat/orca-task-telemetry/issues/99',
            title: 'Other',
            state: 'OPEN',
            repository: { nameWithOwner: 'hangndat/orca-task-telemetry' },
          },
        },
      },
    });
    const conflict = runCli(
      repo,
      { ...env, GH_STUB_GRAPHQL_JSON: otherIssue },
      'link',
      '--issue',
      'hangndat/orca-task-telemetry#99',
      '--provider',
      'codex',
      '--session',
      codexSession,
      '--json',
    );
    const errLine = conflict.stdout.trim().split('\n').filter(Boolean).pop();
    const body = JSON.parse(errLine);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'attribution_link_conflict');

    rmSync(repo, { recursive: true, force: true });
    rmSync(appHome, { recursive: true, force: true });
  }, 90_000);
});
