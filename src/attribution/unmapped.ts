import type { DatabaseSync } from 'node:sqlite';
import type { UsageProvider, UsageSnapshot } from '../contracts.js';
import { parseTokensJson } from '../db/serialize.js';
import { attributionIntegrityError } from './errors.js';

export type UnmappedSession = {
  sessionKey: string;
  provider: UsageProvider;
  snapshot: UsageSnapshot;
  /** agent-top project slug hint only — not GitHub Project membership. */
  projectHint: string | null;
};

export type TokenBucketTotals = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoningNullCount: number;
};

export type ProviderIntegritySlice = {
  provider: UsageProvider;
  totalSessions: number;
  mappedSessions: number;
  unmappedSessions: number;
  totalTokens: TokenBucketTotals;
  mappedTokens: TokenBucketTotals;
  unmappedTokens: TokenBucketTotals;
  costKnownUsd: number;
  costUnknownCount: number;
};

export type UsageIntegrityReport = {
  providers: ProviderIntegritySlice[];
};

type Row = {
  session_key: string;
  provider: UsageProvider;
  observed_at: string;
  tokens_json: string;
  cost_amount_usd: number | null;
  cost_kind: string;
  claude_project_hint: string | null;
  linked: number;
};

function emptyBuckets(): TokenBucketTotals {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoningNullCount: 0,
  };
}

function addBucket(
  target: TokenBucketTotals,
  tokens: ReturnType<typeof parseTokensJson>,
): void {
  target.input += tokens.input;
  target.output += tokens.output;
  target.cacheRead += tokens.cacheRead;
  target.cacheWrite += tokens.cacheWrite;
  if (tokens.provider === 'codex' && tokens.reasoning === null) {
    target.reasoningNullCount += 1;
  }
}

function bucketsEqual(a: TokenBucketTotals, b: TokenBucketTotals): boolean {
  return (
    a.input === b.input &&
    a.output === b.output &&
    a.cacheRead === b.cacheRead &&
    a.cacheWrite === b.cacheWrite &&
    a.reasoningNullCount === b.reasoningNullCount
  );
}

function sumBuckets(a: TokenBucketTotals, b: TokenBucketTotals): TokenBucketTotals {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    reasoningNullCount: a.reasoningNullCount + b.reasoningNullCount,
  };
}

function loadAllSnapshotRows(db: DatabaseSync): Row[] {
  return db
    .prepare(
      `SELECT us.session_key, us.provider, snap.observed_at, snap.tokens_json,
              snap.cost_amount_usd, snap.cost_kind, snap.claude_project_hint,
              CASE WHEN sl.session_key IS NULL THEN 0 ELSE 1 END AS linked
       FROM usage_sessions us
       INNER JOIN usage_snapshots snap ON snap.session_key = us.session_key
       LEFT JOIN session_links sl ON sl.session_key = us.session_key`,
    )
    .all() as Row[];
}

/** Sessions with snapshots and no SessionLink (Orca hints do not exclude). */
export function listUnmappedSessions(db: DatabaseSync): UnmappedSession[] {
  const rows = loadAllSnapshotRows(db).filter((r) => r.linked === 0);
  const out: UnmappedSession[] = rows.map((row) => ({
    sessionKey: row.session_key,
    provider: row.provider,
    snapshot: {
      sessionKey: row.session_key,
      observedAt: row.observed_at,
      tokens: parseTokensJson(row.tokens_json),
      cost: {
        amountUsd: row.cost_amount_usd,
        kind: row.cost_kind === 'unknown' ? 'unknown' : 'estimated_api_equivalent',
        source: null,
      },
    },
    projectHint: row.claude_project_hint,
  }));
  out.sort((a, b) => a.sessionKey.localeCompare(b.sessionKey));
  return out;
}

export function buildUsageIntegrityReport(db: DatabaseSync): UsageIntegrityReport {
  const rows = loadAllSnapshotRows(db);
  const byProvider = new Map<UsageProvider, ProviderIntegritySlice>();

  for (const row of rows) {
    let slice = byProvider.get(row.provider);
    if (!slice) {
      slice = {
        provider: row.provider,
        totalSessions: 0,
        mappedSessions: 0,
        unmappedSessions: 0,
        totalTokens: emptyBuckets(),
        mappedTokens: emptyBuckets(),
        unmappedTokens: emptyBuckets(),
        costKnownUsd: 0,
        costUnknownCount: 0,
      };
      byProvider.set(row.provider, slice);
    }
    slice.totalSessions += 1;
    const tokens = parseTokensJson(row.tokens_json);
    addBucket(slice.totalTokens, tokens);
    if (row.cost_amount_usd !== null && Number.isFinite(row.cost_amount_usd)) {
      slice.costKnownUsd += row.cost_amount_usd;
    } else {
      slice.costUnknownCount += 1;
    }
    if (row.linked === 1) {
      slice.mappedSessions += 1;
      addBucket(slice.mappedTokens, tokens);
    } else {
      slice.unmappedSessions += 1;
      addBucket(slice.unmappedTokens, tokens);
    }
  }

  const providers = [...byProvider.values()].sort((a, b) =>
    a.provider.localeCompare(b.provider),
  );
  return { providers };
}

export function assertUsageIntegrity(db: DatabaseSync): UsageIntegrityReport {
  const report = buildUsageIntegrityReport(db);
  for (const slice of report.providers) {
    if (slice.mappedSessions + slice.unmappedSessions !== slice.totalSessions) {
      throw attributionIntegrityError(
        `Provider ${slice.provider}: mapped + unmapped sessions != total.`,
      );
    }
    const merged = sumBuckets(slice.mappedTokens, slice.unmappedTokens);
    if (!bucketsEqual(merged, slice.totalTokens)) {
      throw attributionIntegrityError(
        `Provider ${slice.provider}: token bucket totals do not reconcile.`,
      );
    }
  }
  return report;
}
