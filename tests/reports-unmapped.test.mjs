import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { buildUnmappedReport, formatUnmappedReportText, LINK_ISSUE_PLACEHOLDER } from '../dist/reports/unmapped.js';
import {
  disposeDataset,
  fixture,
  linkAlphaSessions,
  loadReportsDataset,
} from './helpers/reports-harness.mjs';

const goldenDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/reports/golden');

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

test('T37: golden unmapped text and JSON', () => {
  const ctx = loadReportsDataset();
  linkAlphaSessions(ctx);
  const report = buildUnmappedReport({
    profile: fakeProfile(),
    db: ctx.db,
    close: () => {},
  });
  const expectedText = readFileSync(join(goldenDir, 'unmapped.txt'), 'utf8');
  const expectedJson = JSON.parse(readFileSync(join(goldenDir, 'unmapped.json'), 'utf8'));
  assert.equal(formatUnmappedReportText(report), expectedText);
  assert.deepEqual(report, expectedJson);
  disposeDataset(ctx);
});

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
  disposeDataset(ctx);
});

test('T37: malicious session id in text table is single-line safe', () => {
  const malicious = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures/reports/malicious-session.json'), 'utf8'),
  );
  const ctx = loadReportsDataset(malicious);
  const report = buildUnmappedReport({
    profile: fakeProfile(),
    db: ctx.db,
    close: () => {},
  });
  const text = formatUnmappedReportText(report);
  const lines = text.split('\n');
  const dataLines = lines.filter((l) => l.includes('session'));
  for (const line of dataLines) {
    assert.ok(!line.includes('\r'));
  }
  assert.doesNotMatch(text, /\nFAKE/);
  const json = JSON.stringify(report);
  assert.match(json, /\\nFAKE/);
  disposeDataset(ctx);
});
