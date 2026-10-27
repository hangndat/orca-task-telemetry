/**
 * UAT preview of coordinator vs worker overhead. Pure, in-memory: every input is
 * an operator-supplied role mapping plus read-only Orca/agent-top data already
 * fetched by the caller. Nothing here touches the telemetry database, infers a
 * mapping, or claims Run-wide coverage. See docs/UAT-PREVIEW.md.
 */
import type { UsageProvider } from '../contracts.js';
import { USAGE_PROVIDERS } from '../contracts.js';
import type { ParsedUsage } from '../usage/sessions.js';
import { CliError, EXIT_USAGE } from '../errors.js';
import type { OrcaRunProvenance } from '../orca/run-provenance.js';
import { formatUsd, sanitizeDisplayText } from './render.js';

export const ROLES_SCHEMA_VERSION = 1;
export const MAX_ROLES_BYTES = 256 * 1024;
export const MAX_ROLE_ENTRIES = 200;
const MAX_ID_LENGTH = 256;

export type PreviewRole = 'coordinator' | 'worker';

export type RoleEntry = {
  role: PreviewRole;
  provider: UsageProvider;
  sessionId: string;
  dispatchId: string | null;
};

export type PreviewUsage = ParsedUsage;

/** Result of one read-only agent-top `sessions` call for a provider. */
export type ProviderSource =
  | { status: 'ok'; sessions: PreviewUsage[] }
  | { status: 'error'; errorCode: string };

export type PreviewEntryStatus = 'resolved' | 'session_not_found' | 'source_error';

export type PreviewEntry = {
  /** Zero-based position in the input manifest; never an agent-top identifier. */
  entryIndex: number;
  role: PreviewRole;
  provider: UsageProvider;
  dispatchId: string | null;
  verification: 'operator_supplied_unverified';
  status: PreviewEntryStatus;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    reasoning: number | null;
  } | null;
  tokenAllocation: 'known' | 'unknown' | null;
  costUsd: number | null;
  costKind: 'estimated_api_equivalent' | 'unknown';
};

export type PreviewProviderUsage = {
  provider: UsageProvider;
  sessionCount: number;
  unresolvedCount: number;
  /** Complete total only when every selected session for this provider resolved. */
  tokens: PreviewTokens | null;
  /** Sum of resolved sessions only; unknown reasoning stays null. */
  knownTokens: PreviewTokens;
};

export type PreviewTokens = { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number | null };

export type PreviewRoleUsage = {
  sessionCount: number;
  resolvedCount: number;
  dispatchCount: number | null;
  byProvider: PreviewProviderUsage[];
  knownCostUsd: number;
  unknownCostSessionCount: number;
  /** null whenever any selected session in this role has unknown cost. */
  costUsd: number | null;
};

export type PreviewRatio = { value: number | null; unknownReason: string | null };

export type OverheadPreview = {
  kind: 'overhead-preview';
  mode: 'manual_preview';
  persisted: false;
  hostId: string;
  hostIdentity: 'unverified_endpoint';
  runId: string;
  status: 'preview' | 'partial';
  coverage: 'unknown';
  orca: {
    complete: boolean;
    counts: { tasks: number; dispatches: number; workers: number; pagesRead: number };
    errors: Array<{ source: string; code: string }>;
  };
  agentTop: Record<UsageProvider, { status: 'ok' | 'error' | 'not_requested'; errorCode: string | null; sessionRows: number | null }>;
  counts: { entries: number; resolved: number; unresolved: number };
  entries: PreviewEntry[];
  coordinator: PreviewRoleUsage;
  workers: PreviewRoleUsage;
  selectedOverheadShare: PreviewRatio;
  runWideOverheadShare: PreviewRatio;
  runWideOverheadPerWorkerCost: PreviewRatio;
  warnings: string[];
};

function previewError(code: string, message: string, hint?: string): CliError {
  return new CliError({ code, message, hint, exitCode: EXIT_USAGE });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validId(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ID_LENGTH ||
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)) {
    throw previewError('preview_roles_invalid', `Roles file ${where} must be a 1-${MAX_ID_LENGTH} char string without control characters.`);
  }
  return value;
}

function allowedKeys(obj: Record<string, unknown>, keys: string[], where: string): void {
  for (const key of Object.keys(obj)) {
    if (!keys.includes(key)) {
      throw previewError('preview_roles_invalid', `Roles file ${where} has an unsupported field.`);
    }
  }
}

/**
 * Strict parse of the versioned roles file. Values never echo into errors
 * (only positions), so a malformed file cannot leak its content.
 */
