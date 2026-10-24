import assert from 'node:assert/strict';
import { test } from 'vitest';
import { collectStoredTraces } from '../dist/commands/trace.js';
import { at, oidA, oidB, setupTraceDb } from './helpers/trace-slice3-harness.mjs';

// Synthetic/redacted readPullTrace evidence; pagination/cap behavior is tested in pull-trace tests.
function evidence(id, { status = 'verified_current', issues = ['I_1'], commits = [oidA, oidB],
  errorCode = null, observedAt = at } = {}) {
  return { pull: status === 'unknown' ? null : { pullNodeId: id,
    repository: { nameWithOwner: 'o/r' }, number: Number(id.slice(3)),
    url: `https://github.com/o/r/pull/${id.slice(3)}`,
    state: 'OPEN', isDraft: true, mergedAt: null, headRefOid: oidA },
    observedAt, status, closingIssueNodeIds: status === 'unknown' ? null : issues,
    commits: status === 'unknown' ? null : commits.map(oid => ({ oid, url: `https://github.com/o/r/commit/${oid}` })),
    issueRelations: {}, commitRelations: {}, errorCode };
}

function rows(db, sql) { return db.prepare(sql).all(); }

test('collect reads each stored PR once, preserves manual links/snapshots, and repeated evidence is logically idempotent', async () => {
  const fixture = setupTraceDb();
  try {
    fixture.db.prepare(`INSERT INTO session_pull_links
      (session_key, issue_node_id, pull_node_id, method, linked_at)
      VALUES ('codex:codeburn:s2', 'I_1', 'PR_7', 'manual', ?)`)
      .run(at);
    const seen = [];
    const read = async ({ pullNodeId }) => { seen.push(pullNodeId); return evidence(pullNodeId); };
    const before = rows(fixture.db, 'SELECT * FROM usage_snapshots ORDER BY session_key');
    const first = await collectStoredTraces(fixture.db, read);
    const afterFirst = rows(fixture.db, 'SELECT * FROM issue_pull_relations ORDER BY pull_node_id');
    const second = await collectStoredTraces(fixture.db, read);
    assert.deepEqual(seen, ['PR_7', 'PR_8', 'PR_7', 'PR_8']);
    assert.equal(first.exitCode, 0);
    assert.equal(second.exitCode, 0);
    assert.deepEqual(rows(fixture.db, 'SELECT * FROM issue_pull_relations ORDER BY pull_node_id'), afterFirst);
    assert.deepEqual(rows(fixture.db, 'SELECT * FROM usage_snapshots ORDER BY session_key'), before);
    assert.equal(rows(fixture.db, 'SELECT * FROM session_pull_links').length, 3);
    assert.equal(rows(fixture.db, 'SELECT * FROM session_commit_links').length, 4);
  } finally { fixture.close(); }
});

test('complete refresh marks absent relations stale; partial/auth/rate retains last verification and audit links', async () => {
  const fixture = setupTraceDb();
  try {
    const stale = await collectStoredTraces(fixture.db, async ({ pullNodeId }) =>
      evidence(pullNodeId, { issues: [], commits: [], observedAt: '2026-10-25T00:00:00Z' }));
    assert.equal(stale.exitCode, 0);
    assert.deepEqual(rows(fixture.db, 'SELECT DISTINCT status FROM issue_pull_relations').map(row => row.status), ['stale']);
    const last = rows(fixture.db, 'SELECT last_verified_at FROM issue_pull_relations ORDER BY pull_node_id');
    const partial = await collectStoredTraces(fixture.db, async ({ pullNodeId }) =>
      pullNodeId === 'PR_7' ? evidence(pullNodeId, { status: 'unknown', errorCode: 'trace_auth' }) : evidence(pullNodeId));
    assert.equal(partial.exitCode, 5);
    assert.equal(partial.unknownCount, 1);
    assert.deepEqual(rows(fixture.db, 'SELECT last_verified_at FROM issue_pull_relations ORDER BY pull_node_id')[0], last[0]);
    assert.deepEqual(rows(fixture.db, 'SELECT status FROM issue_pull_relations ORDER BY pull_node_id').map(row => row.status),
      ['unknown', 'verified_current']);
    const failed = await collectStoredTraces(fixture.db, async () => { throw new Error('private token secret'); });
    assert.equal(failed.exitCode, 4);
    assert.ok(failed.pulls.every(item => item.errorCode === 'trace_partial'));
    assert.equal(rows(fixture.db, 'SELECT * FROM session_commit_links').length, 4);
  } finally { fixture.close(); }
});

test('collect with no stored PR returns an empty successful result without GitHub reads', async () => {
  const fixture = setupTraceDb();
  try {
    fixture.db.prepare('DELETE FROM session_commit_links').run();
    fixture.db.prepare('DELETE FROM session_pull_links').run();
    fixture.db.prepare('DELETE FROM pull_commits').run();
    fixture.db.prepare('DELETE FROM issue_pull_relations').run();
    fixture.db.prepare('DELETE FROM pull_requests').run();
    const result = await collectStoredTraces(fixture.db, async () => {
      throw new Error('Unexpected GitHub read');
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.pullCount, 0);
    assert.deepEqual(result.pulls, []);
  } finally { fixture.close(); }
});
