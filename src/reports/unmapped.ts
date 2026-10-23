import { listUnmappedSessions } from '../attribution/unmapped.js';
import { parseSessionKey } from '../contracts.js';
import {
  formatUsd,
  renderTable,
  shellSingleQuote,
  sanitizeDisplayText,
  type CollectionFreshnessSlice,
  type OrcaReferenceField,
  type ReportCostField,
  type TableColumn,
} from './render.js';
import { type ReportContext, loadCollectionFreshness } from './tasks.js';

export const LINK_ISSUE_PLACEHOLDER = '<issue-url-or-owner/repo#n>';

export type UnmappedSessionReportRow = {
  provider: string;
  rawSessionId: string;
  models: string[];
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  cost: ReportCostField;
  orcaReference: OrcaReferenceField;
  projectHint: string | null;
  linkSuggestion: string;
};

export type UnmappedReport = {
  kind: 'unmapped';
  projectId: string;
  repository: string;
  freshness: CollectionFreshnessSlice[];
  sessions: UnmappedSessionReportRow[];
};

function modelsForSession(
  db: ReportContext['db'],
  sessionKey: string,
): string[] {
  const row = db
    .prepare(
      `SELECT claude_models_json FROM usage_snapshots WHERE session_key = ?`,
    )
    .get(sessionKey) as { claude_models_json: string | null } | undefined;
  if (!row?.claude_models_json) {
    return [];
  }
  const parsed = JSON.parse(row.claude_models_json) as unknown;
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter((m): m is string => typeof m === 'string');
}

function buildLinkSuggestion(provider: string, rawSessionId: string): string {
  return `orca-telemetry link --issue ${LINK_ISSUE_PLACEHOLDER} --provider ${provider} --session ${shellSingleQuote(rawSessionId)}`;
}

export function buildUnmappedReport(ctx: ReportContext): UnmappedReport {
  const unmapped = listUnmappedSessions(ctx.db);
  const sessions: UnmappedSessionReportRow[] = unmapped.map((entry) => {
    const parsed = parseSessionKey(entry.sessionKey);
    const models = modelsForSession(ctx.db, entry.sessionKey);
    return {
      provider: entry.provider,
      rawSessionId: parsed.rawId,
      models,
      tokens: {
        input: entry.snapshot.tokens.input,
        output: entry.snapshot.tokens.output,
        cacheRead: entry.snapshot.tokens.cacheRead,
        cacheWrite: entry.snapshot.tokens.cacheWrite,
      },
      cost: {
        amountUsd: entry.snapshot.cost.amountUsd,
        kind: entry.snapshot.cost.kind,
      },
      orcaReference: { status: 'unknown' },
      projectHint: entry.projectHint,
      linkSuggestion: buildLinkSuggestion(entry.provider, parsed.rawId),
    };
  });

  return {
    kind: 'unmapped',
    projectId: ctx.profile.project.id,
    repository: ctx.profile.repository.nameWithOwner,
    freshness: loadCollectionFreshness(ctx.db),
    sessions,
  };
}

export function formatUnmappedReportText(report: UnmappedReport): string {
  const lines = [
    `Unmapped sessions — project ${report.projectId}`,
    `Repository: ${report.repository}`,
    'Sessions without a SessionLink (project hints are not mappings).',
  ];
  if (report.freshness.length > 0) {
    lines.push('Collection snapshot (latest per source):');
    for (const f of report.freshness) {
      lines.push(`  ${f.source}: ${f.status} @ ${f.recordedAt}`);
    }
  }
  lines.push('');
  if (report.sessions.length === 0) {
    lines.push('No unmapped sessions.');
    return `${lines.join('\n')}\n`;
  }
  const columns: TableColumn[] = [
    { key: 'provider', header: 'Provider', width: 8 },
    { key: 'session', header: 'Session', width: 36 },
    { key: 'models', header: 'Models', width: 16 },
    { key: 'in', header: 'In', width: 6, align: 'right' },
    { key: 'cost', header: 'Cost', width: 10, align: 'right' },
    { key: 'orca', header: 'Orca', width: 8 },
  ];
  const rows = report.sessions.map((s) => ({
    provider: s.provider,
    session: s.rawSessionId,
    models: s.models.length === 0 ? 'unknown' : s.models.join(', '),
    in: String(s.tokens.input),
    cost:
      s.cost.kind === 'unknown' || s.cost.amountUsd === null
        ? 'unknown'
        : formatUsd(s.cost.amountUsd),
    orca: s.orcaReference.status,
  }));
  lines.push(renderTable(columns, rows).trimEnd());
  lines.push('');
  lines.push('Suggested link commands:');
  for (const s of report.sessions) {
    lines.push(`  ${sanitizeDisplayText(s.linkSuggestion)}`);
  }
  return `${lines.join('\n')}\n`;
}
