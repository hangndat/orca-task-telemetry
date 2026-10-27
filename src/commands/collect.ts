import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config.js';
import {
  parseSessionsJsonArray,
  readAgentTopVersion,
  invokeAgentTop,
  AGENT_TOP_VERIFIED_VERSION,
  COUNTED_SESSIONS_QUERY,
} from '../usage/adapter.js';
import { parseCountedSessions } from '../usage/sessions.js';
import type { ClaudeTokenAllocation } from '../usage/sessions.js';
import {
  CliError,
  EXIT_PARTIAL,
  EXIT_SOURCE_UNAVAILABLE,
  EXIT_SUCCESS,
  usageError,
} from '../errors.js';
import { normalizeProjectMemberships } from '../github/memberships.js';
import { readProjectItems } from '../github/items.js';
import { openTelemetryDatabase } from '../db/index.js';
import {
  finishAgentTopCollectionAttempt,
  finishOrcaCollectionAttempt,
  insertCollectionAttempt,
  persistOrcaRunProvenance,
  type CollectionErrorCode,
} from '../db/run-provenance.js';
import { collectOrcaRunProvenance } from '../orca/run-provenance.js';
import {
  assertLocalHostListRow,
  resolveLocalSourceHostIdentity,
} from '../orca/source-host.js';
import {
  countRows,
  importUsageSnapshots,
  importGitHubRecords,
  importOrcaExecutions,
  sanitizeCollectionMessage,
  type UsageImportRow,
} from '../db/repository.js';
import {
  assertRuntimeReachable,
  invokeOrcaReadOnly,
  readOrcaVersion,
} from '../orca/adapter.js';
import { collectSupervisedRecords } from '../orca/enumerate.js';
import { normalizeSupervisedRecords } from '../orca/normalize.js';
import { getProfile } from '../profiles.js';
import { createDefaultPathEnv, resolveAppPaths } from '../paths.js';
import { resolveRepository } from '../repo.js';
import type { RouteResult } from './router.js';

export type CollectSourceName = 'github' | 'orca' | 'agent-top';

export type CollectSourceResult = {
  source: CollectSourceName;
  status: 'ok' | 'error' | 'partial';
  counts?: Record<string, number>;
  /** Present when an Orca Run was persisted under a verified storage host id. */
  hostId?: string;
  error?: { code: string; message: string };
};

export type CollectPayload = {
  sources: CollectSourceResult[];
  exitCode: number;
  counts: {
    issues: number;
    sessions: number;
    executions: number;
    collectionLogs: number;
  };
};

