/**
 * V1.4 slice 3 — `report overhead`: coordinator vs worker usage for one
 * selected Orca Run (`--run`, optionally `--host`). Read-only; never writes,
 * never infers role/Issue from time/path/title, never claims full Run
 * coverage. See docs/V1-COORDINATOR-OVERHEAD-SPEC.md AC1-AC3.
 */
import fs from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import type { UsageProvider } from '../contracts.js';
import { USAGE_PROVIDERS } from '../contracts.js';
import { parseTokensJson } from '../db/serialize.js';
import { dbSchemaError } from '../db/errors.js';
import { openReadOnlyTelemetryDb } from '../db/read-only.js';
import { CliError, EXIT_ENVIRONMENT } from '../errors.js';
import { createDefaultPathEnv, resolveAppPaths } from '../paths.js';
import { formatUsd, sanitizeDisplayText } from './render.js';

const ATTEMPT_FRESHNESS_SECONDS = 24 * 60 * 60;

export type OverheadRole = 'coordinator' | 'worker';

export type OverheadSourceScope = 'orca' | 'claude' | 'codex';

export type OverheadSourceStatus = {
  status: 'running' | 'success' | 'failed' | 'partial' | 'missing';
  startedAt: string | null;
  completedAt: string | null;
  ageSeconds: number | null;
  errorCode: string | null;
};

export type OverheadUnknownReason =
  | 'partial_source'
  | 'stale_source'
  | 'missing_snapshot'
  | 'unknown_cost'
  | 'zero_denominator';

export type OverheadProviderUsage = {
  provider: UsageProvider;
  sessionCount: number;
  missingSnapshotCount: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    reasoning: number | null;
  };
};

export type OverheadRoleUsage = {
  sessionCount: number;
  /** Distinct Dispatch count for workers; null for coordinator (no Dispatch concept). */
  dispatchCount: number | null;
  byProvider: OverheadProviderUsage[];
  missingSnapshotCount: number;
  /** Sum of known costs only; always finite. Pair with unknownCostSessionCount, never 0 alone. */
  knownCostUsd: number;
  unknownCostSessionCount: number;
  /** null whenever any session in this role has unknown cost. */
  costUsd: number | null;
};

export type OverheadRatio = {
  value: number | null;
  unknownReason: OverheadUnknownReason | null;
};

export type OverheadReport = {
  kind: 'overhead';
  hostId: string;
  runId: string;
  sourceStatus: Record<OverheadSourceScope, OverheadSourceStatus>;
  coverage: 'unknown';
  classifiedSessionCount: number;
  unclassifiedSessionCount: null;
  coordinator: OverheadRoleUsage;
  workers: OverheadRoleUsage;
  overheadShare: OverheadRatio;
  overheadPerWorkerCost: OverheadRatio;
  warnings: string[];
};

export type OverheadReportContext = {
  db: DatabaseSync;
  close(): void;
};

function reportSetupError(message: string, hint?: string): CliError {
  return new CliError({ code: 'report_setup', message, hint, exitCode: EXIT_ENVIRONMENT });
}

