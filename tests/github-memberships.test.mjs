import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { normalizeProjectMemberships } from '../dist/github/memberships.js';

const dir = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(dir, 'fixtures/github/synthetic-memberships.json'), 'utf8'),
);

test('T16: two repos, one issue on two projects, duplicate items deduped', () => {
  const result = normalizeProjectMemberships(fixture.items);
  assert.equal(result.issues.length, 2);
  assert.equal(result.memberships.length, 3);
  assert.equal(result.excluded.length, 1);
  assert.equal(result.excluded[0].reason, 'pull_request');
  const shared = result.memberships.filter(
    (m) => m.issueNodeId === 'I_synthetic_shared_issue_001',
  );
  assert.equal(shared.length, 2);
  assert.ok(
    result.issues.some(
      (i) => i.repository.nameWithOwner === 'org-alpha/repo-a',
    ),
  );
  assert.ok(
    result.issues.some(
      (i) => i.repository.nameWithOwner === 'org-beta/repo-b',
    ),
  );
});

test('T16: issues distinct by node id not title', () => {
  const items = [
    {
      projectId: 'P1',
      itemId: 'i1',
      contentType: 'Issue',
      issue: {
        issueNodeId: 'I_same',
        repository: { nameWithOwner: 'o/r' },
        number: 1,
        url: 'https://github.com/o/r/issues/1',
        title: 'Title A',
        state: 'OPEN',
      },
    },
    {
      projectId: 'P2',
      itemId: 'i2',
      contentType: 'Issue',
      issue: {
        issueNodeId: 'I_same',
        repository: { nameWithOwner: 'o/r' },
        number: 1,
        url: 'https://github.com/o/r/issues/1',
        title: 'Title B',
        state: 'OPEN',
      },
    },
  ];
  const result = normalizeProjectMemberships(items);
  assert.equal(result.issues.length, 1);
  assert.equal(result.memberships.length, 2);
});
