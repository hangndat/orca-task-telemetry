import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config.js';
import {
  parseSessionsJsonArray,
  readCodeburnVersion,
  invokeCodeburn,
  CODEBURN_VERIFIED_VERSION,
} from '../codeburn/adapter.js';
import { parseClaudeSessions } from '../codeburn/claude.js';
import { parseCodexSessions } from '../codeburn/codex.js';
import type { ClaudeTokenAllocation } from '../codeburn/claude.js';
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
  countRows,
  importCodeBurnUsage,
  importGitHubRecords,
  importOrcaExecutions,
  sanitizeCollectionMessage,
  type CodeBurnImportRow,
} from '../db/repository.js';
import {
  assertRuntimeReachable,
  invokeOrcaReadOnly,
  readOrcaVersion,
} from '../orca/adapter.js';
import { normalizeSupervisedRecords } from '../orca/normalize.js';
import { parseWorkerListJson } from '../orca/workers.js';
import { collectOrcaRunProvenance } from '../orca/run-provenance.js';
import { getProfile } from '../profiles.js';
import { createDefaultPathEnv, resolveAppPaths } from '../paths.js';
import { resolveRepository } from '../repo.js';
import type { RouteResult } from './router.js';

export type CollectSourceName = 'github' | 'orca' | 'codeburn';

export type CollectSourceResult = {
  source: CollectSourceName;
  status: 'ok' | 'error' | 'partial';
  counts?: Record<string, number>;
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
    session: CodeBurnImportRow['session'];
    snapshot: CodeBurnImportRow['snapshot'];
    metadata: {
      models: string[] | null;
      projectHint: string | null;
      tokenAllocation?: ClaudeTokenAllocation | null;
    };
  },
): CodeBurnImportRow {
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

    const runId =
      process.env['ORCA_TELEMETRY_COLLECT_RUN'] ??
      process.env['ORCA_COLLECT_RUN_ID'] ??
      'run_collect_default';
    const workersResult = await invokeOrcaReadOnly([
      'orchestration',
      'worker-list',
      '--json',
      '--run',
      runId,
    ]);
    if (workersResult.exitCode !== 0) {
      throw new CliError({
        code: 'orca_runtime_unavailable',
        message: 'Orca worker-list failed.',
        exitCode: EXIT_SOURCE_UNAVAILABLE,
      });
    }
    const supervised = parseWorkerListJson(workersResult.stdout);
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

async function collectOrcaRun(
  runId: string,
): Promise<CollectSourceResult> {
  // Bounded read only: 1.4.237 has no verified durable source-machine identity.
  // 'local' can match two different endpoints and cannot namespace persisted Runs.
  const sourceHostId = 'local';
  let counters = { runs: 0, tasks: 0, dispatches: 0, workers: 0, pages: 0 };
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
    const root = statusJson as Record<string, unknown>;
    const source = root['result'] as Record<string, unknown>;
    const target = source['target'] as Record<string, unknown> | null;
    if (target?.['kind'] !== 'local') {
      throw new Error('Orca source host is not verified as local.');
    }
    const provenance = await collectOrcaRunProvenance(runId, {
      sourceHostId, readVersion: async () => version,
    });
    counters = { runs: provenance.complete ? 1 : 0,
      tasks: provenance.tasks.length, dispatches: provenance.dispatches.length,
      workers: provenance.workers.length, pages: provenance.pagesRead };
    if (!provenance.complete) {
      const errorCode = provenance.errors.some((e) => e.code.endsWith('_limit') ||
        e.code === 'unprovable_completeness' || e.code === 'cursor_loop')
        ? 'collection_limit' : 'source_error';
      return { source: 'orca', status: 'partial', counts: counters,
        error: { code: errorCode, message: 'Orca Run provenance is incomplete.' } };
    }
    return { source: 'orca', status: 'partial', counts: counters,
      error: { code: 'orca_source_host_unverified',
        message: 'Orca local host has no verified durable source identity.' } };
  } catch (err) {
    return { source: 'orca', status: 'partial', error: mapSourceError(err), counts: counters };
  }
}

async function collectCodeburn(
  db: import('node:sqlite').DatabaseSync,
  observedAt: string,
): Promise<CollectSourceResult> {
  try {
    const version = await readCodeburnVersion();
    if (version !== CODEBURN_VERIFIED_VERSION) {
      throw new CliError({
        code: 'codeburn_version_unsupported',
        message: `Unexpected CodeBurn version ${version}.`,
        exitCode: EXIT_SOURCE_UNAVAILABLE,
      });
    }
    const rows: CodeBurnImportRow[] = [];
    for (const provider of ['claude', 'codex'] as const) {
      const result = await invokeCodeburn([
        'sessions',
        '--provider',
        provider,
        '--period',
        'all',
        '--format',
        'json',
        '--no-pager',
      ]);
      if (result.exitCode !== 0) {
        throw new CliError({
          code: 'codeburn_runtime_unavailable',
          message: `CodeBurn sessions (${provider}) failed.`,
          exitCode: EXIT_SOURCE_UNAVAILABLE,
        });
      }
      const array = parseSessionsJsonArray(result.stdout);
      if (provider === 'claude') {
        for (const parsed of parseClaudeSessions(array, observedAt, version)) {
          rows.push(
            toImportRow({
              ...parsed,
              metadata: {
                models: parsed.metadata.models,
                projectHint: parsed.metadata.projectHint,
                tokenAllocation: parsed.metadata.tokenAllocation,
              },
            }),
          );
        }
      } else {
        for (const parsed of parseCodexSessions(array, observedAt, version)) {
          rows.push(
            toImportRow({
              ...parsed,
              metadata: {
                models: parsed.metadata.models,
                projectHint: parsed.metadata.projectHint,
                tokenAllocation: tokenAllocationForModels(parsed.metadata.models),
              },
            }),
          );
        }
      }
    }
    importCodeBurnUsage(db, rows);
    return {
      source: 'codeburn',
      status: 'ok',
      counts: { sessions: rows.length },
    };
  } catch (err) {
    return { source: 'codeburn', status: 'error', error: mapSourceError(err) };
  }
}

function computeExitCode(sources: CollectSourceResult[]): number {
  if (sources.some((source) => source.status === 'partial')) return EXIT_PARTIAL;
  const errors = sources.filter((s) => s.status === 'error').length;
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

  const sources: CollectSourceResult[] = [];
  sources.push(await collectGithub(profile.project.id, handle.db));
  sources.push(options.runId === undefined
    ? await collectOrca(handle.db)
    : await collectOrcaRun(options.runId));
  sources.push(await collectCodeburn(handle.db, observedAt));

  const exitCode = computeExitCode(sources);
  const counts = {
    issues: countRows(handle.db, 'issues'),
    sessions: countRows(handle.db, 'usage_sessions'),
    executions: countRows(handle.db, 'executions'),
    collectionLogs: countRows(handle.db, 'collection_logs'),
  };
  handle.close();

  return { sources, exitCode, counts };
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
      lines.push(`${source.source}: ${source.status} ${source.error?.code ?? ''} — ${source.error?.message ?? ''}`);
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
