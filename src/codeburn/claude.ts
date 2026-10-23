import { sessionKey, type UsageSession, type UsageSnapshot } from '../contracts.js';
import { schemaDrift } from './adapter.js';
import { mapRowCost } from './cost.js';

export type ClaudeTokenAllocation = 'known' | 'unknown';

export type ClaudeUsageMetadata = {
  models: string[] | null;
  projectHint: string | null;
  tokenAllocation: ClaudeTokenAllocation;
};

export type ParsedClaudeUsage = {
  session: UsageSession;
  snapshot: UsageSnapshot;
  metadata: ClaudeUsageMetadata;
};

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

function parseNonNegativeInt(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw schemaDrift(path, 'expected finite number');
  }
  if (!Number.isInteger(value) || value < 0 || value > MAX_SAFE) {
    throw schemaDrift(path, 'expected non-negative safe integer');
  }
  return value;
}

function parseModels(value: unknown, path: string): string[] | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!Array.isArray(value)) {
    throw schemaDrift(path, 'models must be an array');
  }
  const models: string[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const item = value[i];
    if (typeof item !== 'string' || item.length === 0) {
      throw schemaDrift(`${path}[${i}]`, 'expected non-empty string');
    }
    models.push(item);
  }
  return models.length > 0 ? models : null;
}

function tokenAllocationForModels(models: string[] | null): ClaudeTokenAllocation {
  if (models === null || models.length <= 1) {
    return 'known';
  }
  return 'unknown';
}

function parseClaudeRow(
  row: Record<string, unknown>,
  pathPrefix: string,
  observedAt: string,
  codeburnVersion: string,
): ParsedClaudeUsage {
  const sessionId = row['sessionId'];
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw schemaDrift(`${pathPrefix}.sessionId`, 'missing sessionId');
  }
  const provider = row['provider'];
  if (provider !== 'claude') {
    throw schemaDrift(`${pathPrefix}.provider`, 'expected claude');
  }

  const models = parseModels(row['models'], `${pathPrefix}.models`);
  const projectRaw = row['project'];
  const projectHint =
    typeof projectRaw === 'string' && projectRaw.length > 0 ? projectRaw : null;

  const key = sessionKey('claude', 'codeburn', sessionId);
  const session: UsageSession = {
    sessionKey: key,
    provider: 'claude',
    source: 'codeburn',
    rawId: sessionId,
  };

  const tokens = {
    provider: 'claude' as const,
    input: parseNonNegativeInt(row['inputTokens'], `${pathPrefix}.inputTokens`),
    output: parseNonNegativeInt(row['outputTokens'], `${pathPrefix}.outputTokens`),
    cacheRead: parseNonNegativeInt(
      row['cacheReadTokens'],
      `${pathPrefix}.cacheReadTokens`,
    ),
    cacheWrite: parseNonNegativeInt(
      row['cacheWriteTokens'],
      `${pathPrefix}.cacheWriteTokens`,
    ),
  };

  const snapshot: UsageSnapshot = {
    sessionKey: key,
    observedAt,
    tokens,
    cost: mapRowCost(row['cost'], codeburnVersion, `${pathPrefix}.cost`),
  };

  return {
    session,
    snapshot,
    metadata: {
      models,
      projectHint,
      tokenAllocation: tokenAllocationForModels(models),
    },
  };
}

/**
 * Normalize Claude CodeBurn session rows (parent + each subagent as separate sessions).
 */
export function parseClaudeSessions(
  rows: unknown[],
  observedAt: string,
  codeburnVersion: string,
): ParsedClaudeUsage[] {
  const out: ParsedClaudeUsage[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row || typeof row !== 'object') {
      throw schemaDrift(`[${i}]`, 'expected session object');
    }
    const rec = row as Record<string, unknown>;
    out.push(parseClaudeRow(rec, `[${i}]`, observedAt, codeburnVersion));

    const subagents = rec['subagents'];
    if (subagents === null || subagents === undefined) {
      continue;
    }
    if (!Array.isArray(subagents)) {
      throw schemaDrift(`[${i}].subagents`, 'expected array');
    }
    for (let j = 0; j < subagents.length; j += 1) {
      const sub = subagents[j];
      if (!sub || typeof sub !== 'object') {
        throw schemaDrift(`[${i}].subagents[${j}]`, 'expected object');
      }
      out.push(
        parseClaudeRow(
          sub as Record<string, unknown>,
          `[${i}].subagents[${j}]`,
          observedAt,
          codeburnVersion,
        ),
      );
    }
  }
  return out;
}
