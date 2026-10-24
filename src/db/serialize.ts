import type { Cost, TokenUsage, UsageSnapshot } from '../contracts.js';
import type { ClaudeTokenAllocation } from '../codeburn/claude.js';
import { dbSchemaError } from './errors.js';

export type SnapshotRowExtras = {
  claudeModelsJson: string | null;
  claudeTokenAllocation: ClaudeTokenAllocation | null;
  claudeProjectHint: string | null;
};

export function serializeTokens(tokens: TokenUsage): string {
  return JSON.stringify(tokens);
}

const TOKEN_NUMERIC_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;

function isSafeIntegerNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function parseTokensJson(json: string): TokenUsage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw dbSchemaError('Invalid tokens_json in usage_snapshots.');
  }
  if (!parsed || typeof parsed !== 'object' || !('provider' in parsed)) {
    throw dbSchemaError('Invalid tokens_json in usage_snapshots.');
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.provider !== 'claude' && obj.provider !== 'codex') {
    throw dbSchemaError('Invalid tokens_json.provider in usage_snapshots.');
  }
  for (const field of TOKEN_NUMERIC_FIELDS) {
    if (!isSafeIntegerNonNegative(obj[field])) {
      throw dbSchemaError(`Invalid tokens_json.${field} in usage_snapshots.`);
    }
  }
  if (
    obj.provider === 'codex' &&
    obj.reasoning !== null &&
    !isSafeIntegerNonNegative(obj.reasoning)
  ) {
    throw dbSchemaError('Invalid tokens_json.reasoning in usage_snapshots.');
  }
  return parsed as TokenUsage;
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
