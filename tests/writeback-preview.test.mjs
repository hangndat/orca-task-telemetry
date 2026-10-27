import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { linkSessionToIssue } from '../dist/attribution/link.js';
import { EXIT_USAGE } from '../dist/errors.js';
import { selectNumberFieldByName } from '../dist/github/fields.js';
import {
  buildWritebackPreview,
  decideWritebackAction,
  previewItemForUnsupportedType,
  roundWritebackUsd,
} from '../dist/writeback/preview.js';
import { loadSyntheticDataset, disposeDataset } from './helpers/attribution-dataset.mjs';
import {
  initBareRepo,
  installDatasetInHome,
  writeReportsProfile,
} from './helpers/reports-harness.mjs';
import {
  mockWritebackDeps,
  NUMBER_FIELD,
  projectItem,
  pullRequestItem,
  runCliWriteback,
} from './helpers/writeback-harness.mjs';

const testDir = dirname(fileURLToPath(import.meta.url));
const ghStub = resolve(testDir, 'helpers/gh-stub.mjs');
const fieldsDup = resolve(testDir, 'fixtures/github/project-fields-duplicate-name.json');
const ghRepoStub = resolve(testDir, 'helpers/gh-repo-stub.mjs');

function issue(id, number, parentIssueNodeId = null) {
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
    tokens:
      provider === 'codex'
        ? { provider, input: 1, output: 2, cacheRead: 3, cacheWrite: 4, reasoning: null }
        : { provider, input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
    cost:
      amount === null
        ? { amountUsd: null, kind: 'unknown', source: null }
        : {
            amountUsd: amount,
            kind: 'estimated_api_equivalent',
            source: { tool: 'agent-top', version: '0.27.1' },
          },
  };
}

const hierarchyFixture = {
  issues: [
    issue('I_epic', 1, null),
    issue('I_story', 2, 'I_epic'),
    issue('I_task', 3, 'I_story'),
    issue('I_task_empty', 4, 'I_story'),
  ],
  memberships: ['I_epic', 'I_story', 'I_task', 'I_task_empty'].map((issueNodeId) => ({
    projectId: 'P_A',
    issueNodeId,
  })),
  sessions: [
    session('task', 'claude', 1.25),
    session('story', 'claude', 0.5),
    session('epic-unknown', 'codex', null),
    session('empty', 'claude', 0),
  ],
};

function linkHierarchy(ctx) {
  for (const [rawSessionId, provider, issueNodeId] of [
    ['task', 'claude', 'I_task'],
    ['story', 'claude', 'I_story'],
    ['epic-unknown', 'codex', 'I_epic'],
  ]) {
    linkSessionToIssue(ctx.db, {
      provider,
      source: 'agent-top',
      rawSessionId,
      issueNodeId,
      linkedAt: '2026-06-01T10:00:00Z',
    });
  }
}

function writebackEnv(appHome) {
  return {
    ORCA_TELEMETRY_HOME: appHome,
    ORCA_TELEMETRY_GH: ghRepoStub,
    GH_STUB_REPO_VIEW_JSON: JSON.stringify({
      id: 'R_reports',
      nameWithOwner: 'org-a/repo',
      url: 'https://github.com/org-a/repo',
    }),
  };
}

test('decideWritebackAction: unknown, no_usage, rounds_to_zero, unchanged, conflict, force', () => {
  assert.deepEqual(
    decideWritebackAction(
      { knownAmountUsd: 1, sessionCount: 1, unknownAmountCount: 1 },
      null,
      false,
    ),
    { action: 'skip', skipReason: 'unknown_cost' },
  );
  assert.deepEqual(
    decideWritebackAction(
      { knownAmountUsd: 0, sessionCount: 0, unknownAmountCount: 0 },
      null,
      false,
    ),
    { action: 'skip', skipReason: 'no_usage' },
  );
  const tiny = 1 / 10 ** 7;
  assert.deepEqual(
    decideWritebackAction(
      { knownAmountUsd: tiny, sessionCount: 1, unknownAmountCount: 0 },
      null,
      false,
    ),
    { action: 'skip', skipReason: 'rounds_to_zero', precisionWarning: true },
  );
  const proposed = roundWritebackUsd(1.23456789);
  assert.deepEqual(
    decideWritebackAction(
      { knownAmountUsd: 1.23456789, sessionCount: 1, unknownAmountCount: 0 },
      proposed,
      false,
    ),
    { action: 'skip', skipReason: 'unchanged' },
  );
  assert.deepEqual(
    decideWritebackAction(
      { knownAmountUsd: 2, sessionCount: 1, unknownAmountCount: 0 },
      1,
      false,
    ),
    { action: 'skip', skipReason: 'remote_conflict', proposed: 2 },
  );
  assert.deepEqual(
    decideWritebackAction(
      { knownAmountUsd: 2, sessionCount: 1, unknownAmountCount: 0 },
      1,
      true,
    ),
    { action: 'set', proposed: 2 },
  );
  assert.deepEqual(
    decideWritebackAction(
      { knownAmountUsd: 1.5, sessionCount: 1, unknownAmountCount: 0 },
      null,
      false,
    ),
    { action: 'set', proposed: 1.5 },
  );
});

