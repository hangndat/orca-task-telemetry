import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  CLAUDE_SUBAGENT_POLICY,
  ContractParseError,
  COST_KINDS,
  ORCA_EXECUTION_PREFIX,
  PROJECT_ITEM_CONTENT_TYPES,
  SESSION_LINK_METHODS,
  USAGE_PROVIDERS,
  USAGE_SOURCES,
  orcaExecutionKey,
  parseOrcaExecutionKey,
  parseSessionKey,
  sessionKey,
} from '../dist/contracts.js';

const CLAUDE_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee01';
const CODEX_UUID = '01a10000-bbbb-4ccc-8ddd-eeeeeeeeee01';
const DISPATCH_ID = 'ctx_005f2513ac06';
const WORKTREE_ID =
  '161803f0-8d29-4bf2-90d8-b774907ef80d::/Users/admin/orca/workspaces/orca-task-telemetry/Foundation';

test('sessionKey round-trip for claude and codex', () => {
  const claudeKey = sessionKey('claude', 'agent-top', CLAUDE_UUID);
  assert.equal(claudeKey, `claude:agent-top:${CLAUDE_UUID}`);
  assert.deepEqual(parseSessionKey(claudeKey), {
    provider: 'claude',
    source: 'agent-top',
    rawId: CLAUDE_UUID,
  });

  const codexKey = sessionKey('codex', 'agent-top', CODEX_UUID);
  assert.equal(codexKey, `codex:agent-top:${CODEX_UUID}`);
  assert.deepEqual(parseSessionKey(codexKey), {
    provider: 'codex',
    source: 'agent-top',
    rawId: CODEX_UUID,
  });
});

test('claude and codex with same rawId produce different sessionKeys', () => {
  const shared = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee01';
  const a = sessionKey('claude', 'agent-top', shared);
  const b = sessionKey('codex', 'agent-top', shared);
  assert.notEqual(a, b);
});

test('parseSessionKey rejects unknown provider, source, and empty rawId', () => {
  assert.throws(
    () => parseSessionKey('openai:agent-top:abc'),
    ContractParseError,
  );
  assert.throws(
    () => parseSessionKey('claude:unknown:abc'),
    ContractParseError,
  );
  assert.throws(() => sessionKey('claude', 'agent-top', ''), ContractParseError);
  assert.throws(
    () => parseSessionKey('claude:agent-top:'),
    ContractParseError,
  );
  assert.throws(
    () => parseSessionKey('too:few:segments:here'),
    ContractParseError,
  );
});

test('orcaExecutionKey round-trip with dispatch and worktree rawId containing colons', () => {
  const byDispatch = orcaExecutionKey('local', DISPATCH_ID);
  assert.equal(byDispatch, `orca:local:${DISPATCH_ID}`);
  assert.deepEqual(parseOrcaExecutionKey(byDispatch), {
    hostId: 'local',
    rawId: DISPATCH_ID,
  });

  const byWorktree = orcaExecutionKey('local', WORKTREE_ID);
  assert.equal(byWorktree, `orca:local:${WORKTREE_ID}`);
  assert.deepEqual(parseOrcaExecutionKey(byWorktree), {
    hostId: 'local',
    rawId: WORKTREE_ID,
  });
});

test('contract constants are frozen vocabulary', () => {
  assert.deepEqual([...USAGE_PROVIDERS], ['claude', 'codex']);
  assert.deepEqual([...USAGE_SOURCES], ['agent-top']);
  assert.equal(ORCA_EXECUTION_PREFIX, 'orca');
  assert.equal(CLAUDE_SUBAGENT_POLICY, 'separate_session_per_row');
  assert.ok(COST_KINDS.includes('estimated_api_equivalent'));
  assert.ok(SESSION_LINK_METHODS.includes('manual'));
  assert.ok(PROJECT_ITEM_CONTENT_TYPES.includes('DraftIssue'));
});
