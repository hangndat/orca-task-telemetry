import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { sessionKey } from '../dist/contracts.js';
import { importCodeBurnUsage } from '../dist/db/index.js';
import { linkSessionToIssue } from '../dist/attribution/link.js';
import {
  assertUsageIntegrity,
  buildUsageIntegrityReport,
  listUnmappedSessions,
} from '../dist/attribution/unmapped.js';
import { disposeDataset, loadSyntheticDataset } from './helpers/attribution-dataset.mjs';

const dir = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(dir, 'fixtures/attribution/synthetic-dataset.json'), 'utf8'),
);

const LINKED_AT = '2026-06-01T10:00:00.000Z';

test('T31: unmapped means no SessionLink regardless of project hint', () => {
  const ctx = loadSyntheticDataset(fixture);
  const unmapped = listUnmappedSessions(ctx.db);
  assert.equal(unmapped.length, 4);
  assert.ok(unmapped.some((s) => s.projectHint === '<PROJECT_SLUG_ALPHA>'));
  disposeDataset(ctx);
});

test('T31: integrity reconciles totals per provider', () => {
  const ctx = loadSyntheticDataset(fixture);
  const report = assertUsageIntegrity(ctx.db);
  const claude = report.providers.find((p) => p.provider === 'claude');
  assert.equal(claude.totalSessions, 3);
  assert.equal(claude.mappedSessions + claude.unmappedSessions, claude.totalSessions);
  assert.equal(claude.totalTokens.input, claude.mappedTokens.input + claude.unmappedTokens.input);
  assert.equal(claude.costUnknownCount, 1);
  disposeDataset(ctx);
});

test('T31: reimport does not break integrity', () => {
  const ctx = loadSyntheticDataset(fixture);
  const before = buildUsageIntegrityReport(ctx.db);
  const rows = fixture.sessions.map((s) => {
    const key = sessionKey(s.provider, 'codeburn', s.rawId);
    return {
      session: {
        sessionKey: key,
        provider: s.provider,
        source: 'codeburn',
        rawId: s.rawId,
      },
      snapshot: {
        sessionKey: key,
        observedAt: s.observedAt,
        tokens: s.tokens,
        cost: s.cost,
      },
      claudeModels: s.claudeModels ?? null,
      claudeTokenAllocation: s.claudeTokenAllocation ?? null,
      claudeProjectHint: s.claudeProjectHint ?? null,
    };
  });
  importCodeBurnUsage(ctx.db, rows);
  const after = assertUsageIntegrity(ctx.db);
  assert.deepEqual(after.providers, before.providers);
  disposeDataset(ctx);
});

test('T31: linking moves session between buckets without changing totals', () => {
  const ctx = loadSyntheticDataset(fixture);
  const before = buildUsageIntegrityReport(ctx.db);
  linkSessionToIssue(ctx.db, {
    provider: 'claude',
    source: 'codeburn',
    rawSessionId: 'aaaaaaaa-claude-4ccc-8ddd-eeeeeeeeee01',
    issueNodeId: 'I_attr_issue_alpha',
    linkedAt: LINKED_AT,
  });
  const after = buildUsageIntegrityReport(ctx.db);
  for (const slice of before.providers) {
    const next = after.providers.find((p) => p.provider === slice.provider);
    assert.deepEqual(next.totalTokens, slice.totalTokens);
    assert.equal(next.costKnownUsd, slice.costKnownUsd);
    assert.equal(next.costUnknownCount, slice.costUnknownCount);
    assert.equal(next.totalSessions, slice.totalSessions);
  }
  const claude = after.providers.find((p) => p.provider === 'claude');
  const claudeBefore = before.providers.find((p) => p.provider === 'claude');
  assert.equal(claude.unmappedSessions, claudeBefore.unmappedSessions - 1);
  assert.equal(claude.mappedSessions, claudeBefore.mappedSessions + 1);
  assert.equal(listUnmappedSessions(ctx.db).length, 3);
  disposeDataset(ctx);
});