function renderSelectorId(value: string): string {
  return JSON.stringify(value).replace(/[\u007F-\u009F]/g,
    (control) => `\\u${control.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/**
 * Overhead report is scoped by `--run` and the resolved host, not by a GitHub
 * Project profile; it only needs the shared local telemetry database.
 */
export async function openOverheadReportContext(): Promise<OverheadReportContext> {
  const paths = resolveAppPaths(createDefaultPathEnv());
  if (!fs.existsSync(paths.dbPath)) {
    throw reportSetupError(
      'Telemetry database not found.',
      'Run orca-telemetry init and orca-telemetry collect first.',
    );
  }
  const handle = await openReadOnlyTelemetryDb(paths.dbPath);
  return { db: handle.db, close: () => handle.release() };
}

/** Resolve an omitted host only when the persisted Run has exactly one host. */
export function resolveOverheadHost(ctx: OverheadReportContext, runId: string): string {
  const rows = ctx.db
    .prepare('SELECT host_id FROM orca_runs WHERE run_id = ? ORDER BY host_id')
    .all(runId) as { host_id: string }[];
  if (rows.length === 1) return rows[0]!.host_id;

  const candidates = `[${rows.map((row) => renderSelectorId(row.host_id)).join(',')}]`;
  if (rows.length === 0) {
    throw new CliError({
      code: 'report_run_not_found',
      message: `Run ${renderSelectorId(runId)} is not in the local database; candidate host IDs: ${candidates}.`,
      hint: 'Collect this Orca Run before reporting overhead, or pass the exact --host/--run.',
      exitCode: EXIT_ENVIRONMENT,
    });
  }
  throw new CliError({
    code: 'report_run_ambiguous',
    message: `Run ${renderSelectorId(runId)} matches multiple hosts; candidate host IDs: ${candidates}.`,
    hint: 'Pass --host with the exact host ID for this Run.',
    exitCode: EXIT_ENVIRONMENT,
  });
}

type AttemptRow = {
  status: 'running' | 'success' | 'failed' | 'partial';
  started_at: string;
  completed_at: string | null;
  error_code: string | null;
};

function toSourceStatus(row: AttemptRow | undefined, nowMs: number): OverheadSourceStatus {
  if (!row) {
    return { status: 'missing', startedAt: null, completedAt: null, ageSeconds: null, errorCode: null };
  }
  let ageSeconds: number | null = null;
  if (row.completed_at !== null) {
    const completedMs = Date.parse(row.completed_at);
    if (Number.isFinite(completedMs)) {
      ageSeconds = (nowMs - completedMs) / 1000;
    }
  }
  return {
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    ageSeconds,
    errorCode: row.error_code,
  };
}

function loadOrcaSourceStatus(
  db: DatabaseSync,
  hostId: string,
  runId: string,
  nowMs: number,
): OverheadSourceStatus {
  const row = db
    .prepare(
      `SELECT status, started_at, completed_at, error_code
       FROM collection_attempts
       WHERE source = 'orca' AND host_id = ? AND run_id = ?
       ORDER BY attempt_id DESC LIMIT 1`,
    )
    .get(hostId, runId) as AttemptRow | undefined;
  return toSourceStatus(row, nowMs);
}

function loadProviderSourceStatus(
  db: DatabaseSync,
  provider: UsageProvider,
  nowMs: number,
): OverheadSourceStatus {
  const row = db
    .prepare(
      `SELECT status, started_at, completed_at, error_code
       FROM collection_attempts
       WHERE source = 'agent-top' AND provider = ?
       ORDER BY attempt_id DESC LIMIT 1`,
    )
    .get(provider) as AttemptRow | undefined;
  return toSourceStatus(row, nowMs);
}

function isFresh(status: OverheadSourceStatus): boolean {
  return (
    status.status === 'success' &&
    status.ageSeconds !== null &&
    status.ageSeconds >= 0 &&
    status.ageSeconds <= ATTEMPT_FRESHNESS_SECONDS
  );
}

type RoleRow = {
  session_key: string;
  role: OverheadRole;
  dispatch_id: string | null;
  provider: UsageProvider;
  observed_at: string | null;
  tokens_json: string | null;
  cost_amount_usd: number | null;
  cost_kind: 'estimated_api_equivalent' | 'unknown' | null;
};

function loadRoleRows(db: DatabaseSync, hostId: string, runId: string): RoleRow[] {
  return db
    .prepare(
      `SELECT srl.session_key, srl.role, srl.dispatch_id, us.provider,
              snap.observed_at, snap.tokens_json, snap.cost_amount_usd, snap.cost_kind
       FROM session_role_links srl
       INNER JOIN usage_sessions us ON us.session_key = srl.session_key
       LEFT JOIN usage_snapshots snap ON snap.session_key = srl.session_key
       WHERE srl.host_id = ? AND srl.run_id = ?
       ORDER BY srl.session_key`,
    )
    .all(hostId, runId) as RoleRow[];
}

function emptyProviderUsage(provider: UsageProvider): OverheadProviderUsage {
  return {
    provider,
    sessionCount: 0,
    missingSnapshotCount: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: null },
  };
}

function rollupRole(rows: RoleRow[], role: OverheadRole): OverheadRoleUsage {
  const scoped = rows.filter((row) => row.role === role);
  const dispatchIds = new Set(
    scoped.map((row) => row.dispatch_id).filter((id): id is string => id !== null),
  );
  let knownCostUsd = 0;
  let unknownCostSessionCount = 0;
  let missingSnapshotCount = 0;
  const byProvider: OverheadProviderUsage[] = [];
  for (const provider of USAGE_PROVIDERS) {
    const providerRows = scoped.filter((row) => row.provider === provider);
    if (providerRows.length === 0) {
      continue;
    }
    const withSnapshot = providerRows.filter((row) => row.observed_at !== null);
    const parsed = withSnapshot.map((row) => {
      if (row.tokens_json === null) {
        throw dbSchemaError('Role-linked snapshot is missing tokens_json.');
      }
      const tokens = parseTokensJson(row.tokens_json);
      if (tokens.provider !== provider) {
        throw dbSchemaError('Role-linked snapshot provider mismatch.');
      }
      return tokens;
    });
    const sum = (field: 'input' | 'output' | 'cacheRead' | 'cacheWrite') => {
      const total = parsed.reduce((acc, t) => acc + t[field], 0);
      if (!Number.isSafeInteger(total)) {
        throw dbSchemaError(`Role-linked token aggregate overflowed for ${field}.`);
      }
      return total;
    };
    const reasoningKnown =
      provider === 'codex' &&
      parsed.length === providerRows.length &&
      parsed.length > 0 &&
      parsed.every((t) => t.provider === 'codex' && t.reasoning !== null);
    let reasoningTotal: number | null = null;
    if (reasoningKnown) {
      reasoningTotal = parsed.reduce(
        (total, t) => total + (t.provider === 'codex' ? t.reasoning ?? 0 : 0),
        0,
      );
      if (!Number.isSafeInteger(reasoningTotal)) {
        throw dbSchemaError('Role-linked token aggregate overflowed for reasoning.');
      }
    }
    byProvider.push({
      provider,
      sessionCount: providerRows.length,
      missingSnapshotCount: providerRows.length - withSnapshot.length,
      tokens: {
        input: sum('input'),
        output: sum('output'),
        cacheRead: sum('cacheRead'),
        cacheWrite: sum('cacheWrite'),
        reasoning: reasoningTotal,
      },
    });
  }
  for (const row of scoped) {
    if (row.observed_at === null) {
      missingSnapshotCount += 1;
      unknownCostSessionCount += 1;
      continue;
    }
    if (row.cost_kind === 'unknown') {
      if (row.cost_amount_usd !== null) {
        throw dbSchemaError('Unknown role-linked snapshot cost has a non-null amount.');
      }
      unknownCostSessionCount += 1;
    } else if (row.cost_kind === 'estimated_api_equivalent' && row.cost_amount_usd !== null) {
      if (!Number.isFinite(row.cost_amount_usd) || row.cost_amount_usd < 0) {
        throw dbSchemaError('Role-linked snapshot cost_amount_usd is not a finite, nonnegative number.');
      }
      knownCostUsd += row.cost_amount_usd;
      if (!Number.isFinite(knownCostUsd)) {
        throw dbSchemaError('Role-linked known cost aggregate overflowed.');
      }
    } else {
      throw dbSchemaError('Invalid role-linked snapshot cost kind.');
    }
  }
  return {
    sessionCount: scoped.length,
    dispatchCount: role === 'worker' ? dispatchIds.size : null,
    byProvider,
    missingSnapshotCount,
    knownCostUsd,
    unknownCostSessionCount,
    costUsd: unknownCostSessionCount === 0 ? knownCostUsd : null,
  };
}

function firstUnknownReason(
  sourceStatus: Record<OverheadSourceScope, OverheadSourceStatus>,
  coordinator: OverheadRoleUsage,
  workers: OverheadRoleUsage,
): OverheadUnknownReason | null {
  const scopes: OverheadSourceScope[] = ['orca', 'claude', 'codex'];
  if (scopes.some((scope) => sourceStatus[scope].status !== 'success')) {
    return 'partial_source';
  }
  if (scopes.some((scope) => !isFresh(sourceStatus[scope]))) {
    return 'stale_source';
  }
  if (coordinator.missingSnapshotCount > 0 || workers.missingSnapshotCount > 0) {
    return 'missing_snapshot';
  }
  if (coordinator.unknownCostSessionCount > 0 || workers.unknownCostSessionCount > 0) {
    return 'unknown_cost';
  }
  return null;
}

function overheadShareRatio(
  reason: OverheadUnknownReason | null,
  coordinator: OverheadRoleUsage,
  workers: OverheadRoleUsage,
): OverheadRatio {
  if (reason !== null) {
    return { value: null, unknownReason: reason };
  }
  const numerator = coordinator.costUsd!;
  const denom = numerator + workers.costUsd!;
  if (!Number.isFinite(numerator) || !Number.isFinite(denom)) {
    throw dbSchemaError('overheadShare numerator or denominator overflowed.');
  }
  if (denom === 0) {
    return { value: null, unknownReason: 'zero_denominator' };
  }
  const value = numerator / denom;
  if (!Number.isFinite(value)) {
    throw dbSchemaError('overheadShare result is not finite.');
  }
  return { value, unknownReason: null };
}

function overheadPerWorkerCostRatio(
  reason: OverheadUnknownReason | null,
  coordinator: OverheadRoleUsage,
  workers: OverheadRoleUsage,
): OverheadRatio {
  if (reason !== null) {
    return { value: null, unknownReason: reason };
  }
  const numerator = coordinator.costUsd!;
  const denom = workers.costUsd!;
  if (!Number.isFinite(numerator) || !Number.isFinite(denom)) {
    throw dbSchemaError('overheadPerWorkerCost numerator or denominator overflowed.');
  }
  if (denom === 0) {
    return { value: null, unknownReason: 'zero_denominator' };
  }
  const value = numerator / denom;
  if (!Number.isFinite(value)) {
    throw dbSchemaError('overheadPerWorkerCost result is not finite.');
  }
  return { value, unknownReason: null };
}

export function buildOverheadReport(
  ctx: OverheadReportContext,
  hostId: string,
  runId: string,
  now: Date = new Date(),
): OverheadReport {
  const runRow = ctx.db
    .prepare('SELECT 1 FROM orca_runs WHERE host_id = ? AND run_id = ?')
    .get(hostId, runId);
  if (!runRow) {
    throw reportSetupError(
      `Run ${renderSelectorId(runId)} on host ${renderSelectorId(hostId)} is not in the local database.`,
      'Collect this Orca Run before reporting overhead, and pass the exact --host/--run.',
    );
  }

  const nowMs = now.getTime();
  const sourceStatus: Record<OverheadSourceScope, OverheadSourceStatus> = {
    orca: loadOrcaSourceStatus(ctx.db, hostId, runId, nowMs),
    claude: loadProviderSourceStatus(ctx.db, 'claude', nowMs),
    codex: loadProviderSourceStatus(ctx.db, 'codex', nowMs),
  };

  const rows = loadRoleRows(ctx.db, hostId, runId);
  const coordinator = rollupRole(rows, 'coordinator');
  const workers = rollupRole(rows, 'worker');

  const reason = firstUnknownReason(sourceStatus, coordinator, workers);
  const overheadShare = overheadShareRatio(reason, coordinator, workers);
  const overheadPerWorkerCost = overheadPerWorkerCostRatio(reason, coordinator, workers);

  const warnings = [
    'coverage is unknown: Orca/agent-top collection success does not prove every session of this Run was found.',
    'Cost is estimated API equivalent, never actual billing or Orca runtime cost.',
    'overheadShare only describes the linked/classified session set, not full Run usage.',
  ];
  if (coordinator.missingSnapshotCount > 0 || workers.missingSnapshotCount > 0) {
    warnings.push('Some role-linked sessions have no usage snapshot; their cost and tokens are unknown.');
  }

  return {
    kind: 'overhead',
    hostId,
    runId,
    sourceStatus,
    coverage: 'unknown',
    classifiedSessionCount: coordinator.sessionCount + workers.sessionCount,
    unclassifiedSessionCount: null,
    coordinator,
    workers,
    overheadShare,
    overheadPerWorkerCost,
    warnings,
  };
}

function formatSourceStatus(status: OverheadSourceStatus): string {
  const age = status.ageSeconds === null ? 'unknown' : `${Math.round(status.ageSeconds)}s`;
  const completedAt = status.completedAt === null ? 'null' : sanitizeDisplayText(status.completedAt);
  const errorCode = status.errorCode === null ? 'none' : sanitizeDisplayText(status.errorCode);
  return `${status.status} (completedAt=${completedAt}, age=${age}, error=${errorCode})`;
}

function formatProviderRows(byProvider: OverheadProviderUsage[]): string[] {
  return byProvider.map(
    (p) =>
      `    ${p.provider}: sessions=${p.sessionCount} missingSnapshots=${p.missingSnapshotCount} ` +
      `in=${p.tokens.input} out=${p.tokens.output} cacheR=${p.tokens.cacheRead} ` +
      `cacheW=${p.tokens.cacheWrite} reasoning=${p.tokens.reasoning ?? 'unknown'}`,
  );
}

function formatRatio(ratio: OverheadRatio): string {
  return ratio.value === null ? `unknown (${ratio.unknownReason})` : ratio.value.toFixed(4);
}

function formatRoleUsage(label: string, usage: OverheadRoleUsage): string[] {
  const lines = [
    `  ${label}: sessions=${usage.sessionCount}` +
      (usage.dispatchCount === null ? '' : ` dispatches=${usage.dispatchCount}`) +
      ` cost=${usage.costUsd === null ? 'unknown' : formatUsd(usage.costUsd)}` +
      ` (known=${formatUsd(usage.knownCostUsd)}, unknownCostSessions=${usage.unknownCostSessionCount})`,
  ];
  lines.push(...formatProviderRows(usage.byProvider));
  return lines;
}

export function formatOverheadReportText(report: OverheadReport): string {
  const lines = [
    `Overhead report — host ${sanitizeDisplayText(report.hostId)} / run ${sanitizeDisplayText(report.runId)}`,
    `Source status: orca=${formatSourceStatus(report.sourceStatus.orca)}`,
    `               claude=${formatSourceStatus(report.sourceStatus.claude)}`,
    `               codex=${formatSourceStatus(report.sourceStatus.codex)}`,
    `Coverage: ${report.coverage}; classifiedSessionCount=${report.classifiedSessionCount}; ` +
      `unclassifiedSessionCount=${report.unclassifiedSessionCount ?? 'null'}`,
    '',
  ];
  lines.push(...formatRoleUsage('Coordinator', report.coordinator));
  lines.push(...formatRoleUsage('Workers', report.workers));
  lines.push('');
  lines.push(`overheadShare: ${formatRatio(report.overheadShare)}`);
  lines.push(`overheadPerWorkerCost: ${formatRatio(report.overheadPerWorkerCost)}`);
  lines.push('Warnings:');
  for (const warning of report.warnings) {
    lines.push(`  ${sanitizeDisplayText(warning)}`);
  }
  return `${lines.join('\n')}\n`;
}
