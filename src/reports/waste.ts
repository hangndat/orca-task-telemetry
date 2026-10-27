import type { ReportContext } from './tasks.js';
import { formatUsd, sanitizeDisplayText } from './render.js';
import { parseTokensJson } from '../db/serialize.js';

/** Cache-miss when cacheRead share of (input+cacheRead) is below this ratio. */
export const CACHE_MISS_RATIO = 0.1;
/** Oversized when input+cacheRead exceeds this many tokens. */
export const OVERSIZE_CONTEXT_TOKENS = 200_000;

export type WasteFinding = {
  sessionKey: string;
  provider: string;
  issueNodeId: string | null;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  cacheReadRatio: number | null;
  flags: Array<'cache_miss' | 'oversize_context'>;
  costAmountUsd: number | null;
  costKind: string;
};

export type WasteReport = {
  kind: 'waste';
  projectId: string;
  repository: string;
  thresholds: { cacheMissRatio: number; oversizeContextTokens: number };
  findings: WasteFinding[];
  totals: {
    findingCount: number;
    cacheMissCount: number;
    oversizeCount: number;
    knownCostUsd: number;
  };
};

export function buildWasteReport(ctx: ReportContext): WasteReport {
  const rows = ctx.db
    .prepare(
      `SELECT u.session_key AS session_key, u.provider AS provider,
              s.tokens_json AS tokens_json, s.cost_amount_usd AS amount,
              s.cost_kind AS kind,
              (SELECT l.issue_node_id FROM session_links l
                WHERE l.session_key = u.session_key
                ORDER BY l.linked_at LIMIT 1) AS issue_node_id
       FROM usage_sessions u
       JOIN usage_snapshots s ON s.session_key = u.session_key
       WHERE EXISTS (SELECT 1 FROM session_links l WHERE l.session_key = u.session_key)`,
    )
    .all() as {
    session_key: string;
    provider: string;
    tokens_json: string;
    amount: number | null;
    kind: string;
    issue_node_id: string | null;
  }[];

  const findings: WasteFinding[] = [];
  let knownCostUsd = 0;
  let cacheMissCount = 0;
  let oversizeCount = 0;

  for (const row of rows) {
    const tokens = parseTokensJson(row.tokens_json);
    const input = tokens.input;
    const cacheRead = tokens.cacheRead;
    const denom = input + cacheRead;
    const cacheReadRatio = denom > 0 ? cacheRead / denom : null;
    const flags: WasteFinding['flags'] = [];
    if (cacheReadRatio !== null && cacheReadRatio < CACHE_MISS_RATIO) {
      flags.push('cache_miss');
      cacheMissCount += 1;
    }
    if (denom >= OVERSIZE_CONTEXT_TOKENS) {
      flags.push('oversize_context');
      oversizeCount += 1;
    }
    if (flags.length === 0) continue;
    if (row.kind === 'estimated_api_equivalent' && typeof row.amount === 'number') {
      knownCostUsd += row.amount;
    }
    findings.push({
      sessionKey: row.session_key,
      provider: row.provider,
      issueNodeId: row.issue_node_id,
      input,
      cacheRead,
      cacheWrite: tokens.cacheWrite,
      cacheReadRatio,
      flags,
      costAmountUsd: row.amount,
      costKind: row.kind,
    });
  }

  return {
    kind: 'waste',
    projectId: ctx.profile.project.id,
    repository: ctx.profile.repository.nameWithOwner,
    thresholds: {
      cacheMissRatio: CACHE_MISS_RATIO,
      oversizeContextTokens: OVERSIZE_CONTEXT_TOKENS,
    },
    findings,
    totals: {
      findingCount: findings.length,
      cacheMissCount,
      oversizeCount,
      knownCostUsd,
    },
  };
}

export function formatWasteReportText(report: WasteReport): string {
  const lines = [
    `Token waste heuristics for ${sanitizeDisplayText(report.repository)}`,
    `thresholds: cacheMissRatio<${report.thresholds.cacheMissRatio} oversize>=${report.thresholds.oversizeContextTokens}`,
    `findings=${report.totals.findingCount} cacheMiss=${report.totals.cacheMissCount} oversize=${report.totals.oversizeCount} knownCost=${formatUsd(report.totals.knownCostUsd)}`,
    '',
  ];
  for (const f of report.findings) {
    lines.push(
      `${sanitizeDisplayText(f.sessionKey)} flags=${f.flags.join(',')} ` +
        `in=${f.input} cacheR=${f.cacheRead} ratio=${f.cacheReadRatio ?? 'n/a'} ` +
        `cost=${f.costAmountUsd == null ? 'unknown' : formatUsd(f.costAmountUsd)}`,
    );
  }
  if (report.findings.length === 0) {
    lines.push('No cache-miss or oversize-context findings among linked sessions.');
  }
  return `${lines.join('\n')}\n`;
}
