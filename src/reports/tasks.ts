import fs from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { DatabaseSync as SqliteDatabase } from 'node:sqlite';
import {
  aggregateLinkedUsageForIssue,
  type IssueUsageRollup,
  type ProviderUsageRollup,
} from '../attribution/aggregate.js';
import { loadConfig } from '../config.js';
import type { GitHubIssue, UsageProvider } from '../contracts.js';
import { parseSessionKey } from '../contracts.js';
import { assertSchemaCurrent } from '../db/migrate.js';
import { parseTokensJson } from '../db/serialize.js';
import { parseIssueRef } from '../github/identity.js';
import { CliError, EXIT_ENVIRONMENT } from '../errors.js';
import { createDefaultPathEnv, resolveAppPaths } from '../paths.js';
import type { RepositoryProfile } from '../profiles.js';
import { getProfile } from '../profiles.js';
import { resolveRepository } from '../repo.js';
import {
  type CollectionFreshnessSlice,
  type OrcaReferenceField,
  type ReportCostField,
  renderTable,
  sanitizeDisplayText,
  formatUsd,
  type TableColumn,
} from './render.js';

export type ReportContext = {
  profile: RepositoryProfile;
  db: DatabaseSync;
  close(): void;
};

function reportSetupError(message: string, hint?: string): CliError {
  return new CliError({
    code: 'report_setup',
    message,
    hint,
    exitCode: EXIT_ENVIRONMENT,
  });
}

export function openReportDatabase(dbPath: string): DatabaseSync {
  if (!fs.existsSync(dbPath)) {
    throw reportSetupError(
      'Telemetry database not found.',
      'Run orca-telemetry init and orca-telemetry collect first.',
    );
  }
  const db = new SqliteDatabase(dbPath, { readOnly: true });
  db.exec('PRAGMA foreign_keys = ON');
  assertSchemaCurrent(db);
  return db;
}

export async function openReportContext(cwd: string): Promise<ReportContext> {
  const pathEnv = createDefaultPathEnv();
  const paths = resolveAppPaths(pathEnv);
  const config = loadConfig(paths.appHome);
  const resolved = await resolveRepository(cwd);
  let profile: RepositoryProfile;
  try {
    profile = getProfile(config, resolved.github.id);
  } catch (err) {
    if (err instanceof CliError && err.code === 'profile_not_found') {
      throw reportSetupError(
        'No telemetry profile for this repository.',
        'Run orca-telemetry init to select a GitHub Project.',
      );
    }
    throw err;
  }
  const db = openReportDatabase(paths.dbPath);
  return {
    profile,
    db,
    close() {
      db.close();
    },
  };
}

type IssueRow = {
  issue_node_id: string;
  repository_name_with_owner: string;
  number: number;
  url: string;
  title: string;
  state: string;
};

function mapIssueRow(row: IssueRow): GitHubIssue {
  return {
    issueNodeId: row.issue_node_id,
    repository: { nameWithOwner: row.repository_name_with_owner },
    number: row.number,
    url: row.url,
    title: row.title,
    state: row.state,
  };
}

