import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { parsePullRef, readPullTrace } from '../dist/github/pull-trace.js';

const stub = resolve(dirname(fileURLToPath(import.meta.url)), 'helpers/gh-pull-trace-stub.mjs');
const oid1 = 'a'.repeat(40);
const oid2 = 'b'.repeat(40);
const pull = {
  id: 'PR_1', number: 7, url: 'https://github.com/new/repo/pull/7',
  state: 'OPEN', isDraft: true, mergedAt: null, headRefOid: oid2, repository: { nameWithOwner: 'new/repo' },
};
const issuePage = (ids, hasNextPage = false, endCursor = null) => ({ data: { rateLimit: { remaining: 100, resetAt: '2026-10-24T00:00:00Z' }, node: { __typename: 'PullRequest', id: 'PR_1', closingIssuesReferences: { nodes: ids.map(id => ({ id })), pageInfo: { hasNextPage, endCursor } } } } });
const commitPage = (oids, hasNextPage = false, endCursor = null) => ({ data: { rateLimit: { remaining: 100, resetAt: '2026-10-24T00:00:00Z' }, node: { __typename: 'PullRequest', id: 'PR_1', commits: { nodes: oids.map(oid => ({ commit: { oid, url: `https://github.com/new/repo/commit/${oid}` } })), pageInfo: { hasNextPage, endCursor } } } } });
const resolveStep = { query: 'ResolveTracePull', body: { data: { repository: { pullRequest: pull, issue: null } } } };
const finalStep = { query: 'TracePullNode', body: { data: { node: { __typename: 'PullRequest', ...pull } } } };
const ref = { owner: 'old', repo: 'repo', number: 7 };

async function run(steps, targets = {}, options = {}, inputRef = ref) {
  const dir = mkdtempSync(join(tmpdir(), 'pull-trace-'));
  const counter = join(dir, 'counter');
  writeFileSync(counter, '0');
  const previous = [process.env.GH_PULL_TRACE_STEPS, process.env.GH_PULL_TRACE_COUNTER];
  process.env.GH_PULL_TRACE_STEPS = JSON.stringify(steps);
  process.env.GH_PULL_TRACE_COUNTER = counter;
  try {
    return await readPullTrace(inputRef, targets, { ghPath: stub, now: () => new Date('2026-10-24T00:00:00Z'), ...options });
  } finally {
    if (previous[0] === undefined) delete process.env.GH_PULL_TRACE_STEPS;
    else process.env.GH_PULL_TRACE_STEPS = previous[0];
    if (previous[1] === undefined) delete process.env.GH_PULL_TRACE_COUNTER;
    else process.env.GH_PULL_TRACE_COUNTER = previous[1];
    rmSync(dir, { recursive: true, force: true });
  }
}

test('parse only safe PR URL and shorthand', () => {
  assert.deepEqual(parsePullRef('https://github.com/o/r/pull/7/'), { owner: 'o', repo: 'r', number: 7 });
  assert.deepEqual(parsePullRef('o/r#7'), { owner: 'o', repo: 'r', number: 7 });
  for (const bad of ['https://evil.test/o/r/pull/7', 'http://github.com/o/r/pull/7', 'https://github.com/o/r/issues/7', 'https://github.com/o/r/pull/7/files', 'https://github.com/o/r/pull/0', 'o/r#9007199254740993', 'https://github.com.evil.test/o/r/pull/7']) {
    assert.throws(() => parsePullRef(bad), { code: 'usage_error' });
  }
});

test('canonical rename, two issue pages, duplicate refs/commits, and absent target', async () => {
  const result = await run([
    resolveStep,
    { query: 'TracePullIssues', after: null, body: issuePage(['I_other'], true, 'i1') },
    { query: 'TracePullIssues', after: 'i1', body: issuePage(['I_target', 'I_target']) },
    { query: 'TracePullCommits', after: null, body: commitPage([oid1], true, 'c1') },
    { query: 'TracePullCommits', after: 'c1', body: commitPage([oid1, oid2]) },
    finalStep,
  ], { issueNodeIds: ['I_target', 'I_missing'], commitOids: [oid2, 'c'.repeat(40)] });
  assert.equal(result.status, 'verified_current');
  assert.equal(result.pull.pullNodeId, 'PR_1');
  assert.equal(result.pull.url, 'https://github.com/new/repo/pull/7');
  assert.equal(result.pull.mergedAt, null);
  assert.equal(result.closingIssueNodeIds.length, 2);
  assert.equal(result.commits.length, 2);
  assert.equal(result.issueRelations.I_target.status, 'verified_current');
  assert.equal(result.issueRelations.I_missing.status, 'stale');
  assert.equal(result.commitRelations[oid2].status, 'verified_current');
  assert.equal(result.commitRelations['c'.repeat(40)].status, 'stale');
  assert.equal(result.issueRelations.I_target.lastVerifiedAt, result.observedAt);
});

