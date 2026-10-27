import type { DatabaseSync } from 'node:sqlite';
import { CliError, EXIT_ENVIRONMENT } from '../errors.js';
import { resolveOverheadHost, type OverheadReportContext } from './overhead.js';
import { formatUsd, sanitizeDisplayText } from './render.js';

export type RetryNode = {
  dispatchId: string;
  taskId: string;
  retryOfDispatchId: string | null;
  depth: number;
  knownWorkerCostUsd: number;
  unknownWorkerCostSessions: number;
};

export type RetryChain = {
  rootDispatchId: string;
  taskId: string;
  nodes: RetryNode[];
  wastedRetryKnownCostUsd: number;
  unknownCostSessionCount: number;
};

export type RetriesReport = {
  kind: 'retries';
  hostId: string;
  runId: string;
  chains: RetryChain[];
  totals: {
    chainCount: number;
    retryDispatchCount: number;
    wastedRetryKnownCostUsd: number;
    unknownCostSessionCount: number;
  };
};

function renderId(value: string): string {
  return JSON.stringify(sanitizeDisplayText(value));
}

function workerCost(
  db: DatabaseSync,
  hostId: string,
  runId: string,
  dispatchId: string,
): { known: number; unknownSessions: number } {
  const rows = db
    .prepare(
      `SELECT s.cost_amount_usd AS amount, s.cost_kind AS kind
       FROM session_role_links r
       LEFT JOIN usage_snapshots s ON s.session_key = r.session_key
       WHERE r.role = 'worker' AND r.host_id = ? AND r.run_id = ? AND r.dispatch_id = ?`,
    )
    .all(hostId, runId, dispatchId) as { amount: number | null; kind: string | null }[];
  let known = 0;
  let unknownSessions = 0;
  for (const row of rows) {
    if (row.kind === 'estimated_api_equivalent' && typeof row.amount === 'number') {
      known += row.amount;
    } else {
      unknownSessions += 1;
    }
  }
  return { known, unknownSessions };
}

export function buildRetriesReport(
  ctx: OverheadReportContext,
  hostId: string,
  runId: string,
): RetriesReport {
  const run = ctx.db
    .prepare('SELECT 1 AS ok FROM orca_runs WHERE host_id = ? AND run_id = ?')
    .get(hostId, runId) as { ok: number } | undefined;
  if (!run) {
    throw new CliError({
      code: 'report_run_not_found',
      message: `Run ${renderId(runId)} on host ${renderId(hostId)} is not in the local database.`,
      hint: 'Collect this Orca Run before reporting retries.',
      exitCode: EXIT_ENVIRONMENT,
    });
  }

  const dispatches = ctx.db
    .prepare(
      `SELECT dispatch_id, task_id, retry_of_dispatch_id
       FROM orca_dispatches WHERE host_id = ? AND run_id = ?`,
    )
    .all(hostId, runId) as {
    dispatch_id: string;
    task_id: string;
    retry_of_dispatch_id: string | null;
  }[];

  const byId = new Map(dispatches.map((d) => [d.dispatch_id, d]));
  const roots = dispatches.filter((d) => d.retry_of_dispatch_id != null);
  const seen = new Set<string>();
  const chains: RetryChain[] = [];

  for (const retry of roots) {
    if (seen.has(retry.dispatch_id)) continue;
    // Walk to root
    let cursor: typeof retry | undefined = retry;
    const trail: typeof retry[] = [];
    const guard = new Set<string>();
    while (cursor) {
      if (guard.has(cursor.dispatch_id)) break;
      guard.add(cursor.dispatch_id);
      trail.push(cursor);
      if (!cursor.retry_of_dispatch_id) break;
      cursor = byId.get(cursor.retry_of_dispatch_id);
    }
    trail.reverse();
    if (trail.length < 2) continue;
    for (const node of trail) seen.add(node.dispatch_id);

    const nodes: RetryNode[] = trail.map((node, depth) => {
      const cost = workerCost(ctx.db, hostId, runId, node.dispatch_id);
      return {
        dispatchId: node.dispatch_id,
        taskId: node.task_id,
        retryOfDispatchId: node.retry_of_dispatch_id,
        depth,
        knownWorkerCostUsd: cost.known,
        unknownWorkerCostSessions: cost.unknownSessions,
      };
    });
    const wasted = nodes.slice(1);
    const wastedRetryKnownCostUsd = wasted.reduce((s, n) => s + n.knownWorkerCostUsd, 0);
    const unknownCostSessionCount = wasted.reduce((s, n) => s + n.unknownWorkerCostSessions, 0);
    chains.push({
      rootDispatchId: nodes[0]!.dispatchId,
      taskId: nodes[0]!.taskId,
      nodes,
      wastedRetryKnownCostUsd,
      unknownCostSessionCount,
    });
  }

  return {
    kind: 'retries',
    hostId,
    runId,
    chains,
    totals: {
      chainCount: chains.length,
      retryDispatchCount: chains.reduce((s, c) => s + Math.max(0, c.nodes.length - 1), 0),
      wastedRetryKnownCostUsd: chains.reduce((s, c) => s + c.wastedRetryKnownCostUsd, 0),
      unknownCostSessionCount: chains.reduce((s, c) => s + c.unknownCostSessionCount, 0),
    },
  };
}

export function formatRetriesReportText(report: RetriesReport): string {
  const lines = [
    `Retry analysis for host=${sanitizeDisplayText(report.hostId)} run=${sanitizeDisplayText(report.runId)}`,
    `chains=${report.totals.chainCount} retryDispatches=${report.totals.retryDispatchCount}`,
    `wastedRetryKnownCostUsd=${formatUsd(report.totals.wastedRetryKnownCostUsd)} unknownSessions=${report.totals.unknownCostSessionCount}`,
    '',
  ];
  for (const chain of report.chains) {
    lines.push(
      `task=${sanitizeDisplayText(chain.taskId)} root=${sanitizeDisplayText(chain.rootDispatchId)} wasted=${formatUsd(chain.wastedRetryKnownCostUsd)}`,
    );
    for (const node of chain.nodes) {
      lines.push(
        `  depth=${node.depth} dispatch=${sanitizeDisplayText(node.dispatchId)}` +
          (node.retryOfDispatchId
            ? ` retryOf=${sanitizeDisplayText(node.retryOfDispatchId)}`
            : ' (root)') +
          ` known=${formatUsd(node.knownWorkerCostUsd)} unknown=${node.unknownWorkerCostSessions}`,
      );
    }
  }
  if (report.chains.length === 0) {
    lines.push('No retry chains found for this Run.');
  }
  return `${lines.join('\n')}\n`;
}

export { resolveOverheadHost };
