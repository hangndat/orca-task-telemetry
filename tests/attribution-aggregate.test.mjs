import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import {
  aggregateLinkedUsageForIssue,
  aggregateLinkedUsageForProject,
} from '../dist/attribution/aggregate.js';
import { linkSessionToIssue } from '../dist/attribution/link.js';
import { disposeDataset, loadSyntheticDataset } from './helpers/attribution-dataset.mjs';

const dir = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(dir, 'fixtures/attribution/synthetic-dataset.json'), 'utf8'),
);

const LINKED_AT = '2026-06-01T10:00:00.000Z';

function linkAllToAlpha(ctx) {
  linkSessionToIssue(ctx.db, {
    provider: 'claude',
    source: 'codeburn',
    rawSessionId: 'aaaaaaaa-claude-4ccc-8ddd-eeeeeeeeee01',
    issueNodeId: 'I_attr_issue_alpha',
    linkedAt: LINKED_AT,
  });
  linkSessionToIssue(ctx.db, {
    provider: 'claude',
    source: 'codeburn',
    rawSessionId: 'aaaaaaaa-claude-4ccc-8ddd-eeeeeeeeee02',
    issueNodeId: 'I_attr_issue_alpha',
    linkedAt: LINKED_AT,
  });
  linkSessionToIssue(ctx.db, {
    provider: 'codex',
    source: 'codeburn',
    rawSessionId: fixture.sharedRawSessionId,
    issueNodeId: 'I_attr_issue_alpha',
    linkedAt: LINKED_AT,
  });
}

test('T30: aggregates latest linked snapshots per provider on issue', () => {
  const ctx = loadSyntheticDataset(fixture);
  linkAllToAlpha(ctx);
  const rollup = aggregateLinkedUsageForIssue(ctx.db, 'I_attr_issue_alpha');
  assert.equal(rollup.sessionKeys.length, 3);
  const claude = rollup.byProvider.find((p) => p.provider === 'claude');
  const codex = rollup.byProvider.find((p) => p.provider === 'codex');
  assert.equal(claude.input, 120);
  assert.equal(claude.output, 60);
  assert.equal(claude.mixedModelAllocation, 'unknown');
  assert.ok(claude.models.includes('Sonnet 5'));
  assert.equal(codex.input, 200);
  assert.equal(codex.reasoningNullCount, 1);
  assert.equal(rollup.cost.knownAmountUsd, 1.75);
  assert.equal(rollup.cost.unknownAmountCount, 1);
  disposeDataset(ctx);
});

test('T30: project scope dedupes session when issue appears twice in memberships', () => {
  const ctx = loadSyntheticDataset(fixture);
  linkSessionToIssue(ctx.db, {
    provider: 'claude',
    source: 'codeburn',
    rawSessionId: 'aaaaaaaa-claude-4ccc-8ddd-eeeeeeeeee01',
    issueNodeId: 'I_attr_issue_alpha',
    linkedAt: LINKED_AT,
  });
  const project = aggregateLinkedUsageForProject(
    ctx.db,
    fixture.projectId,
  );
  assert.equal(project.sessionKeys.length, 1);
  const alpha = project.issues.find((i) => i.issueNodeId === 'I_attr_issue_alpha');
  assert.equal(alpha.sessionKeys.length, 1);
  disposeDataset(ctx);
});

test('T30: shared raw id across providers only counts linked sessions in rollup', () => {
  const ctx = loadSyntheticDataset(fixture);
  linkSessionToIssue(ctx.db, {
    provider: 'claude',
    source: 'codeburn',
    rawSessionId: fixture.sharedRawSessionId,
    issueNodeId: 'I_attr_issue_beta',
    linkedAt: LINKED_AT,
  });
  const rollup = aggregateLinkedUsageForIssue(ctx.db, 'I_attr_issue_beta');
  assert.equal(rollup.sessionKeys.length, 1);
  assert.equal(rollup.byProvider[0].input, 5);
  disposeDataset(ctx);
});