test('Issue number at PR ref is rejected; inaccessible/404 is unknown', async () => {
  await assert.rejects(() => run([
    { query: 'ResolveTracePull', body: { data: { repository: { pullRequest: null } } } },
    { query: 'TracePullIssueKind', body: { data: { repository: { issue: { id: 'I_1' } } } } },
  ]), { code: 'not_pull_request' });
  const unknown = await run([{ query: 'ResolveTracePull', body: { data: { repository: null } } }], { issueNodeIds: ['I_1'] });
  assert.equal(unknown.status, 'unknown');
  assert.equal(unknown.pull, null);
  assert.equal(unknown.issueRelations.I_1.lastVerifiedAt, null);
  await assert.rejects(() => run([
    { query: 'ResolveTracePull', body: { data: { repository: { pullRequest: null } }, errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to a PullRequest' }] }, exitCode: 1 },
    { query: 'TracePullIssueKind', body: { data: { repository: { issue: { id: 'I_1' } } } } },
  ]), { code: 'not_pull_request' });
  const denied = await run([{ query: 'ResolveTracePull', body: { errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible by integration' }] }, exitCode: 1 }], { issueNodeIds: ['I_1'] });
  assert.equal(denied.status, 'unknown');
});

test('partial GraphQL error and a late page error never verify presence or absence', async () => {
  const targets = { issueNodeIds: ['I_target'], commitOids: [oid1] };
  for (const failure of [
    [{ query: 'TracePullIssues', body: { data: { node: { id: 'PR_1' } }, errors: [{ message: 'rate limit exceeded', type: 'RATE_LIMITED' }] } }],
    [{ query: 'TracePullIssues', body: issuePage(['I_target']) }, { query: 'TracePullCommits', body: { data: { node: null } } }],
  ]) {
    const result = await run([resolveStep, ...failure], targets);
    assert.equal(result.status, 'unknown');
    assert.equal(result.issueRelations.I_target.status, 'unknown');
    assert.equal(result.commitRelations[oid1].status, 'unknown');
    assert.equal(result.closingIssueNodeIds, null);
  }
});

test('cursor loop, cap, bad node shape, and changed PR are unknown', async () => {
  const cases = [
    [resolveStep, { query: 'TracePullIssues', body: issuePage(['I_target'], true, 'same') }, { query: 'TracePullIssues', after: 'same', body: issuePage([], true, 'same') }],
    [resolveStep, { query: 'TracePullIssues', body: issuePage(['I_target'], true, 'next') }],
    [resolveStep, { query: 'TracePullIssues', body: { data: { node: { id: 'PR_1', closingIssuesReferences: { nodes: null } }, rateLimit: { remaining: 100 } } } }],
    [resolveStep, { query: 'TracePullIssues', body: issuePage(['I_target']) }, { query: 'TracePullCommits', body: commitPage([oid1]) }, { query: 'TracePullNode', body: { data: { node: { __typename: 'PullRequest', ...pull, state: 'MERGED' } } } }],
    [resolveStep, { query: 'TracePullIssues', body: issuePage(['I_target']) }, { query: 'TracePullCommits', body: commitPage([oid1]) }, { query: 'TracePullNode', body: { data: { node: { __typename: 'PullRequest', ...pull, headRefOid: oid1 } } } }],
  ];
  for (const [index, steps] of cases.entries()) {
    const result = await run(steps, { issueNodeIds: ['I_target'] }, index === 1 ? { maxPages: 1 } : {});
    assert.equal(result.status, 'unknown');
    assert.equal(result.issueRelations.I_target.status, 'unknown');
  }
});

test('node ID refresh preserves identity across transfer and uses canonical metadata', async () => {
  const result = await run([
    { query: 'TracePullNode', body: { data: { node: { __typename: 'PullRequest', ...pull } } } },
    { query: 'TracePullIssues', body: issuePage(['I_target']) },
    { query: 'TracePullCommits', body: commitPage([]) },
    finalStep,
  ], { issueNodeIds: ['I_target'] }, {}, { pullNodeId: 'PR_1' });
  assert.equal(result.status, 'verified_current');
  assert.equal(result.pull.repository.nameWithOwner, 'new/repo');
});
