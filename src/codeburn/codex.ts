import { sessionKey, type UsageSession, type UsageSnapshot } from '../contracts.js';
import { schemaDrift } from './adapter.js';
import { mapRowCost } from './cost.js';

export type CodexUsageMetadata = {
  models: string[] | null;
  projectHint: string | null;
};

export type ParsedCodexUsage = {
  session: UsageSession;
  snapshot: UsageSnapshot;
  metadata: CodexUsageMetadata;
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

function parseCodexRow(
  row: Record<string, unknown>,
  pathPrefix: string,
  observedAt: string,
  codeburnVersion: string,
): ParsedCodexUsage {
  const sessionId = row['sessionId'];
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw schemaDrift(`${pathPrefix}.sessionId`, 'missing sessionId');
  }
  const provider = row['provider'];
  if (provider !== 'codex') {
    throw schemaDrift(`${pathPrefix}.provider`, 'expected codex');
  }

  const models = parseModels(row['models'], `${pathPrefix}.models`);
  const projectRaw = row['project'];
  const projectHint =
    typeof projectRaw === 'string' && projectRaw.length > 0 ? projectRaw : null;

  const key = sessionKey('codex', 'codeburn', sessionId);
  const session: UsageSession = {
    sessionKey: key,
    provider: 'codex',
    source: 'codeburn',
    rawId: sessionId,
  };

  const cacheWrite = parseNonNegativeInt(
    row['cacheWriteTokens'],
    `${pathPrefix}.cacheWriteTokens`,
  );

  const snapshot: UsageSnapshot = {
    sessionKey: key,
    observedAt,
    tokens: {
      provider: 'codex',
      input: parseNonNegativeInt(row['inputTokens'], `${pathPrefix}.inputTokens`),
      output: parseNonNegativeInt(row['outputTokens'], `${pathPrefix}.outputTokens`),
      cacheRead: parseNonNegativeInt(
        row['cacheReadTokens'],
        `${pathPrefix}.cacheReadTokens`,
      ),
      cacheWrite,
      reasoning: null,
    },
    cost: mapRowCost(row['cost'], codeburnVersion, `${pathPrefix}.cost`),
  };

  return {
    session,
    snapshot,
    metadata: { models, projectHint },
  };
}

/**
 * Normalize Codex CodeBurn session rows (flat list; no subagents).
 */
export function parseCodexSessions(
  rows: unknown[],
  observedAt: string,
  codeburnVersion: string,
): ParsedCodexUsage[] {
  const out: ParsedCodexUsage[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row || typeof row !== 'object') {
      throw schemaDrift(`[${i}]`, 'expected session object');
    }
    out.push(
      parseCodexRow(row as Record<string, unknown>, `[${i}]`, observedAt, codeburnVersion),
    );
  }
  return out;
}
