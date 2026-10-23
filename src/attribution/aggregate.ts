import type { DatabaseSync } from 'node:sqlite';
import type { CostKind, UsageProvider } from '../contracts.js';
import type { ClaudeTokenAllocation } from '../codeburn/claude.js';
import { parseTokensJson } from '../db/serialize.js';

export type ProviderUsageRollup = {
  provider: UsageProvider;
  sessionCount: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoningNullCount: number;
  models: string[];
  mixedModelAllocation: 'known' | 'unknown';
};

export type CostRollup = {
  knownAmountUsd: number;
  knownEstimatedCount: number;
  unknownAmountCount: number;
};

export type IssueUsageRollup = {
  issueNodeId: string;
  sessionKeys: string[];
  byProvider: ProviderUsageRollup[];
  cost: CostRollup;
};

export type ProjectUsageRollup = {
  projectId: string;
  sessionKeys: string[];
  issues: IssueUsageRollup[];
  cost: CostRollup;
};

type SnapshotRow = {
  session_key: string;
  issue_node_id: string;
  provider: UsageProvider;
  tokens_json: string;
  cost_amount_usd: number | null;
  cost_kind: CostKind;
  claude_models_json: string | null;
  claude_token_allocation: ClaudeTokenAllocation | null;
};

function parseModels(json: string | null): string[] {
  if (!json) {
    return [];
  }
  const parsed = JSON.parse(json) as unknown;
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter((m): m is string => typeof m === 'string');
}

function emptyProviderRollup(provider: UsageProvider): ProviderUsageRollup {
  return {
    provider,
    sessionCount: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoningNullCount: 0,
    models: [],
    mixedModelAllocation: 'known',
  };
}

function addTokens(
  rollup: ProviderUsageRollup,
  tokens: ReturnType<typeof parseTokensJson>,
  models: string[],
  allocation: ClaudeTokenAllocation | null,
): void {
  rollup.sessionCount += 1;
  rollup.input += tokens.input;
  rollup.output += tokens.output;
  rollup.cacheRead += tokens.cacheRead;
  rollup.cacheWrite += tokens.cacheWrite;
  if (tokens.provider === 'codex' && tokens.reasoning === null) {
    rollup.reasoningNullCount += 1;
  }
  for (const model of models) {
    if (!rollup.models.includes(model)) {
      rollup.models.push(model);
    }
  }
  if (allocation === 'unknown') {
    rollup.mixedModelAllocation = 'unknown';
  }
}

function addCost(rollup: CostRollup, amount: number | null, kind: CostKind): void {
  if (amount !== null && Number.isFinite(amount)) {
    rollup.knownAmountUsd += amount;
    if (kind === 'estimated_api_equivalent') {
      rollup.knownEstimatedCount += 1;
    }
    return;
  }
  rollup.unknownAmountCount += 1;
}

function mergeCost(target: CostRollup, part: CostRollup): void {
  target.knownAmountUsd += part.knownAmountUsd;
  target.knownEstimatedCount += part.knownEstimatedCount;
  target.unknownAmountCount += part.unknownAmountCount;
}

function loadLinkedSnapshotsForIssue(
  db: DatabaseSync,
  issueNodeId: string,
): SnapshotRow[] {
  return db
    .prepare(
      `SELECT sl.session_key, sl.issue_node_id, us.provider,
              snap.tokens_json, snap.cost_amount_usd, snap.cost_kind,
              snap.claude_models_json, snap.claude_token_allocation
       FROM session_links sl
       INNER JOIN usage_sessions us ON us.session_key = sl.session_key
       INNER JOIN usage_snapshots snap ON snap.session_key = sl.session_key
       WHERE sl.issue_node_id = ?`,
    )
    .all(issueNodeId) as SnapshotRow[];
}

function rollupIssueFromRows(rows: SnapshotRow[]): IssueUsageRollup {
  const byProvider = new Map<UsageProvider, ProviderUsageRollup>();
  const sessionKeys: string[] = [];
  const cost: CostRollup = {
    knownAmountUsd: 0,
    knownEstimatedCount: 0,
    unknownAmountCount: 0,
  };

  for (const row of rows) {
    if (!sessionKeys.includes(row.session_key)) {
      sessionKeys.push(row.session_key);
    }
    let rollup = byProvider.get(row.provider);
    if (!rollup) {
      rollup = emptyProviderRollup(row.provider);
      byProvider.set(row.provider, rollup);
    }
    const tokens = parseTokensJson(row.tokens_json);
    addTokens(
      rollup,
      tokens,
      parseModels(row.claude_models_json),
      row.claude_token_allocation,
    );
    addCost(cost, row.cost_amount_usd, row.cost_kind);
  }

  const issueNodeId = rows[0]?.issue_node_id ?? '';
  return {
    issueNodeId,
    sessionKeys,
    byProvider: [...byProvider.values()].sort((a, b) =>
      a.provider.localeCompare(b.provider),
    ),
    cost,
  };
}

/** Latest linked snapshots for one Issue (no double-counting cumulative re-imports). */
export function aggregateLinkedUsageForIssue(
  db: DatabaseSync,
  issueNodeId: string,
): IssueUsageRollup {
  const rows = loadLinkedSnapshotsForIssue(db, issueNodeId);
  if (rows.length === 0) {
    return {
      issueNodeId,
      sessionKeys: [],
      byProvider: [],
      cost: { knownAmountUsd: 0, knownEstimatedCount: 0, unknownAmountCount: 0 },
    };
  }
  return rollupIssueFromRows(rows);
}

/**
 * Project-scoped rollup: membership filter, dedupe session keys across duplicate items.
 */
export function aggregateLinkedUsageForProject(
  db: DatabaseSync,
  projectId: string,
): ProjectUsageRollup {
  const rows = db
    .prepare(
      `SELECT DISTINCT sl.session_key, sl.issue_node_id, us.provider,
              snap.tokens_json, snap.cost_amount_usd, snap.cost_kind,
              snap.claude_models_json, snap.claude_token_allocation
       FROM project_memberships pm
       INNER JOIN session_links sl ON sl.issue_node_id = pm.issue_node_id
       INNER JOIN usage_sessions us ON us.session_key = sl.session_key
       INNER JOIN usage_snapshots snap ON snap.session_key = sl.session_key
       WHERE pm.project_id = ?`,
    )
    .all(projectId) as SnapshotRow[];

  const byIssue = new Map<string, SnapshotRow[]>();
  const projectSessionKeys = new Set<string>();
  for (const row of rows) {
    projectSessionKeys.add(row.session_key);
    const list = byIssue.get(row.issue_node_id) ?? [];
    if (!list.some((r) => r.session_key === row.session_key)) {
      list.push(row);
    }
    byIssue.set(row.issue_node_id, list);
  }

  const issues: IssueUsageRollup[] = [];
  const projectCost: CostRollup = {
    knownAmountUsd: 0,
    knownEstimatedCount: 0,
    unknownAmountCount: 0,
  };

  for (const issueRows of byIssue.values()) {
    const issueRollup = rollupIssueFromRows(issueRows);
    issues.push(issueRollup);
    mergeCost(projectCost, issueRollup.cost);
  }

  issues.sort((a, b) => a.issueNodeId.localeCompare(b.issueNodeId));

  return {
    projectId,
    sessionKeys: [...projectSessionKeys].sort(),
    issues,
    cost: projectCost,
  };
}
