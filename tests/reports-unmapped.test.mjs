import assert from 'node:assert/strict';
import { test } from 'vitest';
import { buildUnmappedReport, LINK_ISSUE_PLACEHOLDER } from '../dist/reports/unmapped.js';
import {
  disposeDataset,
  fixture,
  linkAlphaSessions,
  loadReportsDataset,
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

test('T37: unmapped lists only sessions without SessionLink', () => {
  const ctx = loadReportsDataset();
  linkAlphaSessions(ctx);
  const report = buildUnmappedReport({
    profile: fakeProfile(),
    db: ctx.db,
    close: () => {},
  });
  assert.equal(report.sessions.length, 1);
  assert.equal(report.sessions[0].provider, 'claude');
  assert.equal(report.sessions[0].rawSessionId, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  assert.ok(report.sessions[0].linkSuggestion.includes(LINK_ISSUE_PLACEHOLDER));
  assert.match(report.sessions[0].linkSuggestion, /--session/);
  disposeDataset(ctx);
});

test('T37: all sessions unmapped when nothing linked', () => {
  const ctx = loadReportsDataset();
  const report = buildUnmappedReport({
    profile: fakeProfile(),
    db: ctx.db,
    close: () => {},
  });
  assert.equal(report.sessions.length, 4);
  disposeDataset(ctx);
});
