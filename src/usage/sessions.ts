import { sessionKey, type UsageSession, type UsageSnapshot } from '../contracts.js';
import { schemaDrift } from './adapter.js';
import { mapAgentTopCost } from './cost.js';

export type TokenAllocation = 'known' | 'unknown';

export type UsageMetadata = {
  models: string[] | null;
  projectHint: string | null;
  tokenAllocation: TokenAllocation;
  parentSessionId: string | null;
};

export type ParsedUsage = {
  session: UsageSession;
  snapshot: UsageSnapshot;
  metadata: UsageMetadata;
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

function parseOptionalString(value: unknown, path: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'string') {
    throw schemaDrift(path, 'expected string or null');
  }
  return value.length > 0 ? value : null;
}

function cacheWriteTotal(row: Record<string, unknown>, pathPrefix: string): number {
  const five = parseNonNegativeInt(row['cache_write_5m'], `${pathPrefix}.cache_write_5m`);
  const hour = parseNonNegativeInt(row['cache_write_1h'], `${pathPrefix}.cache_write_1h`);
  const unsplit = parseNonNegativeInt(
    row['cache_write_unsplit'],
    `${pathPrefix}.cache_write_unsplit`,
  );
  const total = five + hour + unsplit;
  if (total > MAX_SAFE) {
    throw schemaDrift(`${pathPrefix}.cacheWrite`, 'sum exceeds safe integer');
  }
  return total;
}

function parseRow(
  row: Record<string, unknown>,
  pathPrefix: string,
  observedAt: string,
  agentTopVersion: string,
): ParsedUsage {
  const harness = row['harness'];
  if (harness !== 'claude' && harness !== 'codex' && harness !== 'cursor') {
    throw schemaDrift(`${pathPrefix}.harness`, 'expected claude, codex, or cursor');
  }
  const sessionId = row['session_id'];
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw schemaDrift(`${pathPrefix}.session_id`, 'missing session_id');
  }

  const model = parseOptionalString(row['model'], `${pathPrefix}.model`);
  const models = model === null ? null : [model];
  const projectHint = parseOptionalString(row['project'], `${pathPrefix}.project`);
  const parentSessionId = parseOptionalString(
    row['parent_session_id'],
    `${pathPrefix}.parent_session_id`,
  );

  const key = sessionKey(harness, 'agent-top', sessionId);
  const session: UsageSession = {
    sessionKey: key,
    provider: harness,
    source: 'agent-top',
    rawId: sessionId,
  };

  const input = parseNonNegativeInt(row['input'], `${pathPrefix}.input`);
  const output = parseNonNegativeInt(row['output'], `${pathPrefix}.output`);
  const cacheRead = parseNonNegativeInt(row['cache_read'], `${pathPrefix}.cache_read`);
  const cacheWrite = cacheWriteTotal(row, pathPrefix);
  const tokenSum = input + output + cacheRead + cacheWrite;
  /** Cursor process-table rows often show honest zeros — not measured free usage. */
  const cursorZeroTokens = harness === 'cursor' && tokenSum === 0;

  const tokens =
    harness === 'claude'
      ? {
          provider: 'claude' as const,
          input,
          output,
          cacheRead,
          cacheWrite,
        }
      : harness === 'codex'
        ? {
            provider: 'codex' as const,
            input,
            output,
            cacheRead,
            cacheWrite,
            reasoning: null,
          }
        : {
            provider: 'cursor' as const,
            input,
            output,
            cacheRead,
            cacheWrite,
          };

  const cost = cursorZeroTokens
    ? {
        amountUsd: null,
        kind: 'unknown' as const,
        source: { tool: 'agent-top' as const, version: agentTopVersion },
      }
    : mapAgentTopCost(
        row['cost_usd'],
        row['unpriced_tokens'],
        agentTopVersion,
        `${pathPrefix}.cost_usd`,
      );

  const snapshot: UsageSnapshot = {
    sessionKey: key,
    observedAt,
    tokens,
    cost,
  };

  const modelKnown = models !== null && models.length === 1;
  return {
    session,
    snapshot,
    metadata: {
      models,
      projectHint,
      tokenAllocation: cursorZeroTokens || !modelKnown ? 'unknown' : 'known',
      parentSessionId,
    },
  };
}

/**
 * Normalize agent-top counted_sessions rows. Each row is its own session;
 * parent_session_id is not merged into the parent snapshot.
 */
export function parseCountedSessions(
  rows: unknown[],
  observedAt: string,
  agentTopVersion: string,
): ParsedUsage[] {
  const out: ParsedUsage[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row || typeof row !== 'object') {
      throw schemaDrift(`[${i}]`, 'expected session object');
    }
    out.push(parseRow(row as Record<string, unknown>, `[${i}]`, observedAt, agentTopVersion));
  }
  return out;
}

/** @deprecated Use parseCountedSessions — kept for call-site grouping in tests. */
export function parseClaudeSessions(
  rows: unknown[],
  observedAt: string,
  agentTopVersion: string,
): ParsedUsage[] {
  return parseCountedSessions(rows, observedAt, agentTopVersion).filter(
    (row) => row.session.provider === 'claude',
  );
}

export function parseCodexSessions(
  rows: unknown[],
  observedAt: string,
  agentTopVersion: string,
): ParsedUsage[] {
  return parseCountedSessions(rows, observedAt, agentTopVersion).filter(
    (row) => row.session.provider === 'codex',
  );
}

export function parseCursorSessions(
  rows: unknown[],
  observedAt: string,
  agentTopVersion: string,
): ParsedUsage[] {
  return parseCountedSessions(rows, observedAt, agentTopVersion).filter(
    (row) => row.session.provider === 'cursor',
  );
}

export type ClaudeTokenAllocation = TokenAllocation;