export function listProjectIssues(
  db: DatabaseSync,
  projectId: string,
): GitHubIssue[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT i.issue_node_id, i.repository_name_with_owner, i.number,
              i.url, i.title, i.state
       FROM project_memberships pm
       INNER JOIN issues i ON i.issue_node_id = pm.issue_node_id
       WHERE pm.project_id = ?
       ORDER BY i.repository_name_with_owner, i.number`,
    )
    .all(projectId) as IssueRow[];
  return rows.map(mapIssueRow);
}

export function findIssueInDatabase(
  db: DatabaseSync,
  issueArg: string,
  profileRepository: string,
): GitHubIssue | null {
  const byNode = db
    .prepare(
      `SELECT issue_node_id, repository_name_with_owner, number, url, title, state
       FROM issues WHERE issue_node_id = ?`,
    )
    .get(issueArg) as IssueRow | undefined;
  if (byNode) {
    return mapIssueRow(byNode);
  }

  let ref;
  try {
    if (/^\d+$/.test(issueArg.trim())) {
      const [owner, repo] = profileRepository.split('/');
      if (!owner || !repo) {
        return null;
      }
      ref = { owner, repo, number: Number.parseInt(issueArg, 10) };
    } else {
      ref = parseIssueRef(issueArg);
    }
  } catch {
    return null;
  }

  const row = db
    .prepare(
      `SELECT issue_node_id, repository_name_with_owner, number, url, title, state
       FROM issues
       WHERE repository_name_with_owner = ? AND number = ?`,
    )
    .get(`${ref.owner}/${ref.repo}`, ref.number) as IssueRow | undefined;
  return row ? mapIssueRow(row) : null;
}

export function loadCollectionFreshness(
  db: DatabaseSync,
): CollectionFreshnessSlice[] {
  const rows = db
    .prepare(
      `SELECT source, status, recorded_at
       FROM collection_logs
       ORDER BY recorded_at DESC`,
    )
    .all() as {
    source: CollectionFreshnessSlice['source'];
    status: 'success' | 'failed';
    recorded_at: string;
  }[];

  const seen = new Set<string>();
  const out: CollectionFreshnessSlice[] = [];
  for (const row of rows) {
    if (seen.has(row.source)) {
      continue;
    }
    seen.add(row.source);
    out.push({
      source: row.source,
      status: row.status,
      recordedAt: row.recorded_at,
    });
  }
  out.sort((a, b) => a.source.localeCompare(b.source));
  return out;
}

export type TaskSessionRow = {
  sessionKey: string;
  provider: UsageProvider;
  rawSessionId: string;
  models: string[];
  modelAllocation: 'known' | 'unknown';
  mappingStatus: 'mapped';
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    reasoning: number | null;
  };
  cost: ReportCostField;
  orcaReference: OrcaReferenceField;
  observedAt: string;
};

export type TaskIssueSummary = {
  issue: GitHubIssue;
  mappingStatus: 'mapped' | 'no_linked_sessions';
  usageStatus: 'has_usage' | 'no_usage_data';
  sessionCount: number;
  byProvider: ProviderUsageRollup[];
  cost: IssueUsageRollup['cost'];
  sessions: TaskSessionRow[];
};

export type TasksReport = {
  kind: 'tasks';
  projectId: string;
  repository: string;
  freshness: CollectionFreshnessSlice[];
  issues: TaskIssueSummary[];
};

export type TaskReport = {
  kind: 'task';
  projectId: string;
  repository: string;
  freshness: CollectionFreshnessSlice[];
  issue: TaskIssueSummary;
};

type SnapshotJoinRow = {
  session_key: string;
  provider: UsageProvider;
  observed_at: string;
  tokens_json: string;
  cost_amount_usd: number | null;
  cost_kind: string;
  claude_models_json: string | null;
  claude_token_allocation: string | null;
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

function orcaRefForSession(): OrcaReferenceField {
  return { status: 'unknown' };
}

function loadLinkedSessionRows(
  db: DatabaseSync,
  issueNodeId: string,
): SnapshotJoinRow[] {
  return db
    .prepare(
      `SELECT us.session_key, us.provider, snap.observed_at, snap.tokens_json,
              snap.cost_amount_usd, snap.cost_kind,
              snap.claude_models_json, snap.claude_token_allocation
       FROM session_links sl
       INNER JOIN usage_sessions us ON us.session_key = sl.session_key
       INNER JOIN usage_snapshots snap ON snap.session_key = sl.session_key
       WHERE sl.issue_node_id = ?
       ORDER BY us.session_key`,
    )
    .all(issueNodeId) as SnapshotJoinRow[];
}

function buildSessionRows(db: DatabaseSync, issueNodeId: string): TaskSessionRow[] {
  const rows = loadLinkedSessionRows(db, issueNodeId);
  const sessions: TaskSessionRow[] = [];
  for (const row of rows) {
    const tokens = parseTokensJson(row.tokens_json);
    const parsed = parseSessionKey(row.session_key);
    const allocation =
      row.claude_token_allocation === 'unknown' ? 'unknown' : 'known';
    sessions.push({
      sessionKey: row.session_key,
      provider: row.provider,
      rawSessionId: parsed.rawId,
      models: parseModels(row.claude_models_json),
      modelAllocation: allocation,
      mappingStatus: 'mapped',
      tokens: {
        input: tokens.input,
        output: tokens.output,
        cacheRead: tokens.cacheRead,
        cacheWrite: tokens.cacheWrite,
        reasoning:
          tokens.provider === 'codex' ? tokens.reasoning : null,
      },
      cost: {
        amountUsd: row.cost_amount_usd,
        kind:
          row.cost_kind === 'unknown'
            ? 'unknown'
            : 'estimated_api_equivalent',
      },
      orcaReference: orcaRefForSession(),
      observedAt: row.observed_at,
    });
  }
  return sessions;
}

function summarizeIssue(
  db: DatabaseSync,
  issue: GitHubIssue,
): TaskIssueSummary {
  const rollup = aggregateLinkedUsageForIssue(db, issue.issueNodeId);
  const sessions = buildSessionRows(db, issue.issueNodeId);
  const hasUsage = sessions.length > 0;
  return {
    issue,
    mappingStatus: hasUsage ? 'mapped' : 'no_linked_sessions',
    usageStatus: hasUsage ? 'has_usage' : 'no_usage_data',
    sessionCount: rollup.sessionKeys.length,
    byProvider: rollup.byProvider,
    cost: rollup.cost,
    sessions,
  };
}

export function buildTasksReport(ctx: ReportContext): TasksReport {
  const projectId = ctx.profile.project.id;
  const issues = listProjectIssues(ctx.db, projectId);
  return {
    kind: 'tasks',
    projectId,
    repository: ctx.profile.repository.nameWithOwner,
    freshness: loadCollectionFreshness(ctx.db),
    issues: issues.map((issue) => summarizeIssue(ctx.db, issue)),
  };
}

export function buildTaskReport(
  ctx: ReportContext,
  issueArg: string,
): TaskReport {
  const issue = findIssueInDatabase(
    ctx.db,
    issueArg,
    ctx.profile.repository.nameWithOwner,
  );
  if (!issue) {
    throw reportSetupError(
      `Issue '${issueArg}' is not in the local database.`,
      'Run orca-telemetry collect to import GitHub Project issues, then link sessions.',
    );
  }
  return {
    kind: 'task',
    projectId: ctx.profile.project.id,
    repository: ctx.profile.repository.nameWithOwner,
    freshness: loadCollectionFreshness(ctx.db),
    issue: summarizeIssue(ctx.db, issue),
  };
}

function formatProviderRollup(p: ProviderUsageRollup): string {
  const models =
    p.models.length === 0 ? 'unknown' : p.models.join(', ');
  const alloc =
    p.mixedModelAllocation === 'unknown' ? ' (allocation unknown)' : '';
  return `${p.provider}: in=${p.input} out=${p.output} cacheR=${p.cacheRead} cacheW=${p.cacheWrite} models=${models}${alloc}`;
}

export function formatTasksReportText(report: TasksReport): string {
  const lines = [
    `Tasks report — project ${report.projectId}`,
    `Repository: ${report.repository}`,
  ];
  if (report.freshness.length > 0) {
    lines.push('Collection snapshot (latest per source):');
    for (const f of report.freshness) {
      lines.push(`  ${f.source}: ${f.status} @ ${f.recordedAt}`);
    }
  }
  lines.push('');
  const columns: TableColumn[] = [
    { key: 'issue', header: 'Issue', width: 28 },
    { key: 'map', header: 'Mapping', width: 18 },
    { key: 'sessions', header: 'Sessions', width: 8, align: 'right' },
    { key: 'cost', header: 'Cost (est.)', width: 12, align: 'right' },
  ];
  const rows = report.issues.map((item) => {
    const label = sanitizeDisplayText(
      `${item.issue.repository.nameWithOwner}#${item.issue.number}`,
    );
    const costKnown = item.cost.knownAmountUsd;
    const cost =
      costKnown > 0 || item.cost.knownEstimatedCount > 0
        ? formatUsd(costKnown)
        : item.cost.unknownAmountCount > 0
          ? 'unknown'
          : item.usageStatus === 'no_usage_data'
            ? 'no data'
            : formatUsd(0);
    return {
      issue: label,
      map: item.mappingStatus === 'mapped' ? 'mapped' : 'no linked sessions',
      sessions: String(item.sessionCount),
      cost,
    };
  });
  lines.push(renderTable(columns, rows).trimEnd());
  return `${lines.join('\n')}\n`;
}

