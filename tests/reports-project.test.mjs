import assert from 'node:assert/strict';
import { test } from 'vitest';
import { buildProjectReport } from '../dist/reports/project.js';
import {
  disposeDataset,
  fixture,
  linkAlphaSessions,
  loadReportsDataset,
  snapshotDbCounts,
} from './helpers/reports-harness.mjs';

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

test('T36: project report dedupes session across duplicate memberships', () => {
  const ctx = loadReportsDataset();
  linkAlphaSessions(ctx);
  const before = snapshotDbCounts(ctx.db);
  const report = buildProjectReport({
    profile: fakeProfile(),
    db: ctx.db,
    close: () => {},
  });
  assert.deepEqual(snapshotDbCounts(ctx.db), before);
  assert.equal(report.linkedSessionCount, 3);
  assert.equal(report.cost.knownAmountUsd, 1.75);
  assert.ok(report.unmappedNotInProjectTotals.sessionCount >= 1);
  const claude = report.totalsByProvider.find((p) => p.provider === 'claude');
  assert.ok(claude);
  assert.equal(claude.mixedModelAllocation, 'unknown');
  disposeDataset(ctx);
});

test('T36: unmapped totals are not folded into project cost', () => {
  const ctx = loadReportsDataset();
  linkAlphaSessions(ctx);
  const report = buildProjectReport({
    profile: fakeProfile(),
    db: ctx.db,
    close: () => {},
  });
  const unmappedCost = report.unmappedNotInProjectTotals.costKnownUsd;
  assert.ok(unmappedCost >= 0);
  assert.notEqual(report.cost.knownAmountUsd, report.cost.knownAmountUsd + unmappedCost);
  disposeDataset(ctx);
});