function canonicalPath(targetPath: string): string {
  try {
    return fs.realpathSync(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

function pathsInsideGitRoot(gitRoot: string, targetPath: string): boolean {
  const root = canonicalPath(gitRoot);
  const target = canonicalPath(targetPath);
  const rel = path.relative(root, target);
  return rel.length === 0 || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function assertStorageOutsideRepo(gitRoot: string, appHome: string, dbPath: string): void {
  if (pathsInsideGitRoot(gitRoot, appHome) || pathsInsideGitRoot(gitRoot, dbPath)) {
    throw new CliError({
      code: 'paths_error',
      message: 'Telemetry data directory must not be inside the target git repository.',
      hint: 'Set ORCA_TELEMETRY_HOME to a directory outside the repository.',
      exitCode: EXIT_SOURCE_UNAVAILABLE,
    });
  }
}

function mapSourceError(err: unknown): { code: string; message: string } {
  if (err instanceof CliError) {
    return {
      code: err.code,
      message: sanitizeCollectionMessage(err.message),
    };
  }
  const message =
    err instanceof Error ? sanitizeCollectionMessage(err.message) : 'Collect failed.';
  return { code: 'collect_source_error', message };
}

function tokenAllocationForModels(
  models: string[] | null,
): ClaudeTokenAllocation | null {
  if (models === null) {
    return null;
  }
  return models.length > 1 ? 'unknown' : 'known';
}

function toImportRow(
  parsed: {
    session: UsageImportRow['session'];
    snapshot: UsageImportRow['snapshot'];
    metadata: {
      models: string[] | null;
      projectHint: string | null;
      tokenAllocation?: ClaudeTokenAllocation | null;
    };
  },
): UsageImportRow {
  const models = parsed.metadata.models;
  const allocation =
    parsed.metadata.tokenAllocation ??
    tokenAllocationForModels(models);
  return {
    session: parsed.session,
    snapshot: parsed.snapshot,
    models,
    tokenAllocation: allocation,
    projectHint: parsed.metadata.projectHint,
  };
}

async function collectGithub(
  projectId: string,
  db: import('node:sqlite').DatabaseSync,
): Promise<CollectSourceResult> {
  try {
    const items = await readProjectItems(projectId);
    const normalized = normalizeProjectMemberships(items);
    importGitHubRecords(db, {
      projectId,
      issues: normalized.issues,
      memberships: normalized.memberships,
    });
    return {
      source: 'github',
      status: 'ok',
      counts: {
        issues: normalized.issues.length,
        memberships: normalized.memberships.length,
        excluded: normalized.excluded.length,
      },
    };
  } catch (err) {
    return { source: 'github', status: 'error', error: mapSourceError(err) };
  }
}

async function collectOrca(
  db: import('node:sqlite').DatabaseSync,
): Promise<CollectSourceResult> {
  try {
    await readOrcaVersion();
    const statusResult = await invokeOrcaReadOnly(['status', '--json']);
    if (statusResult.exitCode !== 0) {
      throw new CliError({
        code: 'orca_runtime_unavailable',
        message: 'Orca status failed.',
        exitCode: EXIT_SOURCE_UNAVAILABLE,
      });
    }
    const statusJson = JSON.parse(statusResult.stdout) as unknown;
    assertRuntimeReachable(statusJson);

    const supervised = await collectSupervisedRecords();
    const executions = normalizeSupervisedRecords(supervised).map((e) => ({
      executionKey: e.executionKey,
      hostId: e.hostId,
      rawId: e.rawId,
      runId: e.runId,
      taskId: e.taskId,
      dispatchId: e.dispatchId,
    }));
    importOrcaExecutions(db, executions);
    return {
      source: 'orca',
      status: 'ok',
      counts: { executions: executions.length },
    };
  } catch (err) {
    return { source: 'orca', status: 'error', error: mapSourceError(err) };
  }
}

async function collectAgentTop(
  db: import('node:sqlite').DatabaseSync,
  observedAt: string,
  now: () => string,
): Promise<CollectSourceResult> {
  const providers = ['claude', 'codex'] as const;
  const attempts = new Map<(typeof providers)[number], number | bigint>();
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const provider of providers) {
      attempts.set(provider, insertCollectionAttempt(db, {
        source: 'agent-top', provider, startedAt: now(), status: 'running',
      }));
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  function errorCode(err: unknown, phase: 'source' | 'import'): CollectionErrorCode {
    if (phase === 'import') return 'storage_error';
    if (err instanceof CliError) {
      if (err.code === 'agent_top_version_unsupported') return 'source_version_unsupported';
      if (err.code === 'agent_top_schema_drift') return 'source_invalid_json';
      if (err.code === 'agent_top_runtime_unavailable') return 'source_unavailable';
    }
    return 'source_error';
  }

  let version: string;
  let rows: UsageImportRow[];
  try {
    version = await readAgentTopVersion();
    if (version !== AGENT_TOP_VERIFIED_VERSION) {
      throw new CliError({
        code: 'agent_top_version_unsupported',
        message: `Unexpected agent-top version ${version}.`,
        exitCode: EXIT_SOURCE_UNAVAILABLE,
      });
    }
    const result = await invokeAgentTop(['sql', '--json', COUNTED_SESSIONS_QUERY]);
    if (result.exitCode !== 0) {
      throw new CliError({
        code: 'agent_top_runtime_unavailable',
        message: 'agent-top sql counted_sessions failed.',
        exitCode: EXIT_SOURCE_UNAVAILABLE,
      });
    }
    if (result.stdout.trim().length === 0) {
      throw new CliError({
        code: 'agent_top_schema_drift',
        message: 'agent-top sql returned empty stdout.',
        exitCode: EXIT_SOURCE_UNAVAILABLE,
      });
    }
    const array = parseSessionsJsonArray(result.stdout);
    rows = parseCountedSessions(array, observedAt, version).map(
      (parsed) =>
        toImportRow({
          ...parsed,
          metadata: {
            models: parsed.metadata.models,
            projectHint: parsed.metadata.projectHint,
            tokenAllocation: parsed.metadata.tokenAllocation,
          },
        }),
    );
  } catch (err) {
    for (const provider of providers) {
      finishAgentTopCollectionAttempt(db, {
        attemptId: attempts.get(provider)!, provider, completedAt: now(),
        status: 'failed', errorCode: errorCode(err, 'source'),
      });
    }
    return { source: 'agent-top', status: 'error', error: mapSourceError(err) };
  }

  try {
    importUsageSnapshots(db, rows);
  } catch (err) {
    for (const provider of providers) {
      finishAgentTopCollectionAttempt(db, {
        attemptId: attempts.get(provider)!, provider, completedAt: now(),
        status: 'failed', errorCode: errorCode(err, 'import'),
      });
    }
    return { source: 'agent-top', status: 'error', error: mapSourceError(err) };
  }

  for (const provider of providers) {
    const providerRows = rows.filter((row) => row.session.provider === provider);
    finishAgentTopCollectionAttempt(db, {
      attemptId: attempts.get(provider)!, provider, completedAt: now(),
      status: 'success',
      counters: { sessions: providerRows.length },
    });
  }
  return {
    source: 'agent-top',
    status: 'ok',
    counts: { sessions: rows.length },
  };
}

async function collectOrcaRun(
  db: import('node:sqlite').DatabaseSync,
  runId: string,
  now: () => string,
): Promise<CollectSourceResult> {
  let counters = { runs: 0, tasks: 0, dispatches: 0, workers: 0, pages: 0 };
  let attemptId: number | bigint | null = null;
  let storageHostId: string | null = null;
  try {
    const version = await readOrcaVersion();
    const statusResult = await invokeOrcaReadOnly(['status', '--json']);
    if (statusResult.exitCode !== 0) throw new Error('Orca status failed.');
    let statusJson: unknown;
    try {
      statusJson = JSON.parse(statusResult.stdout) as unknown;
    } catch {
      throw new Error('Orca status returned invalid JSON.');
    }
    assertRuntimeReachable(statusJson);
    const identity = resolveLocalSourceHostIdentity(statusJson);
    if ('code' in identity) {
      insertCollectionAttempt(db, {
        source: 'orca', runId, startedAt: now(), completedAt: now(),
        status: 'partial', errorCode: 'source_error',
      });
      return {
        source: 'orca', status: 'partial', counts: counters,
        error: { code: identity.code, message: identity.message },
      };
    }
    storageHostId = identity.storageHostId;
    attemptId = insertCollectionAttempt(db, {
      source: 'orca', hostId: storageHostId, runId,
      startedAt: now(), status: 'running',
    });

    const hostListResult = await invokeOrcaReadOnly(['host', 'list', '--json']);
    if (hostListResult.exitCode !== 0) {
      throw new Error('Orca host list failed.');
    }
    let hostListJson: unknown;
    try {
      hostListJson = JSON.parse(hostListResult.stdout) as unknown;
    } catch {
      throw new Error('Orca host list returned invalid JSON.');
    }
    const hostListFailure = assertLocalHostListRow(hostListJson);
    if (hostListFailure) {
      finishOrcaCollectionAttempt(db, {
        attemptId, completedAt: now(), status: 'partial', errorCode: 'source_error',
        counters,
      });
      return {
        source: 'orca', status: 'partial', counts: counters,
        error: { code: hostListFailure.code, message: hostListFailure.message },
      };
    }

    const provenance = await collectOrcaRunProvenance(runId, {
      sourceHostId: identity.orcaHostLabel,
      expectedRuntimeId: identity.runtimeId,
      readVersion: async () => version,
    });
    counters = {
      runs: provenance.complete ? 1 : 0,
      tasks: provenance.tasks.length,
      dispatches: provenance.dispatches.length,
      workers: provenance.workers.length,
      pages: provenance.pagesRead,
    };
    if (!provenance.complete) {
      const errorCode = provenance.errors.some((e) => e.code.endsWith('_limit') ||
        e.code === 'unprovable_completeness' || e.code === 'cursor_loop')
        ? 'collection_limit' : 'source_error';
      finishOrcaCollectionAttempt(db, {
        attemptId, completedAt: now(), status: 'partial', errorCode, counters,
      });
      return {
        source: 'orca', status: 'partial', counts: counters,
        error: { code: errorCode, message: 'Orca Run provenance is incomplete.' },
      };
    }

    persistOrcaRunProvenance(db, {
      hostId: storageHostId,
      runId,
      observedAt: now(),
      sourceVersion: version,
      tasks: provenance.tasks,
      dispatches: provenance.dispatches,
    });
    finishOrcaCollectionAttempt(db, {
      attemptId, completedAt: now(), status: 'success', counters,
    });
    return {
      source: 'orca',
      status: 'ok',
      hostId: storageHostId,
      counts: counters,
    };
  } catch (err) {
    if (attemptId !== null) {
      try {
        finishOrcaCollectionAttempt(db, {
          attemptId, completedAt: now(), status: 'partial',
          errorCode: 'source_error', counters,
        });
      } catch {
        // Attempt may already be finished; surface the original error.
      }
    } else if (storageHostId === null) {
      try {
        insertCollectionAttempt(db, {
          source: 'orca', runId, startedAt: now(), completedAt: now(),
          status: 'partial', errorCode: 'source_error',
        });
      } catch {
        // Best-effort journal.
      }
    }
    return { source: 'orca', status: 'partial', error: mapSourceError(err), counts: counters };
  }
}

function computeExitCode(sources: CollectSourceResult[]): number {
  const errors = sources.filter((s) => s.status === 'error').length;
  if (sources.some((source) => source.status === 'partial')) return EXIT_PARTIAL;
  if (errors === 0) {
    return EXIT_SUCCESS;
  }
  if (errors === sources.length) {
    return EXIT_SOURCE_UNAVAILABLE;
  }
  return EXIT_PARTIAL;
}

export type RunCollectOptions = {
  cwd: string;
  now?: () => string;
  runId?: string;
};

export async function runCollectCommand(
  options: RunCollectOptions,
): Promise<CollectPayload> {
  const pathEnv = createDefaultPathEnv();
  const paths = resolveAppPaths(pathEnv);
  const resolved = await resolveRepository(options.cwd);
  assertStorageOutsideRepo(resolved.gitRoot, paths.appHome, paths.dbPath);

  const config = loadConfig(paths.appHome);
  const profile = getProfile(config, resolved.github.id);

  const handle = openTelemetryDatabase({
    dbPath: paths.dbPath,
    gitRoot: resolved.gitRoot,
  });
  const observedAt = (options.now ?? (() => new Date().toISOString()))();

  try {
    const now = options.now ?? (() => new Date().toISOString());
    const sources: CollectSourceResult[] = [];
    sources.push(await collectGithub(profile.project.id, handle.db));
    sources.push(options.runId === undefined
      ? await collectOrca(handle.db)
      : await collectOrcaRun(handle.db, options.runId, now));
    sources.push(await collectAgentTop(handle.db, observedAt, now));

    const exitCode = computeExitCode(sources);
    const counts = {
      issues: countRows(handle.db, 'issues'),
      sessions: countRows(handle.db, 'usage_sessions'),
      executions: countRows(handle.db, 'executions'),
      collectionLogs: countRows(handle.db, 'collection_logs'),
    };
    return { sources, exitCode, counts };
  } finally {
    handle.close();
  }
}

export async function runCollect(
  rest: string[],
  options: { json: boolean; cwd: string },
): Promise<RouteResult> {
  let runId: string | undefined;
  if (rest.length > 0) {
    if (rest.length !== 2 || rest[0] !== '--run' || !rest[1] || rest[1].startsWith('-')) {
      throw usageError('Expected --run <run-id>.', 'Usage: orca-telemetry collect [--run <run-id>] [--json]');
    }
    runId = rest[1];
  }
  const payload = await runCollectCommand({ cwd: options.cwd, runId });
  const data = {
    sources: payload.sources,
    database: payload.counts,
  };

  if (options.json) {
    return { kind: 'ok', data, exitCode: payload.exitCode };
  }
  const lines = ['Collect finished.'];
  for (const source of payload.sources) {
    if (source.status === 'ok') {
      lines.push(
        `${source.source}: ok${source.counts ? ` (${JSON.stringify(source.counts)})` : ''}`,
      );
    } else {
      lines.push(
        `${source.source}: ${source.status} ${source.error?.code ?? ''} — ${source.error?.message ?? ''}`,
      );
    }
  }
  lines.push(`exit: ${payload.exitCode}`);
  return {
    kind: 'text',
    exitCode: payload.exitCode,
    write: () => {
      process.stdout.write(`${lines.join('\n')}\n`);
    },
  };
}
