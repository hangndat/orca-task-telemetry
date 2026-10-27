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
} from '../errors.js';
import { normalizeProjectMemberships } from '../github/memberships.js';
import { readProjectItems } from '../github/items.js';
import { openTelemetryDatabase } from '../db/index.js';
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
  status: 'ok' | 'error';
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
): Promise<CollectSourceResult> {
  try {
    const version = await readAgentTopVersion();
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
    const array = parseSessionsJsonArray(result.stdout);
    const rows: UsageImportRow[] = parseCountedSessions(array, observedAt, version).map(
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
    importUsageSnapshots(db, rows);
    return {
      source: 'agent-top',
      status: 'ok',
      counts: { sessions: rows.length },
    };
  } catch (err) {
    return { source: 'agent-top', status: 'error', error: mapSourceError(err) };
  }
}

function computeExitCode(sources: CollectSourceResult[]): number {
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
  sources.push(await collectOrca(handle.db));
  sources.push(await collectAgentTop(handle.db, observedAt));

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
  _rest: string[],
  options: { json: boolean; cwd: string },
): Promise<RouteResult> {
  const payload = await runCollectCommand({ cwd: options.cwd });
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
        `${source.source}: error ${source.error?.code ?? ''} — ${source.error?.message ?? ''}`,
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
