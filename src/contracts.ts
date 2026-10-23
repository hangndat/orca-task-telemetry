/**
 * Normalized contracts for collectors, storage, and reporting (T05).
 * Pure types and functions only — no I/O.
 */

export const USAGE_PROVIDERS = ['claude', 'codex'] as const;
export type UsageProvider = (typeof USAGE_PROVIDERS)[number];

export const USAGE_SOURCES = ['codeburn'] as const;
export type UsageSource = (typeof USAGE_SOURCES)[number];

export const ORCA_EXECUTION_PREFIX = 'orca' as const;

export const PROJECT_ITEM_CONTENT_TYPES = [
  'Issue',
  'PullRequest',
  'DraftIssue',
  'Redacted',
] as const;
export type ProjectItemContentType = (typeof PROJECT_ITEM_CONTENT_TYPES)[number];

export const COST_KINDS = ['estimated_api_equivalent', 'unknown'] as const;
export type CostKind = (typeof COST_KINDS)[number];

export const SESSION_LINK_METHODS = ['manual'] as const;
export type SessionLinkMethod = (typeof SESSION_LINK_METHODS)[number];

/**
 * Claude CodeBurn `subagents[]` rows are separate cumulative sessions; the parent
 * row does not include subagent tokens (discovery: distinct `calls` totals).
 * Emit one {@link UsageSnapshot} per session row under its own {@link sessionKey};
 * never merge subagent metrics into the parent snapshot (avoids double-count).
 */
export const CLAUDE_SUBAGENT_POLICY = 'separate_session_per_row' as const;

export type ClaudeTokenUsage = {
  provider: 'claude';
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

/**
 * Codex sessions JSON has no `reasoningTokens`; use `null` until a verified
 * per-session field exists (audit-only today). Discriminated union keeps
 * provider-specific semantics explicit without inventing shared cache/input merge rules.
 */
export type CodexTokenUsage = {
  provider: 'codex';
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number | null;
};

export type TokenUsage = ClaudeTokenUsage | CodexTokenUsage;

export type Cost = {
  amountUsd: number | null;
  kind: CostKind;
  source: { tool: 'codeburn'; version: string } | null;
};

export type UsageSession = {
  sessionKey: string;
  provider: UsageProvider;
  source: UsageSource;
  rawId: string;
};

/** Cumulative usage for one CodeBurn session at collection time; later collects replace (upsert). */
export type UsageSnapshot = {
  sessionKey: string;
  observedAt: string;
  tokens: TokenUsage;
  cost: Cost;
};

export type GitHubIssue = {
  issueNodeId: string;
  /** GitHub Issue.parent node ID. Undefined means this lookup did not fetch hierarchy. */
  parentIssueNodeId?: string | null;
  repository: { nameWithOwner: string };
  number: number;
  url: string;
  title: string;
  state: string;
};

export type ProjectItem = {
  projectId: string;
  itemId: string;
  contentType: ProjectItemContentType;
  issue: GitHubIssue | null;
};

export type Execution = {
  executionKey: string;
  hostId: string;
  rawId: string;
  runId: string | null;
  taskId: string | null;
  dispatchId: string | null;
};

export type SessionLink = {
  sessionKey: string;
  issueNodeId: string;
  method: SessionLinkMethod;
  linkedAt: string;
  linkedBy: string | null;
};

export class ContractParseError extends Error {
  override name = 'ContractParseError';
}

function assertNonEmptyRawId(rawId: string): void {
  if (rawId.length === 0) {
    throw new ContractParseError('rawId must not be empty');
  }
}

function isUsageProvider(value: string): value is UsageProvider {
  return (USAGE_PROVIDERS as readonly string[]).includes(value);
}

function isUsageSource(value: string): value is UsageSource {
  return (USAGE_SOURCES as readonly string[]).includes(value);
}

/** CodeBurn usage identity: `<provider>:<source>:<rawId>` (MVP source `codeburn`). */
export function sessionKey(
  provider: UsageProvider,
  source: UsageSource,
  rawId: string,
): string {
  assertNonEmptyRawId(rawId);
  return `${provider}:${source}:${rawId}`;
}

export type ParsedSessionKey = {
  provider: UsageProvider;
  source: UsageSource;
  rawId: string;
};

export function parseSessionKey(key: string): ParsedSessionKey {
  const parts = key.split(':');
  if (parts.length !== 3) {
    throw new ContractParseError(
      'sessionKey must have exactly three colon-separated segments',
    );
  }
  const providerPart = parts[0];
  const sourcePart = parts[1];
  const rawId = parts[2];
  if (providerPart === undefined || sourcePart === undefined || rawId === undefined) {
    throw new ContractParseError('sessionKey has empty provider or source segment');
  }
  if (!isUsageProvider(providerPart)) {
    throw new ContractParseError(`unknown usage provider: ${providerPart}`);
  }
  if (!isUsageSource(sourcePart)) {
    throw new ContractParseError(`unknown usage source: ${sourcePart}`);
  }
  assertNonEmptyRawId(rawId);
  return { provider: providerPart, source: sourcePart, rawId };
}

/** Orca execution identity: `orca:<hostId>:<dispatchId|worktreeId>` (rawId may contain `:`). */
export function orcaExecutionKey(hostId: string, rawId: string): string {
  if (hostId.length === 0) {
    throw new ContractParseError('hostId must not be empty');
  }
  assertNonEmptyRawId(rawId);
  return `${ORCA_EXECUTION_PREFIX}:${hostId}:${rawId}`;
}

export type ParsedOrcaExecutionKey = {
  hostId: string;
  rawId: string;
};

export function parseOrcaExecutionKey(key: string): ParsedOrcaExecutionKey {
  if (!key.startsWith(`${ORCA_EXECUTION_PREFIX}:`)) {
    throw new ContractParseError('execution key must start with orca:');
  }
  const withoutPrefix = key.slice(ORCA_EXECUTION_PREFIX.length + 1);
  const colon = withoutPrefix.indexOf(':');
  if (colon <= 0) {
    throw new ContractParseError(
      'execution key must be orca:<hostId>:<rawId>',
    );
  }
  const hostId = withoutPrefix.slice(0, colon);
  const rawId = withoutPrefix.slice(colon + 1);
  assertNonEmptyRawId(rawId);
  return { hostId, rawId };
}

export function usageSessionFromKey(key: string): UsageSession {
  const parsed = parseSessionKey(key);
  return {
    sessionKey: key,
    provider: parsed.provider,
    source: parsed.source,
    rawId: parsed.rawId,
  };
}
