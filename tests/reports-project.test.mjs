import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { linkSessionToIssue } from '../dist/attribution/link.js';
import { buildProjectReport, formatProjectReportText } from '../dist/reports/project.js';
import { buildTaskReport } from '../dist/reports/tasks.js';
import {
  disposeDataset,
  fixture,
  linkAlphaSessions,
  loadReportsDataset,
  snapshotDbCounts,
} from './helpers/reports-harness.mjs';

const goldenDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/reports/golden');
const multiFixture = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'fixtures/reports/multi-project-dataset.json'),
    'utf8',
  ),
);

const LINKED_AT = '2026-06-01T10:00:00.000Z';

function fakeProfile() {
  return {
    repository: {
      id: 'R_reports',
      nameWithOwner: 'org-a/repo',
      url: 'https://github.com/org-a/repo',
    },
    project: {
      id: fixture.projectId,
      number: 1,
      url: 'https://github.com/users/org-a/projects/1',
      owner: { kind: 'organization', login: 'org-a' },
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

test('T36: golden project text and JSON', () => {
  const ctx = loadReportsDataset();
  linkAlphaSessions(ctx);
  const report = buildProjectReport({
    profile: fakeProfile(),
    db: ctx.db,
    close: () => {},
  });
  const expectedText = readFileSync(join(goldenDir, 'project.txt'), 'utf8');
  const expectedJson = JSON.parse(readFileSync(join(goldenDir, 'project.json'), 'utf8'));
  assert.equal(formatProjectReportText(report), expectedText);
  assert.deepEqual(report, expectedJson);
  disposeDataset(ctx);
});

test('T36: two projects — shared issue deduped, project B includes B-only issue', () => {
  const ctx = loadReportsDataset(multiFixture);
  linkSessionToIssue(ctx.db, {
    provider: 'claude',
    source: 'codeburn',
    rawSessionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    issueNodeId: 'I_shared_cross_project',
    linkedAt: LINKED_AT,
  });
  linkSessionToIssue(ctx.db, {
    provider: 'claude',
    source: 'codeburn',
    rawSessionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    issueNodeId: 'I_only_project_b',
    linkedAt: LINKED_AT,
  });
  const profileA = {
    ...fakeProfile(),
    project: {
      id: multiFixture.projectIdA,
      number: 1,
      url: 'https://github.com/users/org-a/projects/a',
      owner: { kind: 'organization', login: 'org-a' },
    },
  };
  const profileB = {
    ...fakeProfile(),
    project: {
      id: multiFixture.projectIdB,
      number: 2,
      url: 'https://github.com/users/org-b/projects/b',
      owner: { kind: 'organization', login: 'org-b' },
    },
  };
  const reportA = buildProjectReport({ profile: profileA, db: ctx.db, close: () => {} });
  const reportB = buildProjectReport({ profile: profileB, db: ctx.db, close: () => {} });
  assert.equal(reportA.linkedSessionCount, 1);
  assert.equal(reportB.linkedSessionCount, 2);
  const taskShared = buildTaskReport(
    { profile: profileA, db: ctx.db, close: () => {} },
    'I_shared_cross_project',
  );
  assert.equal(taskShared.issue.sessionCount, 1);
  assert.equal(reportA.cost.knownAmountUsd, 0.5);
  assert.equal(reportB.cost.knownAmountUsd, 0.6);
  disposeDataset(ctx);
});

test('T36: unmapped totals are not folded into project cost', () => {
  const ctx = loadReportsDataset();
  linkAlphaSessions(ctx);
  const before = snapshotDbCounts(ctx.db);
  const report = buildProjectReport({
    profile: fakeProfile(),
    db: ctx.db,
    close: () => {},
  });
  assert.deepEqual(snapshotDbCounts(ctx.db), before);
  assert.ok(report.unmappedNotInProjectTotals.sessionCount >= 1);
  disposeDataset(ctx);
});