export function parseRolesFile(text: string, selectedRunId: string): RoleEntry[] {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    throw previewError('preview_roles_invalid', 'Roles file is not valid JSON.');
  }
  if (!isPlainObject(root)) {
    throw previewError('preview_roles_invalid', 'Roles file must be a JSON object.');
  }
  allowedKeys(root, ['schemaVersion', 'runId', 'entries'], 'root');
  if (root['schemaVersion'] !== ROLES_SCHEMA_VERSION) {
    throw previewError('preview_roles_invalid', `Roles file schemaVersion must be ${ROLES_SCHEMA_VERSION}.`);
  }
  const runId = validId(root['runId'], 'runId');
  if (runId !== selectedRunId) {
    throw previewError('preview_roles_run_mismatch', 'Roles file runId does not match --run.');
  }
  const rows = root['entries'];
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > MAX_ROLE_ENTRIES) {
    throw previewError('preview_roles_invalid', `Roles file entries must be an array of 1-${MAX_ROLE_ENTRIES} items.`);
  }
  const entries: RoleEntry[] = [];
  const seen = new Set<string>();
  rows.forEach((row, index) => {
    const where = `entries[${index}]`;
    if (!isPlainObject(row)) {
      throw previewError('preview_roles_invalid', `Roles file ${where} must be an object.`);
    }
    allowedKeys(row, ['role', 'provider', 'sessionId', 'dispatchId'], where);
    const role = row['role'];
    if (role !== 'coordinator' && role !== 'worker') {
      throw previewError('preview_roles_invalid', `Roles file ${where}.role must be coordinator or worker.`);
    }
    const provider = row['provider'];
    if (!(USAGE_PROVIDERS as readonly unknown[]).includes(provider)) {
      throw previewError('preview_roles_invalid', `Roles file ${where}.provider must be claude, codex, or cursor.`);
    }
    const sessionId = validId(row['sessionId'], `${where}.sessionId`);
    let dispatchId: string | null = null;
    if (role === 'worker') {
      dispatchId = validId(row['dispatchId'], `${where}.dispatchId`);
    } else if (row['dispatchId'] !== undefined) {
      throw previewError('preview_roles_invalid', `Roles file ${where}.dispatchId is not allowed for coordinator.`);
    }
    // A session has exactly one role: any repeat (even identical) is rejected.
    const key = JSON.stringify([provider, sessionId]);
    if (seen.has(key)) {
      throw previewError('preview_roles_duplicate', `Roles file ${where} repeats a provider/session already mapped.`);
    }
    seen.add(key);
    entries.push({ role, provider: provider as UsageProvider, sessionId, dispatchId });
  });
  return entries;
}

/** Worker mappings must point at a Dispatch that Orca verified inside this Run. */
export function assertEntriesInRun(entries: RoleEntry[], provenance: OrcaRunProvenance): void {
  if (provenance.errors.some((error) => error.source === 'run-show')) {
    throw previewError('preview_run_unverified', 'Orca did not verify the selected Run; refusing to preview.',
      'Check --run and that the Orca runtime serves this Run.');
  }
  const known = new Set(provenance.dispatches.map((dispatch) => dispatch.dispatchId));
  for (const entry of entries) {
    if (entry.dispatchId !== null && !known.has(entry.dispatchId)) {
      throw previewError('preview_dispatch_not_in_run',
        'A worker mapping points at a Dispatch not verified in this Run.',
        'Fix the roles file; mappings are never guessed or reassigned.');
    }
  }
}

function emptyTokens() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: null as number | null };
}

function resolveEntry(entry: RoleEntry, entryIndex: number, source: ProviderSource | undefined): PreviewEntry {
  const base = {
    entryIndex, role: entry.role, provider: entry.provider, dispatchId: entry.dispatchId,
    verification: 'operator_supplied_unverified' as const,
  };
  const unresolved = (status: PreviewEntryStatus): PreviewEntry => ({
    ...base, status, tokens: null, tokenAllocation: null, costUsd: null, costKind: 'unknown',
  });
  if (!source || source.status === 'error') return unresolved('source_error');
  const matches = source.sessions.filter((row) => row.session.rawId === entry.sessionId);
  if (matches.length > 1) {
    throw previewError('preview_session_ambiguous', 'agent-top returned the same session ID more than once.');
  }
  const match = matches[0];
  if (!match) return unresolved('session_not_found');
  const tokens = match.snapshot.tokens;
  const known = match.snapshot.cost.kind === 'estimated_api_equivalent' && match.snapshot.cost.amountUsd !== null;
  const allocation = 'tokenAllocation' in match.metadata && match.metadata.tokenAllocation !== undefined
    ? match.metadata.tokenAllocation
    : (match.metadata.models !== null && match.metadata.models.length > 1 ? 'unknown' : 'known');
  return {
    ...base, status: 'resolved',
    tokens: {
      input: tokens.input, output: tokens.output, cacheRead: tokens.cacheRead, cacheWrite: tokens.cacheWrite,
      reasoning: tokens.provider === 'codex' ? tokens.reasoning : null,
    },
    tokenAllocation: allocation,
    costUsd: known ? match.snapshot.cost.amountUsd : null,
    costKind: known ? 'estimated_api_equivalent' : 'unknown',
  };
}

