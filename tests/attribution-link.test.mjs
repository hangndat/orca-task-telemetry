import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { sessionKey } from '../dist/contracts.js';
import { linkSessionToIssue } from '../dist/attribution/link.js';
import { disposeDataset, loadSyntheticDataset } from './helpers/attribution-dataset.mjs';

const dir = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(dir, 'fixtures/attribution/synthetic-dataset.json'), 'utf8'),
);

const LINKED_AT = '2026-06-01T10:00:00.000Z';
const CLAUDE_1 = 'aaaaaaaa-claude-4ccc-8ddd-eeeeeeeeee01';

test('T29: new link creates manual link with linkedBy null', () => {
  const ctx = loadSyntheticDataset(fixture);
  const result = linkSessionToIssue(ctx.db, {
    provider: 'claude',
    source: 'agent-top',
    rawSessionId: CLAUDE_1,
    issueNodeId: 'I_attr_issue_alpha',
    linkedAt: LINKED_AT,
  });
  assert.equal(result.outcome, 'created');
  assert.equal(result.link.method, 'manual');
  assert.equal(result.link.linkedBy, null);
  assert.equal(result.link.linkedAt, LINKED_AT);
  disposeDataset(ctx);
});

test('T29: identical link is no-op and preserves timestamp', () => {
  const ctx = loadSyntheticDataset(fixture);
  linkSessionToIssue(ctx.db, {
    provider: 'claude',
    source: 'agent-top',
    rawSessionId: CLAUDE_1,
    issueNodeId: 'I_attr_issue_alpha',
    linkedAt: LINKED_AT,
  });
  const second = linkSessionToIssue(ctx.db, {
    provider: 'claude',
    source: 'agent-top',
    rawSessionId: CLAUDE_1,
    issueNodeId: 'I_attr_issue_alpha',
    linkedAt: '2026-07-01T00:00:00.000Z',
  });
  assert.equal(second.outcome, 'unchanged');
  assert.equal(second.link.linkedAt, LINKED_AT);
  disposeDataset(ctx);
});

test('T29: link to different issue conflicts with existing ref', () => {
  const ctx = loadSyntheticDataset(fixture);
  linkSessionToIssue(ctx.db, {
    provider: 'claude',
    source: 'agent-top',
    rawSessionId: CLAUDE_1,
    issueNodeId: 'I_attr_issue_alpha',
    linkedAt: LINKED_AT,
  });
  assert.throws(
    () =>
      linkSessionToIssue(ctx.db, {
        provider: 'claude',
        source: 'agent-top',
        rawSessionId: CLAUDE_1,
        issueNodeId: 'I_attr_issue_beta',
        linkedAt: LINKED_AT,
      }),
    (err) =>
      err.code === 'attribution_link_conflict' &&
      err.message.includes('I_attr_issue_alpha'),
  );
  disposeDataset(ctx);
});

test('T29: unknown session and unknown issue are actionable', () => {
  const ctx = loadSyntheticDataset(fixture);
  assert.throws(
    () =>
      linkSessionToIssue(ctx.db, {
        provider: 'claude',
        source: 'agent-top',
        rawSessionId: 'missing-session-id',
        issueNodeId: 'I_attr_issue_alpha',
        linkedAt: LINKED_AT,
      }),
    (err) => err.code === 'attribution_session_unknown',
  );
  assert.throws(
    () =>
      linkSessionToIssue(ctx.db, {
        provider: 'claude',
        source: 'agent-top',
        rawSessionId: CLAUDE_1,
        issueNodeId: 'I_does_not_exist',
        linkedAt: LINKED_AT,
      }),
    (err) => err.code === 'attribution_issue_unknown',
  );
  disposeDataset(ctx);
});

test('T29: two sessions can link to one issue', () => {
  const ctx = loadSyntheticDataset(fixture);
  linkSessionToIssue(ctx.db, {
    provider: 'claude',
    source: 'agent-top',
    rawSessionId: CLAUDE_1,
    issueNodeId: 'I_attr_issue_alpha',
    linkedAt: LINKED_AT,
  });
  linkSessionToIssue(ctx.db, {
    provider: 'claude',
    source: 'agent-top',
    rawSessionId: 'aaaaaaaa-claude-4ccc-8ddd-eeeeeeeeee02',
    issueNodeId: 'I_attr_issue_alpha',
    linkedAt: LINKED_AT,
  });
  const count = ctx.db
    .prepare(
      "SELECT COUNT(*) AS c FROM session_links WHERE issue_node_id = 'I_attr_issue_alpha'",
    )
    .get().c;
  assert.equal(count, 2);
  disposeDataset(ctx);
});

test('T29: same raw id different provider namespaces are distinct', () => {
  const ctx = loadSyntheticDataset(fixture);
  const shared = fixture.sharedRawSessionId;
  linkSessionToIssue(ctx.db, {
    provider: 'claude',
    source: 'agent-top',
    rawSessionId: shared,
    issueNodeId: 'I_attr_issue_alpha',
    linkedAt: LINKED_AT,
  });
  const codex = linkSessionToIssue(ctx.db, {
    provider: 'codex',
    source: 'agent-top',
    rawSessionId: shared,
    issueNodeId: 'I_attr_issue_beta',
    linkedAt: LINKED_AT,
  });
  assert.equal(codex.outcome, 'created');
  assert.notEqual(
    sessionKey('claude', 'agent-top', shared),
    sessionKey('codex', 'agent-top', shared),
  );
  disposeDataset(ctx);
});