test('previewItemForUnsupportedType skips PR items', () => {
  const row = previewItemForUnsupportedType(pullRequestItem('PVTI_pr'), 'direct');
  assert.equal(row?.skipReason, 'unsupported_item_type');
  assert.equal(row?.projectItemId, 'PVTI_pr');
});

test('buildWritebackPreview: direct rollup, remote equal and conflict', async () => {
  const ctx = loadSyntheticDataset(hierarchyFixture);
  try {
    linkHierarchy(ctx);
    const reportCtx = {
      profile: {
        repository: {
          id: 'R1',
          nameWithOwner: 'org-a/repo',
          url: 'https://github.com/org-a/repo',
        },
        project: {
          id: 'P_A',
          number: 1,
          url: 'https://github.com/users/org-a/projects/1',
          owner: { kind: 'organization', login: 'org-a' },
        },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      db: ctx.db,
      close: () => {},
    };
    const items = [
      projectItem(issue('I_task', 3, 'I_story'), 'PVTI_task'),
      projectItem(issue('I_story', 2, 'I_epic'), 'PVTI_story'),
      pullRequestItem('PVTI_pr'),
    ];
    const remote = new Map([
      ['PVTI_task', roundWritebackUsd(1.25)],
      ['PVTI_story', 99],
    ]);
    const deps = mockWritebackDeps({
      fields: [NUMBER_FIELD],
      items,
      remoteByItemId: remote,
    });
    const preview = await buildWritebackPreview(
      reportCtx,
      { fieldName: 'Estimated cost', rollup: 'direct', forceOverwrite: false },
      deps,
    );
    assert.equal(preview.kind, 'writeback_preview');
    assert.equal(preview.mode, 'dry_run');
    assert.equal(preview.summary.wouldSet, 0);
    const taskRow = preview.items.find((i) => i.issue.issueNodeId === 'I_task');
    const storyRow = preview.items.find((i) => i.issue.issueNodeId === 'I_story');
    assert.equal(taskRow?.skipReason, 'unchanged');
    assert.equal(storyRow?.skipReason, 'remote_conflict');
    assert.equal(
      preview.items.some((i) => i.skipReason === 'unsupported_item_type'),
      true,
    );
  } finally {
    disposeDataset(ctx);
  }
});

test('buildWritebackPreview: inclusive requires --issue and matches hierarchy totals', async () => {
  const ctx = loadSyntheticDataset(hierarchyFixture);
  try {
    linkHierarchy(ctx);
    const reportCtx = {
      profile: {
        repository: {
          id: 'R1',
          nameWithOwner: 'org-a/repo',
          url: 'https://github.com/org-a/repo',
        },
        project: {
          id: 'P_A',
          number: 1,
          url: 'https://github.com/users/org-a/projects/1',
          owner: { kind: 'organization', login: 'org-a' },
        },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      db: ctx.db,
      close: () => {},
    };
    const items = [
      projectItem(issue('I_story', 2, 'I_epic'), 'PVTI_story'),
    ];
    const deps = mockWritebackDeps({ fields: [NUMBER_FIELD], items, remoteByItemId: new Map() });
    await assert.rejects(
      () =>
        buildWritebackPreview(
          reportCtx,
          { fieldName: 'Estimated cost', rollup: 'inclusive', forceOverwrite: false },
          deps,
        ),
      (err) => err.code === 'usage_error',
    );
    const preview = await buildWritebackPreview(
      reportCtx,
      {
        fieldName: 'Estimated cost',
        rollup: 'inclusive',
        issueSelectors: ['org-a/repo#2'],
        forceOverwrite: false,
      },
      deps,
    );
    assert.equal(preview.warnings.length, 1);
    const storyRow = preview.items.find((i) => i.issue.issueNodeId === 'I_story');
    assert.equal(storyRow?.computed.knownAmountUsd, 1.75);
    assert.equal(storyRow?.action, 'set');
    assert.equal(storyRow?.proposed, 1.75);
  } finally {
    disposeDataset(ctx);
  }
});

test('buildWritebackPreview: unknown cost and no_usage skips', async () => {
  const ctx = loadSyntheticDataset(hierarchyFixture);
  try {
    linkHierarchy(ctx);
    const reportCtx = {
      profile: {
        repository: {
          id: 'R1',
          nameWithOwner: 'org-a/repo',
          url: 'https://github.com/org-a/repo',
        },
        project: {
          id: 'P_A',
          number: 1,
          url: 'https://github.com/users/org-a/projects/1',
          owner: { kind: 'organization', login: 'org-a' },
        },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      db: ctx.db,
      close: () => {},
    };
    const items = [
      projectItem(issue('I_epic', 1, null), 'PVTI_epic'),
      projectItem(issue('I_task_empty', 4, 'I_story'), 'PVTI_empty'),
    ];
    const deps = mockWritebackDeps({ fields: [NUMBER_FIELD], items });
    const preview = await buildWritebackPreview(
      reportCtx,
      { fieldName: 'Estimated cost', rollup: 'direct', forceOverwrite: false },
      deps,
    );
    const epic = preview.items.find((i) => i.issue.issueNodeId === 'I_epic');
    const empty = preview.items.find((i) => i.issue.issueNodeId === 'I_task_empty');
    assert.equal(epic?.skipReason, 'unknown_cost');
    assert.equal(empty?.skipReason, 'no_usage');
  } finally {
    disposeDataset(ctx);
  }
});

test('duplicate field name fails with exit 2 semantics', async () => {
  const fields = await (async () => {
    process.env.ORCA_TELEMETRY_GH = ghStub;
    process.env.GH_STUB_STDOUT = readFileSync(fieldsDup, 'utf8');
    const { readProjectFields } = await import('../dist/github/fields.js');
    return readProjectFields('PVT_kw', { ghPath: ghStub });
  })().finally(() => {
    delete process.env.GH_STUB_STDOUT;
  });
  await assert.rejects(
    () => Promise.resolve().then(() => selectNumberFieldByName(fields, 'Budget')),
    (err) => err.exitCode === EXIT_USAGE,
  );
});

test('CLI: non-TTY --apply without --yes and inclusive without --issue exit 2', () => {
  const repo = initBareRepo();
  const appHome = mkdtempSync(join(tmpdir(), 'orca-wb-home-'));
  writeReportsProfile(appHome, 'PVT_attr_synthetic_project');
  installDatasetInHome(appHome, () => {});
  const env = writebackEnv(appHome);
  const apply = runCliWriteback(['--field', 'Cost', '--apply'], { cwd: repo, env });
  assert.equal(apply.status, EXIT_USAGE);
  assert.match(apply.stderr + apply.stdout, /requires --yes/i);
  const inclusive = runCliWriteback(['--field', 'Cost', '--rollup', 'inclusive'], {
    cwd: repo,
    env,
  });
  assert.equal(inclusive.status, EXIT_USAGE);
  rmSync(appHome, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

test('buildWritebackPreview JSON shape uses six-decimal proposed values', async () => {
  const ctx = loadSyntheticDataset(hierarchyFixture);
  try {
    linkHierarchy(ctx);
    const reportCtx = {
      profile: {
        repository: {
          id: 'R1',
          nameWithOwner: 'org-a/repo',
          url: 'https://github.com/org-a/repo',
        },
        project: {
          id: 'P_A',
          number: 1,
          url: 'https://github.com/users/org-a/projects/1',
          owner: { kind: 'organization', login: 'org-a' },
        },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      db: ctx.db,
      close: () => {},
    };
    const items = [projectItem(issue('I_task', 3, 'I_story'), 'PVTI_task')];
    const preview = await buildWritebackPreview(
      reportCtx,
      { fieldName: 'Estimated cost', rollup: 'direct', forceOverwrite: false },
      mockWritebackDeps({ fields: [NUMBER_FIELD], items }),
    );
    assert.equal(preview.kind, 'writeback_preview');
    assert.equal(preview.mode, 'dry_run');
    const taskRow = preview.items.find((i) => i.issue.issueNodeId === 'I_task');
    assert.equal(taskRow?.proposed, 1.25);
    assert.equal(taskRow?.computed.costLabel, 'estimated_api_equivalent');
  } finally {
    disposeDataset(ctx);
  }
});