function rollup(entries: PreviewEntry[], role: PreviewRole): PreviewRoleUsage {
  const scoped = entries.filter((entry) => entry.role === role);
  let knownCostUsd = 0;
  let unknown = 0;
  for (const entry of scoped) {
    if (entry.costUsd === null) unknown += 1;
    else knownCostUsd += entry.costUsd;
  }
  const byProvider: PreviewProviderUsage[] = [];
  for (const provider of USAGE_PROVIDERS) {
    const rows = scoped.filter((entry) => entry.provider === provider);
    if (rows.length === 0) continue;
    const resolved = rows.filter((entry) => entry.tokens !== null);
    const knownTokens = emptyTokens();
    for (const row of resolved) {
      knownTokens.input += row.tokens!.input;
      knownTokens.output += row.tokens!.output;
      knownTokens.cacheRead += row.tokens!.cacheRead;
      knownTokens.cacheWrite += row.tokens!.cacheWrite;
    }
    // Reasoning is known only when every resolved session reports it.
    knownTokens.reasoning = resolved.length > 0 && resolved.every((row) => row.tokens!.reasoning !== null)
      ? resolved.reduce((sum, row) => sum + row.tokens!.reasoning!, 0) : null;
    for (const value of [knownTokens.input, knownTokens.output, knownTokens.cacheRead, knownTokens.cacheWrite, knownTokens.reasoning]) {
      if (value === null) continue;
      if (!Number.isSafeInteger(value)) {
        throw previewError('preview_aggregate_overflow', 'Token aggregate exceeded the safe integer range.');
      }
    }
    byProvider.push({ provider, sessionCount: rows.length, unresolvedCount: rows.length - resolved.length,
      tokens: resolved.length === rows.length ? knownTokens : null, knownTokens });
  }
  const dispatches = new Set(scoped.map((entry) => entry.dispatchId).filter((id): id is string => id !== null));
  return {
    sessionCount: scoped.length,
    resolvedCount: scoped.filter((entry) => entry.status === 'resolved').length,
    dispatchCount: role === 'worker' ? dispatches.size : null,
    byProvider,
    knownCostUsd,
    unknownCostSessionCount: unknown,
    costUsd: unknown === 0 && scoped.length > 0 ? knownCostUsd : null,
  };
}

function selectedShare(coordinator: PreviewRoleUsage, workers: PreviewRoleUsage): PreviewRatio {
  if (coordinator.sessionCount === 0 || workers.sessionCount === 0) {
    return { value: null, unknownReason: 'missing_role' };
  }
  if (coordinator.costUsd === null || workers.costUsd === null) {
    return { value: null, unknownReason: 'unknown_cost' };
  }
  const denom = coordinator.costUsd + workers.costUsd;
  if (!Number.isFinite(denom) || denom === 0) return { value: null, unknownReason: 'zero_denominator' };
  return { value: coordinator.costUsd / denom, unknownReason: null };
}

export function buildOverheadPreview(input: {
  hostId: string;
  runId: string;
  entries: RoleEntry[];
  provenance: OrcaRunProvenance;
  providers: Partial<Record<UsageProvider, ProviderSource>>;
}): OverheadPreview {
  const { provenance, providers } = input;
  if (provenance.runId !== input.runId) {
    throw previewError('preview_run_unverified', 'Orca did not verify the selected Run; refusing to preview.');
  }
  assertEntriesInRun(input.entries, provenance);
  const entries = input.entries.map((entry, index) => resolveEntry(entry, index, providers[entry.provider]));
  const coordinator = rollup(entries, 'coordinator');
  const workers = rollup(entries, 'worker');
  const resolved = entries.filter((entry) => entry.status === 'resolved').length;

  const agentTop = {} as OverheadPreview['agentTop'];
  for (const provider of USAGE_PROVIDERS) {
    const source = providers[provider];
    agentTop[provider] = !source
      ? { status: 'not_requested', errorCode: null, sessionRows: null }
      : source.status === 'ok'
        ? { status: 'ok', errorCode: null, sessionRows: source.sessions.length }
        : { status: 'error', errorCode: source.errorCode, sessionRows: null };
  }
  const partial = !provenance.complete || resolved < entries.length ||
    USAGE_PROVIDERS.some((provider) => agentTop[provider].status === 'error');

  const warnings = [
    'Preview only: role mappings are operator-supplied and unverified by Orca/agent-top; nothing is persisted.',
    'Coverage is unknown: sessions outside the roles file are not counted; Run-wide ratios are null.',
    'Cost is estimated API equivalent, never actual billing or Orca runtime cost.',
    'hostId "local" is an unverified endpoint label (AC3 durable endpoint identity is not established).',
  ];
  if (!provenance.complete) {
    warnings.push('Orca Run provenance is incomplete; other Tasks/Dispatches may be missing.');
  }
  if (resolved < entries.length) {
    warnings.push('Some mapped sessions are unresolved; their tokens and cost are unknown, not zero.');
  }
  if (entries.some((entry) => entry.tokenAllocation === 'unknown')) {
    warnings.push('Some sessions used multiple models; per-model token allocation is unknown.');
  }

  return {
    kind: 'overhead-preview',
    mode: 'manual_preview',
    persisted: false,
    hostId: input.hostId,
    hostIdentity: 'unverified_endpoint',
    runId: input.runId,
    status: partial ? 'partial' : 'preview',
    coverage: 'unknown',
    orca: {
      complete: provenance.complete,
      counts: {
        tasks: provenance.tasks.length, dispatches: provenance.dispatches.length,
        workers: provenance.workers.length, pagesRead: provenance.pagesRead,
      },
      errors: provenance.errors.map((error) => ({ source: error.source, code: error.code })),
    },
    agentTop,
    counts: { entries: entries.length, resolved, unresolved: entries.length - resolved },
    entries,
    coordinator,
    workers,
    selectedOverheadShare: selectedShare(coordinator, workers),
    runWideOverheadShare: { value: null, unknownReason: 'coverage_unknown' },
    runWideOverheadPerWorkerCost: { value: null, unknownReason: 'coverage_unknown' },
    warnings,
  };
}

