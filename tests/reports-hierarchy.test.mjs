import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { linkSessionToIssue } from '../dist/attribution/link.js';
import { importGitHubRecords } from '../dist/db/index.js';
import { buildHierarchyReport, formatHierarchyReportText } from '../dist/reports/hierarchy.js';
import { loadSyntheticDataset, disposeDataset } from './helpers/attribution-dataset.mjs';
import {
  appHomeInventory,
  initBareRepo,
  installDatasetInHome,
  runCliReport,
  writeReportsProfile,
} from './helpers/reports-harness.mjs';

const testDir = dirname(fileURLToPath(import.meta.url));
const ghStub = resolve(testDir, 'helpers/gh-repo-stub.mjs');

function issue(id, number, parentIssueNodeId) {
  return {
    issueNodeId: id,
    parentIssueNodeId,
    repository: { nameWithOwner: 'org-a/repo' },
    number,
    url: `https://github.com/org-a/repo/issues/${number}`,
    title: `Issue ${number}`,
    state: 'OPEN',
  };
}

function session(rawId, provider, amount) {
  return {
    provider,
    rawId,
    observedAt: '2026-06-01T00:00:00Z',
    tokens: provider === 'codex'
      ? { provider, input: 1, output: 2, cacheRead: 3, cacheWrite: 4, reasoning: null }
      : { provider, input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
    cost: amount === null
      ? { amountUsd: null, kind: 'unknown', source: null }
      : { amountUsd: amount, kind: 'estimated_api_equivalent', source: { tool: 'codeburn', version: '0.9.27' } },
  };
}

const fixture = {
  issues: [
    issue('I_epic', 1, null),
    issue('I_story', 2, 'I_epic'),
    issue('I_task', 3, 'I_story'),
    issue('I_task_empty', 4, 'I_story'),
    issue('I_boundary_child', 5, 'I_outside'),
    issue('I_outside', 6, null),
  ],
  memberships: [
    ...['I_epic', 'I_story', 'I_task', 'I_task_empty', 'I_boundary_child'].map((issueNodeId) => ({ projectId: 'P_A', issueNodeId })),
    { projectId: 'P_B', issueNodeId: 'I_outside' },
  ],
  sessions: [
    session('task', 'claude', 1.25),
    session('story', 'claude', 0.5),
    session('epic-unknown', 'codex', null),
    session('boundary', 'claude', 2),
    session('outside', 'claude', 3),
    session('unmapped', 'claude', 9),
  ],
};

function linkFixture(ctx) {
  for (const [rawSessionId, provider, issueNodeId] of [
    ['task', 'claude', 'I_task'],
    ['story', 'claude', 'I_story'],
    ['epic-unknown', 'codex', 'I_epic'],
    ['boundary', 'claude', 'I_boundary_child'],
    ['outside', 'claude', 'I_outside'],
  ]) {
    linkSessionToIssue(ctx.db, {
      provider,
      source: 'codeburn',
      rawSessionId,
      issueNodeId,
      linkedAt: '2026-06-01T10:00:00Z',
    });
  }
}

function profile(projectId) {
  return {
    repository: { nameWithOwner: 'org-a/repo' },
    project: { id: projectId },
  };
}

function nodeById(report, id) {
  return report.nodes.find((node) => node.issue.issueNodeId === id);
}

test('V1.1: three-level roll-up keeps direct/unknown cost and project boundaries', () => {
  const ctx = loadSyntheticDataset(fixture);
  try {
    linkFixture(ctx);
    const reportA = buildHierarchyReport({ profile: profile('P_A'), db: ctx.db, close: () => {} });
    const reportB = buildHierarchyReport({ profile: profile('P_B'), db: ctx.db, close: () => {} });
    assert.equal(reportA.nodes.length, 5);
    assert.deepEqual(reportA.nodes.map((node) => [node.issue.issueNodeId, node.depth]), [
      ['I_epic', 0], ['I_story', 1], ['I_task', 2], ['I_task_empty', 2], ['I_boundary_child', 0],
    ]);
    assert.equal(nodeById(reportA, 'I_story').direct.cost.knownAmountUsd, 0.5);
    assert.equal(nodeById(reportA, 'I_story').inclusive.cost.knownAmountUsd, 1.75);
    assert.equal(nodeById(reportA, 'I_epic').inclusive.sessionCount, 3);
    assert.equal(nodeById(reportA, 'I_epic').inclusive.cost.unknownAmountCount, 1);
    assert.equal(nodeById(reportA, 'I_task_empty').inclusive.sessionCount, 0);
    assert.equal(nodeById(reportA, 'I_boundary_child').parentStatus, 'outside_project');
    assert.equal(reportA.projectTotals.sessionCount, 4);
    assert.equal(reportA.projectTotals.cost.knownAmountUsd, 3.75);
    assert.equal(reportA.projectTotals.cost.unknownAmountCount, 1);
    assert.equal(reportB.projectTotals.cost.knownAmountUsd, 3);
    assert.equal(reportB.nodes.length, 1);
    assert.match(formatHierarchyReportText(reportA), /parent outside Project: I_outside/);
    assert.doesNotMatch(formatHierarchyReportText(reportA), /Issue 6/);
  } finally {
    disposeDataset(ctx);
  }
});

test('V1.1: refuses unknown parent state and hierarchy cycles', () => {
  const ctx = loadSyntheticDataset(fixture);
  try {
    linkFixture(ctx);
    ctx.db.prepare('UPDATE issues SET parent_issue_observed = 0 WHERE issue_node_id = ?').run('I_story');
    assert.throws(
      () => buildHierarchyReport({ profile: profile('P_A'), db: ctx.db, close: () => {} }),
      (err) => err.code === 'db_error' && /has not been collected/.test(err.message),
    );
    ctx.db.prepare('UPDATE issues SET parent_issue_observed = 1, parent_issue_node_id = ? WHERE issue_node_id = ?')
      .run('I_task', 'I_story');
    assert.throws(
      () => buildHierarchyReport({ profile: profile('P_A'), db: ctx.db, close: () => {} }),
      (err) => err.code === 'db_error' && /cycle/.test(err.message),
    );
  } finally {
    disposeDataset(ctx);
  }
});

test('V1.1: report hierarchy CLI JSON/text reads without changing DB bytes', () => {
  const repo = initBareRepo();
  const appHome = mkdtempSync(join(tmpdir(), 'orca-hierarchy-home-'));
  try {
    writeReportsProfile(appHome, 'P_A');
    installDatasetInHome(appHome, linkFixture, fixture);
    const before = appHomeInventory(appHome);
    const env = {
      ORCA_TELEMETRY_HOME: appHome,
      ORCA_TELEMETRY_GH: ghStub,
      GH_STUB_REPO_VIEW_JSON: JSON.stringify({
        id: 'R_reports',
        nameWithOwner: 'org-a/repo',
        url: 'https://github.com/org-a/repo',
      }),
    };
    const json = runCliReport(['report', 'hierarchy', '--json'], { cwd: repo, env });
    assert.equal(json.status, 0, json.stderr);
    const payload = JSON.parse(json.stdout.trim());
    assert.equal(payload.data.kind, 'hierarchy');
    assert.equal(payload.data.projectTotals.cost.knownAmountUsd, 3.75);
    const text = runCliReport(['report', 'hierarchy'], { cwd: repo, env });
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /#1 Issue 1/);
    assert.deepEqual(appHomeInventory(appHome), before);
  } finally {
    rmSync(appHome, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('V1.1: empty Project reports zero totals', () => {
  const ctx = loadSyntheticDataset(fixture);
  try {
    importGitHubRecords(ctx.db, { projectId: 'P_EMPTY', issues: [], memberships: [] });
    const report = buildHierarchyReport({ profile: profile('P_EMPTY'), db: ctx.db, close: () => {} });
    assert.equal(report.nodes.length, 0);
    assert.equal(report.projectTotals.sessionCount, 0);
    assert.equal(report.projectTotals.cost.knownAmountUsd, 0);
  } finally {
    disposeDataset(ctx);
  }
});
