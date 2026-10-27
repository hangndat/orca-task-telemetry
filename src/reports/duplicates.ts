import { CliError, EXIT_ENVIRONMENT } from '../errors.js';
import type { OverheadReportContext } from './overhead.js';
import { sanitizeDisplayText } from './render.js';

export type DuplicateDispatchGroup = {
  taskId: string;
  dispatchIds: string[];
  reason: 'multiple_non_retry_dispatches';
};

export type DuplicatesReport = {
  kind: 'duplicates';
  hostId: string;
  runId: string;
  groups: DuplicateDispatchGroup[];
  totals: { groupCount: number; dispatchCount: number };
};

function renderId(value: string): string {
  return JSON.stringify(sanitizeDisplayText(value));
}

/**
 * A Task with two or more Dispatches that are not connected by retry_of edges
 * is reported as a duplicate-dispatch group (V1.6). Pure retry chains are left
 * to `report retries`.
 */
export function buildDuplicatesReport(
  ctx: OverheadReportContext,
  hostId: string,
  runId: string,
): DuplicatesReport {
  const run = ctx.db
    .prepare('SELECT 1 AS ok FROM orca_runs WHERE host_id = ? AND run_id = ?')
    .get(hostId, runId) as { ok: number } | undefined;
  if (!run) {
    throw new CliError({
      code: 'report_run_not_found',
      message: `Run ${renderId(runId)} on host ${renderId(hostId)} is not in the local database.`,
      hint: 'Collect this Orca Run before reporting duplicates.',
      exitCode: EXIT_ENVIRONMENT,
    });
  }

  const rows = ctx.db
    .prepare(
      `SELECT task_id, dispatch_id, retry_of_dispatch_id
       FROM orca_dispatches WHERE host_id = ? AND run_id = ?
       ORDER BY task_id, dispatch_id`,
    )
    .all(hostId, runId) as {
    task_id: string;
    dispatch_id: string;
    retry_of_dispatch_id: string | null;
  }[];

  const byTask = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = byTask.get(row.task_id) ?? [];
    list.push(row);
    byTask.set(row.task_id, list);
  }

  const groups: DuplicateDispatchGroup[] = [];
  for (const [taskId, list] of byTask) {
    if (list.length < 2) continue;
    const ids = new Set(list.map((d) => d.dispatch_id));
    const retryLinked = list.filter(
      (d) => d.retry_of_dispatch_id != null && ids.has(d.retry_of_dispatch_id),
    );
    // If every non-root node points at another dispatch in the same task set,
    // treat as a pure retry chain (not a duplicate group).
    const nonRoots = list.filter((d) => d.retry_of_dispatch_id != null);
    const pureRetry =
      nonRoots.length === list.length - 1 &&
      nonRoots.every((d) => d.retry_of_dispatch_id && ids.has(d.retry_of_dispatch_id)) &&
      retryLinked.length === nonRoots.length;
    if (pureRetry) continue;
    groups.push({
      taskId,
      dispatchIds: list.map((d) => d.dispatch_id),
      reason: 'multiple_non_retry_dispatches',
    });
  }

  return {
    kind: 'duplicates',
    hostId,
    runId,
    groups,
    totals: {
      groupCount: groups.length,
      dispatchCount: groups.reduce((s, g) => s + g.dispatchIds.length, 0),
    },
  };
}

export function formatDuplicatesReportText(report: DuplicatesReport): string {
  const lines = [
    `Duplicate dispatch analysis for host=${sanitizeDisplayText(report.hostId)} run=${sanitizeDisplayText(report.runId)}`,
    `groups=${report.totals.groupCount} dispatches=${report.totals.dispatchCount}`,
    '',
  ];
  for (const group of report.groups) {
    lines.push(
      `task=${sanitizeDisplayText(group.taskId)} dispatches=${group.dispatchIds.map(sanitizeDisplayText).join(',')}`,
    );
  }
  if (report.groups.length === 0) {
    lines.push('No duplicate non-retry Dispatch groups found for this Run.');
  }
  return `${lines.join('\n')}\n`;
}
