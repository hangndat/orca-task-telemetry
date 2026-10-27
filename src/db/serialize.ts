import type { Cost, TokenUsage, UsageSnapshot } from '../contracts.js';
import type { ClaudeTokenAllocation } from '../usage/sessions.js';
import { dbSchemaError } from './errors.js';

export type SnapshotRowExtras = {
  claudeModelsJson: string | null;
  claudeTokenAllocation: ClaudeTokenAllocation | null;
  claudeProjectHint: string | null;
};

export function serializeTokens(tokens: TokenUsage): string {
  return JSON.stringify(tokens);
}

export function parseTokensJson(json: string): TokenUsage {
  const parsed = JSON.parse(json) as TokenUsage;
  if (!parsed || typeof parsed !== 'object' || !('provider' in parsed)) {
    throw dbSchemaError('Invalid tokens_json in usage_snapshots.');
  }
  return parsed;
}

export function serializeCost(cost: Cost): {
  amountUsd: number | null;
  kind: Cost['kind'];
  sourceTool: string | null;
  sourceVersion: string | null;
} {
  return {
    amountUsd: cost.amountUsd,
    kind: cost.kind,
    sourceTool: cost.source?.tool ?? null,
    sourceVersion: cost.source?.version ?? null,
  };
}

export function snapshotBodyFingerprint(
  snapshot: UsageSnapshot,
  extras: SnapshotRowExtras,
): string {
  const cost = serializeCost(snapshot.cost);
  return JSON.stringify({
    tokens: snapshot.tokens,
    cost,
    extras,
  });
}

export function rowExtrasFingerprint(row: {
  tokens_json: string;
  cost_amount_usd: number | null;
  cost_kind: string;
  cost_source_tool: string | null;
  cost_source_version: string | null;
  claude_models_json: string | null;
  claude_token_allocation: string | null;
  claude_project_hint: string | null;
}): string {
  return JSON.stringify({
    tokens: JSON.parse(row.tokens_json),
    cost: {
      amountUsd: row.cost_amount_usd,
      kind: row.cost_kind,
      sourceTool: row.cost_source_tool,
      sourceVersion: row.cost_source_version,
    },
    extras: {
      claudeModelsJson: row.claude_models_json,
      claudeTokenAllocation: row.claude_token_allocation,
      claudeProjectHint: row.claude_project_hint,
    },
  });
}
