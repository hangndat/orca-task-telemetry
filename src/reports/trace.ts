import type { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import type { GitHubIssue, TokenUsage, TraceRelation, UsageProvider } from '../contracts.js';
import { loadConfig } from '../config.js';
import { dbSchemaError } from '../db/errors.js';
import { openReadOnlyTelemetryDb } from '../db/read-only.js';
import { parseTokensJson } from '../db/serialize.js';
import { CliError, EXIT_ENVIRONMENT } from '../errors.js';
import { createDefaultPathEnv, resolveAppPaths } from '../paths.js';
import { listProfiles } from '../profiles.js';
import { parseGithubRemoteUrl } from '../repo.js';
import { findIssueInDatabase, type ReportContext } from './tasks.js';
import { formatUsd, sanitizeDisplayText, type OrcaReferenceField, type ReportCostField } from './render.js';

/** Select the local profile from git remotes without calling GitHub. */
export async function openTraceReportContext(cwd: string): Promise<ReportContext> {
  const paths = resolveAppPaths(createDefaultPathEnv());
  const config = loadConfig(paths.appHome);
  let remotes: string;
  try {
    remotes = execFileSync('git', ['-C', cwd, 'remote', '-v'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    throw new CliError({ code: 'report_setup', message: 'Could not read local git remotes.',
      hint: 'Run from a repository with a GitHub remote.', exitCode: EXIT_ENVIRONMENT });
  }
  const names = new Set(remotes.split('\n').filter(line => line.trimEnd().endsWith('(fetch)'))
    .map(line => line.trim().split(/\s+/)[1]).filter((url): url is string => !!url)
    .map(url => parseGithubRemoteUrl(url))
    .filter((repo): repo is { owner: string; repo: string } => repo !== null)
    .map(repo => `${repo.owner}/${repo.repo}`.toLowerCase()));
  const matches = listProfiles(config).filter(profile =>
    names.has(profile.repository.nameWithOwner.toLowerCase()));
  if (matches.length !== 1) {
    throw new CliError({ code: 'report_setup',
      message: matches.length ? 'Multiple local telemetry profiles match this repository.' :
        'No local telemetry profile matches this repository.',
      hint: 'Run orca-telemetry init for this repository.', exitCode: EXIT_ENVIRONMENT });
  }
  if (!fs.existsSync(paths.dbPath)) {
    throw new CliError({ code: 'report_setup', message: 'Telemetry database not found.',
      hint: 'Run orca-telemetry collect first.', exitCode: EXIT_ENVIRONMENT });
  }
  const handle = await openReadOnlyTelemetryDb(paths.dbPath);
  return { profile: matches[0]!, db: handle.db, close: () => handle.release() };
}

type SessionRow = {
  session_key: string; provider: UsageProvider; source: string;
  method: string; linked_at: string;
  observed_at: string | null; tokens_json: string | null;
  cost_amount_usd: number | null; cost_kind: string | null;
};

export type TraceSession = {
  sessionKey: string; provider: UsageProvider; source: string;
  linkMethod: 'manual'; linkedAt: string;
  snapshotObservedAt: string | null;
  tokens: TokenUsage | null; cost: ReportCostField;
  orcaReference: OrcaReferenceField;
};

export type TraceUsage = {
  sessionCount: number; snapshotCount: number; missingSnapshotCount: number;
  byProvider: {
    provider: UsageProvider; sessionCount: number; missingSnapshotCount: number;
    knownTokens: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number | null };
    tokensComplete: boolean;
  }[];
  cost: ReportCostField & { knownAmountUsd: number; unknownSessionCount: number };
};

export type TraceCommit = {
  oid: string; url: string; relation: TraceRelation;
  sessionKeys: string[]; usage: TraceUsage;
};

export type TracePull = {
  pullNodeId: string; url: string; state: string; isDraft: boolean;
  mergedAt: string | null; observedAt: string;
  issueRelation: TraceRelation;
  sessions: TraceSession[]; usage: TraceUsage; commits: TraceCommit[];
};

export type TraceReport = {
  kind: 'trace'; issue: GitHubIssue;
  issueSessions: TraceSession[]; issueUsage: TraceUsage;
  pullRequests: TracePull[]; warnings: string[];
};

function relation(status: string, source: string, lastVerifiedAt: string | null): TraceRelation {
  if (!['verified_current', 'stale', 'unknown'].includes(status) ||
      !['closingIssuesReferences', 'pullRequest.commits'].includes(source)) {
    throw dbSchemaError('Invalid stored trace relation.');
  }
  return { status: status as TraceRelation['status'],
    source: source as TraceRelation['source'], lastVerifiedAt };
}

function sessionsForIssue(db: DatabaseSync, issueNodeId: string): TraceSession[] {
  const rows = db.prepare(`SELECT sl.session_key, us.provider, us.source, sl.method, sl.linked_at,
      snap.observed_at, snap.tokens_json, snap.cost_amount_usd, snap.cost_kind
    FROM session_links sl
    INNER JOIN usage_sessions us ON us.session_key = sl.session_key
    LEFT JOIN usage_snapshots snap ON snap.session_key = sl.session_key
    WHERE sl.issue_node_id = ? ORDER BY sl.session_key`).all(issueNodeId) as SessionRow[];
  return rows.map(row => {
    if (row.method !== 'manual') throw dbSchemaError('Unexpected session link method.');
    if (!['claude', 'codex', 'cursor'].includes(row.provider) || row.source !== 'agent-top') {
      throw dbSchemaError('Invalid usage session provenance.');
    }
    let tokens: TokenUsage | null = null;
    if (row.tokens_json !== null) {
      try { tokens = parseTokensJson(row.tokens_json); }
      catch { throw dbSchemaError('Invalid tokens_json in usage_snapshots.'); }
      if (tokens.provider !== row.provider) throw dbSchemaError('Snapshot provider mismatch.');
      for (const field of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) {
        if (!Number.isSafeInteger(tokens[field]) || tokens[field] < 0) {
          throw dbSchemaError('Invalid snapshot token count.');
        }
      }
      if (tokens.provider === 'codex' && tokens.reasoning !== null &&
          (!Number.isSafeInteger(tokens.reasoning) || tokens.reasoning < 0)) {
        throw dbSchemaError('Invalid snapshot reasoning count.');
      }
    }
    const hasSnapshot = row.observed_at !== null && tokens !== null;
    if ((row.observed_at === null) !== (row.tokens_json === null)) {
      throw dbSchemaError('Incomplete usage snapshot.');
    }
    if (hasSnapshot && row.cost_kind !== 'unknown' && row.cost_kind !== 'estimated_api_equivalent') {
      throw dbSchemaError('Invalid snapshot cost kind.');
    }
    if (hasSnapshot && (row.cost_kind === 'unknown') !== (row.cost_amount_usd === null)) {
      throw dbSchemaError('Inconsistent snapshot cost.');
    }
    if (row.cost_amount_usd !== null &&
        (!Number.isFinite(row.cost_amount_usd) || row.cost_amount_usd < 0)) {
      throw dbSchemaError('Invalid snapshot cost amount.');
    }
    return {
      sessionKey: row.session_key, provider: row.provider, source: row.source,
      linkMethod: 'manual' as const, linkedAt: row.linked_at,
      snapshotObservedAt: row.observed_at, tokens,
      cost: hasSnapshot && row.cost_kind === 'estimated_api_equivalent'
        ? { amountUsd: row.cost_amount_usd, kind: 'estimated_api_equivalent' as const }
        : { amountUsd: null, kind: 'unknown' as const },
      orcaReference: { status: 'unknown' as const },
    };
  });
}

function usage(sessions: TraceSession[]): TraceUsage {
  const unique = [...new Map(sessions.map(s => [s.sessionKey, s])).values()];
  const known = unique.filter(s => s.cost.amountUsd !== null);
  const unknownSessionCount = unique.length - known.length;
  const knownAmountUsd = known.reduce((sum, s) => sum + s.cost.amountUsd!, 0);
  const byProvider = [...new Set(unique.map(s => s.provider))].sort().map(provider => {
    const scoped = unique.filter(s => s.provider === provider);
    const withSnapshot = scoped.filter(s => s.tokens !== null);
    const sum = (field: 'input' | 'output' | 'cacheRead' | 'cacheWrite') =>
      withSnapshot.reduce((total, s) => total + s.tokens![field], 0);
    const knownReasoning = provider === 'codex' && withSnapshot.length > 0 && withSnapshot.every(s =>
      s.tokens?.provider === 'codex' && s.tokens.reasoning !== null);
    return {
      provider, sessionCount: scoped.length,
      missingSnapshotCount: scoped.length - withSnapshot.length,
      knownTokens: { input: sum('input'), output: sum('output'),
        cacheRead: sum('cacheRead'), cacheWrite: sum('cacheWrite'),
        reasoning: knownReasoning
          ? withSnapshot.reduce((total, s) => total + (s.tokens?.provider === 'codex' ? s.tokens.reasoning ?? 0 : 0), 0)
          : null },
      tokensComplete: withSnapshot.length === scoped.length,
    };
  });
  return {
    sessionCount: unique.length,
    snapshotCount: unique.filter(s => s.snapshotObservedAt !== null).length,
    missingSnapshotCount: unique.filter(s => s.snapshotObservedAt === null).length,
    byProvider,
    cost: {
      amountUsd: unknownSessionCount || unique.length === 0 ? null : knownAmountUsd,
      kind: unknownSessionCount || unique.length === 0 ? 'unknown' : 'estimated_api_equivalent',
      knownAmountUsd, unknownSessionCount,
    },
  };
}

type PullRow = {
  pull_node_id: string; url: string; state: string; is_draft: number;
  merged_at: string | null; observed_at: string;
  status: string; source: string; last_verified_at: string | null;
};
type CommitRow = {
  oid: string; url: string; status: string; last_verified_at: string | null;
};

export function buildTraceReport(ctx: ReportContext, issueArg: string): TraceReport {
  const issue = findIssueInDatabase(ctx.db, issueArg, ctx.profile.repository.nameWithOwner);
  if (!issue) throw new CliError({ code: 'report_setup',
    message: `Issue '${issueArg}' is not in the local database.`,
    hint: 'Run orca-telemetry collect to import the Issue first.', exitCode: EXIT_ENVIRONMENT });
  const issueSessions = sessionsForIssue(ctx.db, issue.issueNodeId);
  const byKey = new Map(issueSessions.map(s => [s.sessionKey, s]));
  const pulls = ctx.db.prepare(`SELECT pr.pull_node_id, pr.url, pr.state, pr.is_draft,
      pr.merged_at, pr.observed_at, rel.status, rel.source, rel.last_verified_at
    FROM issue_pull_relations rel
    INNER JOIN pull_requests pr ON pr.pull_node_id = rel.pull_node_id
    WHERE rel.issue_node_id = ?
      AND EXISTS (SELECT 1 FROM session_pull_links spl
        WHERE spl.issue_node_id = rel.issue_node_id AND spl.pull_node_id = rel.pull_node_id)
    ORDER BY pr.url, pr.pull_node_id`).all(issue.issueNodeId) as PullRow[];
  const warnings: string[] = [];
  const pullRequests: TracePull[] = pulls.map(pull => {
    const linkRows = ctx.db.prepare(`SELECT session_key FROM session_pull_links
      WHERE issue_node_id = ? AND pull_node_id = ? ORDER BY session_key`)
      .all(issue.issueNodeId, pull.pull_node_id) as { session_key: string }[];
    const sessions = linkRows.map(row => {
      const session = byKey.get(row.session_key);
      if (!session) throw dbSchemaError('PR session link lacks its Issue session link.');
      return session;
    });
    const commits = ctx.db.prepare(`SELECT pc.oid, pc.url, pc.status, pc.last_verified_at
      FROM pull_commits pc WHERE pc.pull_node_id = ?
        AND EXISTS (SELECT 1 FROM session_commit_links scl
          INNER JOIN session_pull_links spl ON spl.session_key = scl.session_key
            AND spl.pull_node_id = scl.pull_node_id
          WHERE scl.pull_node_id = pc.pull_node_id AND scl.oid = pc.oid
            AND spl.issue_node_id = ?)
      ORDER BY pc.oid`).all(pull.pull_node_id, issue.issueNodeId) as CommitRow[];
    const mappedCommits: TraceCommit[] = commits.map(commit => {
      const keys = ctx.db.prepare(`SELECT scl.session_key FROM session_commit_links scl
        INNER JOIN session_pull_links spl ON spl.session_key = scl.session_key
          AND spl.pull_node_id = scl.pull_node_id
        WHERE scl.pull_node_id = ? AND scl.oid = ? AND spl.issue_node_id = ?
        ORDER BY scl.session_key`)
        .all(pull.pull_node_id, commit.oid, issue.issueNodeId) as { session_key: string }[];
      const commitSessions = keys.map(row => {
        const session = byKey.get(row.session_key);
        if (!session) throw dbSchemaError('Commit session link lacks its Issue session link.');
        return session;
      });
      const rel = relation(commit.status, 'pullRequest.commits', commit.last_verified_at);
      if (rel.status !== 'verified_current') warnings.push(`Commit ${commit.oid}: ${rel.status}; membership is not current.`);
      return { oid: commit.oid, url: commit.url, relation: rel,
        sessionKeys: commitSessions.map(s => s.sessionKey), usage: usage(commitSessions) };
    });
    const issueRelation = relation(pull.status, pull.source, pull.last_verified_at);
    if (issueRelation.status !== 'verified_current') warnings.push(`PR ${pull.url}: Issue relation ${issueRelation.status}; last verified ${issueRelation.lastVerifiedAt ?? 'never'}.`);
    return { pullNodeId: pull.pull_node_id, url: pull.url, state: pull.state,
      isDraft: pull.is_draft === 1, mergedAt: pull.merged_at, observedAt: pull.observed_at,
      issueRelation, sessions, usage: usage(sessions), commits: mappedCommits };
  });
  if (pullRequests.length === 0) warnings.push('No manually linked PR trace for this Issue.');
  if (issueSessions.some(s => s.snapshotObservedAt === null)) warnings.push('Some linked sessions have no usage snapshot; cost and tokens are unknown.');
  if (issueSessions.some(s => s.cost.kind === 'unknown')) warnings.push('Some session cost is unknown; it is not zero.');
  if (pullRequests.length > 1 || pullRequests.some(pr => pr.commits.length > 1)) {
    warnings.push('A session can appear in multiple PR or commit paths; do not add path totals to obtain Issue usage.');
  }
  warnings.push('GitHub relation status reflects completed page reads, not an atomic point-in-time snapshot. Cost is estimated API equivalent, never actual billing. Orca references are unknown unless independently verified.');
  return { kind: 'trace', issue, issueSessions, issueUsage: usage(issueSessions), pullRequests, warnings };
}

function displayCost(usageValue: TraceUsage): string {
  return usageValue.cost.amountUsd === null ?
    `unknown (known estimate ${formatUsd(usageValue.cost.knownAmountUsd)})` :
    `${formatUsd(usageValue.cost.amountUsd)} estimated API equivalent`;
}

function providerTokenLines(usageValue: TraceUsage, indent: string): string[] {
  return usageValue.byProvider.map(provider =>
    `${indent}${provider.provider} known tokens: in=${provider.knownTokens.input} out=${provider.knownTokens.output} cacheR=${provider.knownTokens.cacheRead} cacheW=${provider.knownTokens.cacheWrite} reasoning=${provider.knownTokens.reasoning ?? 'unknown'}; complete=${provider.tokensComplete}; sessions=${provider.sessionCount}; missing snapshots=${provider.missingSnapshotCount}`);
}

export function formatTraceReportText(report: TraceReport): string {
  const lines = [
    `Trace report — ${sanitizeDisplayText(report.issue.url)}`,
    `Issue usage: ${report.issueUsage.sessionCount} linked sessions; ${displayCost(report.issueUsage)}; missing snapshots: ${report.issueUsage.missingSnapshotCount}`,
    'Issue sessions:',
  ];
  lines.push(...providerTokenLines(report.issueUsage, '  '));
  if (report.issueSessions.length === 0) lines.push('  none');
  for (const session of report.issueSessions) {
    lines.push(`  ${sanitizeDisplayText(session.sessionKey)} [${session.linkMethod}, ${session.provider}/${session.source}, Orca ${session.orcaReference.status}]: ${session.cost.amountUsd === null ? 'unknown cost' : formatUsd(session.cost.amountUsd)}`);
  }
  lines.push('PR traces:');
  if (report.pullRequests.length === 0) lines.push('  none');
  for (const pull of report.pullRequests) {
    lines.push(`  ${sanitizeDisplayText(pull.url)} — ${pull.state}, draft=${pull.isDraft}, mergedAt=${pull.mergedAt ?? 'null'}`);
    lines.push(`    Issue relation: ${pull.issueRelation.status} via ${pull.issueRelation.source}; lastVerifiedAt=${pull.issueRelation.lastVerifiedAt ?? 'null'}`);
    lines.push(`    Usage: ${pull.usage.sessionCount} sessions; ${displayCost(pull.usage)}`);
    lines.push(...providerTokenLines(pull.usage, '      '));
    for (const session of pull.sessions) lines.push(`    Session: ${sanitizeDisplayText(session.sessionKey)} [manual]`);
    for (const commit of pull.commits) {
      lines.push(`    Commit ${commit.oid}: ${commit.relation.status} via ${commit.relation.source}; lastVerifiedAt=${commit.relation.lastVerifiedAt ?? 'null'}; sessions=${commit.sessionKeys.map(sanitizeDisplayText).join(', ')}; cost=${displayCost(commit.usage)}`);
      lines.push(...providerTokenLines(commit.usage, '      '));
    }
  }
  lines.push('Warnings:');
  for (const warning of report.warnings) lines.push(`  ${sanitizeDisplayText(warning)}`);
  return `${lines.join('\n')}\n`;
}
