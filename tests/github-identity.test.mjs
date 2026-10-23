import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { EXIT_ENVIRONMENT, EXIT_USAGE } from '../dist/errors.js';
import {
  attributionEligibility,
  parseIssueRef,
  resolveIssue,
} from '../dist/github/identity.js';

const dir = dirname(fileURLToPath(import.meta.url));
const stub = resolve(dir, 'helpers/gh-stub.mjs');
const page1 = resolve(dir, 'fixtures/github/project-items-page1.json');

function withStub(stdout, run) {
  const prevGh = process.env.ORCA_TELEMETRY_GH;
  const prevOut = process.env.GH_STUB_STDOUT;
  process.env.ORCA_TELEMETRY_GH = stub;
  process.env.GH_STUB_STDOUT = stdout;
  return run().finally(() => {
    if (prevGh === undefined) delete process.env.ORCA_TELEMETRY_GH;
    else process.env.ORCA_TELEMETRY_GH = prevGh;
    if (prevOut === undefined) delete process.env.GH_STUB_STDOUT;
    else process.env.GH_STUB_STDOUT = prevOut;
  });
}

function expectUsage(fn) {
  try {
    fn();
    assert.fail('expected usage_error');
  } catch (err) {
    assert.equal(err.code, 'usage_error');
    assert.equal(err.exitCode, EXIT_USAGE);
    assert.ok(err.hint?.includes('github.com'));
    return err;
  }
}

test('AC1: parses valid URLs and owner/repo#n', () => {
  assert.deepEqual(
    parseIssueRef('https://github.com/hangndat/orca-task-telemetry/issues/3'),
    { owner: 'hangndat', repo: 'orca-task-telemetry', number: 3 },
  );
  assert.deepEqual(
    parseIssueRef(
      'https://www.github.com/hangndat/orca-task-telemetry/issues/3/?q=1#discussioncomment-1',
    ),
    { owner: 'hangndat', repo: 'orca-task-telemetry', number: 3 },
  );
  assert.deepEqual(
    parseIssueRef('hangndat/orca-task-telemetry#42'),
    { owner: 'hangndat', repo: 'orca-task-telemetry', number: 42 },
  );
});

test('AC2: rejects PR URLs, bad hosts, invalid numbers and names', () => {
  expectUsage(() =>
    parseIssueRef('https://github.com/hangndat/orca-task-telemetry/pull/1'),
  );
  expectUsage(() =>
    parseIssueRef('https://gitlab.com/hangndat/r/issues/1'),
  );
  expectUsage(() =>
    parseIssueRef('https://github.com/hangndat/orca-task-telemetry/issues/0'),
  );
  expectUsage(() =>
    parseIssueRef('https://github.com/hangndat/orca-task-telemetry/issues/abc'),
  );
  expectUsage(() => parseIssueRef('-invalid/repo#1'));
});

test('AC3: resolveIssue returns GitHubIssue on success', async () => {
  const stdout = JSON.stringify({
    data: {
      repository: {
        issue: {
          id: 'I_kwDOVUhnY88AAAABZZE2rQ',
          number: 3,
          url: 'https://github.com/hangndat/orca-task-telemetry/issues/3',
          title: '[E01]',
          state: 'OPEN',
          repository: { nameWithOwner: 'hangndat/orca-task-telemetry' },
        },
        pullRequest: null,
      },
    },
  });
  await withStub(stdout, async () => {
    const issue = await resolveIssue(
      { owner: 'hangndat', repo: 'orca-task-telemetry', number: 3 },
      { ghPath: stub },
    );
    assert.equal(issue.issueNodeId, 'I_kwDOVUhnY88AAAABZZE2rQ');
    assert.equal(issue.number, 3);
  });
});

test('AC3: resolveIssue not found → github_issue_not_found exit 3', async () => {
  const stdout = JSON.stringify({
    data: {
      repository: { issue: null, pullRequest: null },
    },
  });
  await withStub(stdout, async () => {
    await assert.rejects(
      () =>
        resolveIssue(
          { owner: 'hangndat', repo: 'orca-task-telemetry', number: 99999 },
          { ghPath: stub },
        ),
      (err) => {
        assert.equal(err.code, 'github_issue_not_found');
        assert.equal(err.exitCode, EXIT_ENVIRONMENT);
        return true;
      },
    );
  });
});

test('AC3: resolveIssue PR number → github_not_an_issue exit 2', async () => {
  const stdout = JSON.stringify({
    data: {
      repository: {
        issue: null,
        pullRequest: { id: 'PR_kwDO', number: 10 },
      },
    },
  });
  await withStub(stdout, async () => {
    await assert.rejects(
      () =>
        resolveIssue(
          { owner: 'hangndat', repo: 'orca-task-telemetry', number: 10 },
          { ghPath: stub },
        ),
      (err) => {
        assert.equal(err.code, 'github_not_an_issue');
        assert.equal(err.exitCode, EXIT_USAGE);
        return true;
      },
    );
  });
});

test('AC3: transferred issue uses repository from GraphQL response', async () => {
  const stdout = JSON.stringify({
    data: {
      repository: {
        issue: {
          id: 'I_transferred',
          number: 7,
          url: 'https://github.com/new-org/new-repo/issues/7',
          title: 'Moved issue',
          state: 'OPEN',
          repository: { nameWithOwner: 'new-org/new-repo' },
        },
        pullRequest: null,
      },
    },
  });
  await withStub(stdout, async () => {
    const issue = await resolveIssue(
      { owner: 'old-org', repo: 'old-repo', number: 7 },
      { ghPath: stub },
    );
    assert.equal(issue.repository.nameWithOwner, 'new-org/new-repo');
    assert.match(issue.url, /new-org\/new-repo/);
  });
});

test('AC4: attributionEligibility by content type', () => {
  const base = {
    projectId: 'PVT_x',
    itemId: 'PVTI_x',
    issue: null,
  };
  assert.deepEqual(
    attributionEligibility({
      ...base,
      contentType: 'Issue',
      issue: {
        issueNodeId: 'I_x',
        repository: { nameWithOwner: 'o/r' },
        number: 1,
        url: 'https://github.com/o/r/issues/1',
        title: 't',
        state: 'OPEN',
      },
    }),
    { eligible: true, reason: 'issue' },
  );
  assert.deepEqual(
    attributionEligibility({ ...base, contentType: 'PullRequest' }),
    { eligible: false, reason: 'pull_request' },
  );
  assert.deepEqual(
    attributionEligibility({ ...base, contentType: 'DraftIssue' }),
    { eligible: false, reason: 'draft_issue' },
  );
  assert.deepEqual(
    attributionEligibility({ ...base, contentType: 'Redacted' }),
    { eligible: false, reason: 'redacted' },
  );
});

test('fixture issue #3 node id matches resolve shape', () => {
  const fixture = JSON.parse(readFileSync(page1, 'utf8'));
  const node = fixture.data.node.items.nodes[0].content;
  assert.equal(node.id, 'I_kwDOVUhnY88AAAABZZE2rQ');
  assert.equal(node.number, 3);
});
