import { CliError, EXIT_SOURCE_UNAVAILABLE } from '../errors.js';

export type OrcaManualWorktreeRecord = {
  source: 'manual';
  hostId: string;
  worktreeId: string;
  repoId: string | null;
  path: string | null;
  issueRefHint: string | null;
};

function schemaError(path: string, detail: string): CliError {
  return new CliError({
    code: 'orca_schema_drift',
    message: `Orca worktree JSON invalid at ${path}: ${detail}`,
    exitCode: EXIT_SOURCE_UNAVAILABLE,
  });
}

function asNullableString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  return null;
}

function issueRefHintFromLinked(linked: unknown): string | null {
  if (linked === null || linked === undefined) {
    return null;
  }
  if (typeof linked === 'string' && linked.length > 0) {
    return linked;
  }
  if (typeof linked === 'object') {
    const url = (linked as Record<string, unknown>)['url'];
    if (typeof url === 'string' && url.length > 0) {
      return url;
    }
    const number = (linked as Record<string, unknown>)['number'];
    if (typeof number === 'number') {
      return String(number);
    }
  }
  return null;
}

/**
 * Parse `orca worktree show --json` for a manual (non-orchestrated) worktree.
 */
export function parseWorktreeShowJson(text: string): OrcaManualWorktreeRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw schemaError('root', 'invalid JSON');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw schemaError('root', 'expected object');
  }
  const result = (parsed as Record<string, unknown>)['result'];
  if (!result || typeof result !== 'object') {
    throw schemaError('result', 'missing result');
  }
  const worktree = (result as Record<string, unknown>)['worktree'];
  if (!worktree || typeof worktree !== 'object') {
    throw schemaError('result.worktree', 'missing worktree');
  }
  const wt = worktree as Record<string, unknown>;
  const worktreeId = asNullableString(wt['id']);
  const hostId = asNullableString(wt['hostId']);
  if (!worktreeId) {
    throw schemaError('result.worktree.id', 'missing worktree id');
  }
  if (!hostId) {
    throw schemaError('result.worktree.hostId', 'missing hostId');
  }
  return {
    source: 'manual',
    hostId,
    worktreeId,
    repoId: asNullableString(wt['repoId']),
    path: asNullableString(wt['path']),
    issueRefHint: issueRefHintFromLinked(wt['linkedIssue']),
  };
}

/**
 * Parse one `orca worktree ps --json` row when no supervised agents are attached.
 */
export function parseWorktreePsRowJson(text: string): OrcaManualWorktreeRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw schemaError('root', 'invalid JSON');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw schemaError('root', 'expected object');
  }
  const row = (parsed as Record<string, unknown>)['row'];
  if (!row || typeof row !== 'object') {
    throw schemaError('row', 'missing row');
  }
  const rec = row as Record<string, unknown>;
  const worktreeId = asNullableString(rec['worktreeId']);
  const hostId = asNullableString(rec['hostId']);
  if (!worktreeId || !hostId) {
    throw schemaError('row.worktreeId', 'missing worktreeId or hostId');
  }
  return {
    source: 'manual',
    hostId,
    worktreeId,
    repoId: asNullableString(rec['repoId']),
    path: asNullableString(rec['path']),
    issueRefHint: issueRefHintFromLinked(rec['linkedIssue']),
  };
}

/**
 * Parse `orca worktree list --json` rows (may be empty).
 */
export function parseWorktreeListJson(text: string): OrcaManualWorktreeRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw schemaError('root', 'invalid JSON');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw schemaError('root', 'expected object');
  }
  const result = (parsed as Record<string, unknown>)['result'];
  if (!result || typeof result !== 'object') {
    throw schemaError('result', 'missing result');
  }
  const worktrees = (result as Record<string, unknown>)['worktrees'];
  if (worktrees === undefined) {
    throw schemaError('result.worktrees', 'missing worktrees array');
  }
  if (!Array.isArray(worktrees)) {
    throw schemaError('result.worktrees', 'expected array');
  }
  const out: OrcaManualWorktreeRecord[] = [];
  for (let i = 0; i < worktrees.length; i += 1) {
    const wt = worktrees[i];
    if (!wt || typeof wt !== 'object') {
      throw schemaError(`result.worktrees[${i}]`, 'expected object');
    }
    const rec = wt as Record<string, unknown>;
    const worktreeId = asNullableString(rec['id']);
    const hostId = asNullableString(rec['hostId']);
    if (!worktreeId) {
      throw schemaError(`result.worktrees[${i}].id`, 'missing worktree id');
    }
    if (!hostId) {
      throw schemaError(`result.worktrees[${i}].hostId`, 'missing hostId');
    }
    out.push({
      source: 'manual',
      hostId,
      worktreeId,
      repoId: asNullableString(rec['repoId']),
      path: asNullableString(rec['path']),
      issueRefHint: issueRefHintFromLinked(rec['linkedIssue']),
    });
  }
  return out;
}
