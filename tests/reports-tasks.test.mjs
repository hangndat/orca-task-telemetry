import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import {
  buildTaskReport,
  buildTasksReport,
  formatTaskReportText,
} from '../dist/reports/tasks.js';
import {
  disposeDataset,
  fixture,
  linkAlphaSessions,
  loadReportsDataset,
  snapshotDbCounts,
} from './helpers/reports-harness.mjs';

const goldenDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/reports');

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

test('T35: tasks report lists issues with mapping and cost fields', () => {
  const ctx = loadReportsDataset();
  linkAlphaSessions(ctx);
  const before = snapshotDbCounts(ctx.db);
  const report = buildTasksReport({
    profile: fakeProfile(),
    db: ctx.db,
    close: () => {},
  });
  const after = snapshotDbCounts(ctx.db);
  assert.deepEqual(after, before);
  assert.equal(report.kind, 'tasks');
  assert.equal(report.issues.length, 2);
  const alpha = report.issues.find((i) => i.issue.issueNodeId === 'I_attr_issue_alpha');
  assert.equal(alpha.sessionCount, 3);
  assert.equal(alpha.mappingStatus, 'mapped');
  assert.equal(alpha.cost.knownAmountUsd, 1.75);
  assert.equal(alpha.cost.unknownAmountCount, 1);
  const beta = report.issues.find((i) => i.issue.issueNodeId === 'I_attr_issue_beta');
  assert.equal(beta.usageStatus, 'no_usage_data');
  disposeDataset(ctx);
});

test('T35: task report golden JSON shape for alpha', () => {
  const ctx = loadReportsDataset();
  linkAlphaSessions(ctx);
  const report = buildTaskReport(
    { profile: fakeProfile(), db: ctx.db, close: () => {} },
    'I_attr_issue_alpha',
  );
  const golden = JSON.parse(
    readFileSync(join(goldenDir, 'task-alpha.json'), 'utf8'),
  );
  assert.equal(report.issue.sessionCount, golden.sessionCount);
  assert.equal(report.issue.cost.knownAmountUsd, golden.cost.knownAmountUsd);
  assert.equal(report.issue.sessions.length, golden.sessions);
  const text = formatTaskReportText(report);
  assert.match(text, /Sonnet 5/);
  assert.match(text, /unknown/);
  disposeDataset(ctx);
});

test('T35: bare issue number resolves via profile repository', () => {
  const ctx = loadReportsDataset();
  linkAlphaSessions(ctx);
  const report = buildTaskReport(
    { profile: fakeProfile(), db: ctx.db, close: () => {} },
    '1',
  );
  assert.equal(report.issue.issue.number, 1);
  assert.equal(report.issue.sessionCount, 3);
  disposeDataset(ctx);
});