export function formatTaskReportText(report: TaskReport): string {
  const item = report.issue;
  const lines = [
    `Task report — ${sanitizeDisplayText(item.issue.url)}`,
    `Title: ${sanitizeDisplayText(item.issue.title)}`,
    `Mapping: ${item.mappingStatus}`,
    `Usage: ${item.usageStatus}`,
    '',
  ];
  if (item.byProvider.length > 0) {
    lines.push('By provider:');
    for (const p of item.byProvider) {
      lines.push(`  ${formatProviderRollup(p)}`);
    }
    lines.push(
      `Cost known (est. API-equiv): ${formatUsd(item.cost.knownAmountUsd)}; unknown cost sessions: ${item.cost.unknownAmountCount}`,
    );
    lines.push('');
  }
  if (item.sessions.length === 0) {
    lines.push('No linked usage sessions for this issue.');
    return `${lines.join('\n')}\n`;
  }
  const columns: TableColumn[] = [
    { key: 'provider', header: 'Provider', width: 8 },
    { key: 'session', header: 'Session', width: 36 },
    { key: 'models', header: 'Models', width: 20 },
    { key: 'in', header: 'In', width: 6, align: 'right' },
    { key: 'out', header: 'Out', width: 6, align: 'right' },
    { key: 'cost', header: 'Cost', width: 10, align: 'right' },
    { key: 'orca', header: 'Orca', width: 8 },
  ];
  const rows = item.sessions.map((s) => ({
    provider: s.provider,
    session: s.rawSessionId,
    models:
      s.models.length === 0
        ? 'unknown'
        : s.modelAllocation === 'unknown'
          ? `${s.models.join(', ')} (alloc unknown)`
          : s.models.join(', '),
    in: String(s.tokens.input),
    out: String(s.tokens.output),
    cost:
      s.cost.kind === 'unknown' || s.cost.amountUsd === null
        ? 'unknown'
        : formatUsd(s.cost.amountUsd),
    orca: s.orcaReference.status,
  }));
  lines.push(renderTable(columns, rows).trimEnd());
  return `${lines.join('\n')}\n`;
}