function formatRoleUsage(label: string, usage: PreviewRoleUsage): string[] {
  const lines = [
    `  ${label}: sessions=${usage.sessionCount} resolved=${usage.resolvedCount}` +
      (usage.dispatchCount === null ? '' : ` dispatches=${usage.dispatchCount}`) +
      ` cost=${formatUsd(usage.costUsd)} (known=${formatUsd(usage.knownCostUsd)}, unknownCostSessions=${usage.unknownCostSessionCount})`,
  ];
  for (const p of usage.byProvider) {
    const tokens = p.tokens;
    const total = tokens === null ? 'tokens=unknown' :
      `in=${tokens.input} out=${tokens.output} cacheR=${tokens.cacheRead} cacheW=${tokens.cacheWrite} reasoning=${tokens.reasoning ?? 'unknown'}`;
    const known = p.knownTokens;
    lines.push(`    ${p.provider}: sessions=${p.sessionCount} unresolved=${p.unresolvedCount} ${total}` +
      (tokens === null ? ` (known: in=${known.input} out=${known.output} cacheR=${known.cacheRead} cacheW=${known.cacheWrite} reasoning=${known.reasoning ?? 'unknown'})` : ''));
  }
  return lines;
}

function formatRatio(ratio: PreviewRatio): string {
  return ratio.value === null ? `unknown (${ratio.unknownReason})` : ratio.value.toFixed(4);
}

export function formatOverheadPreviewText(report: OverheadPreview): string {
  const lines = [
    `Overhead PREVIEW (manual, not persisted) — host ${sanitizeDisplayText(report.hostId)} (unverified endpoint) / run ${sanitizeDisplayText(report.runId)}`,
    `Status: ${report.status}; coverage=${report.coverage}`,
    `Orca: complete=${report.orca.complete} tasks=${report.orca.counts.tasks} dispatches=${report.orca.counts.dispatches} ` +
      `workers=${report.orca.counts.workers} pages=${report.orca.counts.pagesRead} ` +
      `errors=${report.orca.errors.length === 0 ? 'none' : report.orca.errors.map((e) => `${e.source}:${e.code}`).join(',')}`,
  ];
  for (const provider of USAGE_PROVIDERS) {
    const source = report.agentTop[provider];
    lines.push(`agent-top ${provider}: ${source.status}` +
      (source.errorCode ? ` (${source.errorCode})` : '') +
      (source.sessionRows === null ? '' : ` rows=${source.sessionRows}`));
  }
  lines.push(`Entries: ${report.counts.entries} resolved=${report.counts.resolved} unresolved=${report.counts.unresolved}`, '');
  lines.push(...formatRoleUsage('Coordinator (selected)', report.coordinator));
  lines.push(...formatRoleUsage('Workers (selected)', report.workers));
  lines.push('', `selectedOverheadShare: ${formatRatio(report.selectedOverheadShare)}`);
  lines.push(`runWideOverheadShare: ${formatRatio(report.runWideOverheadShare)}`);
  lines.push(`runWideOverheadPerWorkerCost: ${formatRatio(report.runWideOverheadPerWorkerCost)}`);
  lines.push('Warnings:');
  for (const warning of report.warnings) lines.push(`  ${sanitizeDisplayText(warning)}`);
  return `${lines.join('\n')}\n`;
}
