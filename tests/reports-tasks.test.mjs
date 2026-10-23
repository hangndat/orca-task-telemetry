import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import {
  buildTaskReport,
  buildTasksReport,
  formatTaskReportText,
  formatTasksReportText,
} from '../dist/reports/tasks.js';
import { linkSessionToIssue } from '../dist/attribution/link.js';
import {
  disposeDataset,
  fixture,
  linkAlphaSessions,
  loadReportsDataset,
} from './helpers/reports-harness.mjs';

const LINKED_AT = '2026-06-01T10:00:00.000Z';

const goldenDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/reports/golden');
const maliciousFixture = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'fixtures/reports/malicious-titles.json'),
    'utf8',
  ),
);

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

test('T35: golden tasks text and JSON', () => {
  const ctx = loadReportsDataset();
  linkAlphaSessions(ctx);
  const report = buildTasksReport({
    profile: fakeProfile(),
    db: ctx.db,
    close: () => {},
  });
  const expectedText = readFileSync(join(goldenDir, 'tasks.txt'), 'utf8');
  const expectedJson = JSON.parse(readFileSync(join(goldenDir, 'tasks.json'), 'utf8'));
  assert.equal(formatTasksReportText(report), expectedText);
  assert.deepEqual(report, expectedJson);
  disposeDataset(ctx);
});

test('T35: golden task-alpha text and JSON', () => {
  const ctx = loadReportsDataset();
  linkAlphaSessions(ctx);
  const report = buildTaskReport(
    { profile: fakeProfile(), db: ctx.db, close: () => {} },
    'I_attr_issue_alpha',
  );
  const expectedText = readFileSync(join(goldenDir, 'task-alpha.txt'), 'utf8');
  const expectedJson = JSON.parse(readFileSync(join(goldenDir, 'task-alpha.json'), 'utf8'));
  assert.equal(formatTaskReportText(report), expectedText);
  assert.deepEqual(report, expectedJson);
  disposeDataset(ctx);
});

test('T35: malicious issue title does not inject newlines in text report', () => {
  const ctx = loadReportsDataset(maliciousFixture);
  linkSessionToIssue(ctx.db, {
    provider: 'claude',
    source: 'codeburn',
    rawSessionId: 'aaaaaaaa-claude-4ccc-8ddd-eeeeeeeeee01',
    issueNodeId: 'I_attr_issue_alpha',
    linkedAt: LINKED_AT,
  });
  const report = buildTaskReport(
    { profile: fakeProfile(), db: ctx.db, close: () => {} },
    'I_attr_issue_alpha',
  );
  const text = formatTaskReportText(report);
  assert.doesNotMatch(text, /\nINJECTED/);
  assert.match(text, /Evil INJECTED/);
  const roundtrip = JSON.parse(JSON.stringify(report));
  assert.equal(roundtrip.issue.issue.title, maliciousFixture.issues[0].title);
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
