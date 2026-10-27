import { usageError } from '../errors.js';
import { buildProjectReport, formatProjectReportText } from '../reports/project.js';
import { buildHierarchyReport, formatHierarchyReportText } from '../reports/hierarchy.js';
import {
  buildTaskReport,
  buildTasksReport,
  formatTaskReportText,
  formatTasksReportText,
  openReportContext,
} from '../reports/tasks.js';
import {
  buildUnmappedReport,
  formatUnmappedReportText,
} from '../reports/unmapped.js';
import type { RouteResult } from './router.js';
import { buildTraceReport, formatTraceReportText, openTraceReportContext } from '../reports/trace.js';
import { parseArgs } from 'node:util';
import {
  buildOverheadReport,
  formatOverheadReportText,
  openOverheadReportContext,
  resolveOverheadHost,
} from '../reports/overhead.js';
import { sanitizeDisplayText } from '../reports/render.js';
import { buildRetriesReport, formatRetriesReportText } from '../reports/retries.js';
import { buildDuplicatesReport, formatDuplicatesReportText } from '../reports/duplicates.js';
import { buildWasteReport, formatWasteReportText } from '../reports/waste.js';
import { buildBudgetReport, formatBudgetReportText } from '../reports/budget.js';

export type ReportSubcommand = 'tasks' | 'task' | 'project' | 'hierarchy' | 'unmapped' | 'waste';

export async function runReport(
  sub: ReportSubcommand,
  rest: string[],
  options: { json: boolean; cwd: string },
): Promise<RouteResult> {
  if (rest.length > 0) {
    throw usageError(
      `Unexpected arguments: ${rest.join(' ')}`,
      `Usage: orca-telemetry report ${sub}${sub === 'task' ? ' <issue>' : ''}`,
    );
  }

  const ctx = await openReportContext(options.cwd);
  try {
    if (sub === 'tasks') {
      const data = buildTasksReport(ctx);
      if (options.json) {
        return { kind: 'ok', data };
      }
      return {
        kind: 'text',
        write: () => {
          process.stdout.write(formatTasksReportText(data));
        },
      };
    }
    if (sub === 'project') {
      const data = buildProjectReport(ctx);
      if (options.json) {
        return { kind: 'ok', data };
      }
      return {
        kind: 'text',
        write: () => {
          process.stdout.write(formatProjectReportText(data));
        },
      };
    }
    if (sub === 'hierarchy') {
      const data = buildHierarchyReport(ctx);
      if (options.json) {
        return { kind: 'ok', data };
      }
      return {
        kind: 'text',
        write: () => {
          process.stdout.write(formatHierarchyReportText(data));
        },
      };
    }
    const data = buildUnmappedReport(ctx);
    if (options.json) {
      return { kind: 'ok', data };
    }
    return {
      kind: 'text',
      write: () => {
        process.stdout.write(formatUnmappedReportText(data));
      },
    };
  } finally {
    ctx.close();
  }
}

export async function runReportTask(
  issueArg: string,
  rest: string[],
  options: { json: boolean; cwd: string },
): Promise<RouteResult> {
  if (rest.length > 0) {
    throw usageError(
      `Unexpected arguments: ${rest.join(' ')}`,
      'Usage: orca-telemetry report task <issue-id>',
    );
  }
  const ctx = await openReportContext(options.cwd);
  try {
    const data = buildTaskReport(ctx, issueArg);
    if (options.json) {
      return { kind: 'ok', data };
    }
    return {
      kind: 'text',
      write: () => {
        process.stdout.write(formatTaskReportText(data));
      },
    };
  } finally {
    ctx.close();
  }
}

export async function runReportTrace(
  issueArg: string,
  rest: string[],
  options: { json: boolean; cwd: string },
): Promise<RouteResult> {
  if (rest.length > 0) throw usageError(`Unexpected arguments: ${rest.join(' ')}`,
    'Usage: orca-telemetry report trace <issue-id>');
  const ctx = await openTraceReportContext(options.cwd);
  try {
    const data = buildTraceReport(ctx, issueArg);
    if (options.json) return { kind: 'ok', data };
    return { kind: 'text', write: () => process.stdout.write(formatTraceReportText(data)) };
  } finally { ctx.close(); }
}

export function peekOverheadJsonFormat(rest: string[]): boolean {
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--format=json' || (arg === '--format' && rest[i + 1] === 'json')) {
      return true;
    }
  }
  return false;
}

function parseOverheadArgs(rest: string[]): { host: string | undefined; run: string; json: boolean } {
  let parsed: { values: Record<string, string | boolean | undefined> };
  try {
    parsed = parseArgs({
      args: rest,
      options: {
        host: { type: 'string' },
        run: { type: 'string' },
        format: { type: 'string' },
      },
      allowPositionals: false,
      strict: true,
    });
  } catch {
    throw usageError(
      'Invalid options for report overhead.',
      'Usage: orca-telemetry report overhead --run <run-id> [--host <host-id>] [--format json]',
    );
  }
  const host = parsed.values.host as string | undefined;
  const run = parsed.values.run as string | undefined;
  const format = parsed.values.format as string | undefined;
  if (host !== undefined && host.length === 0) {
    throw usageError('Empty --host.', 'Pass an exact host ID or omit --host to resolve a unique Run.');
  }
  if (!run) {
    throw usageError('Missing --run.', 'Pass the exact Orca Run id.');
  }
  if (format !== undefined && format !== 'json') {
    throw usageError(`Invalid --format ${JSON.stringify(sanitizeDisplayText(format))}.`,
      'The only supported --format value is json.');
  }
  return { host, run, json: format === 'json' };
}

export async function runReportOverhead(
  rest: string[],
  options: { json: boolean; cwd: string },
): Promise<RouteResult> {
  const args = parseOverheadArgs(rest);
  const ctx = await openOverheadReportContext();
  try {
    const host = args.host ?? resolveOverheadHost(ctx, args.run);
    const data = buildOverheadReport(ctx, host, args.run);
    // --format json must render JSON even without the global --json flag, so this
    // writes directly (matching writeJsonSuccess's shape) rather than returning
    // 'ok', which finishRoute only prints when the global --json flag is set.
    if (options.json || args.json) {
      return { kind: 'text', write: () => process.stdout.write(`${JSON.stringify({ ok: true, data })}\n`) };
    }
    return { kind: 'text', write: () => process.stdout.write(formatOverheadReportText(data)) };
  } finally {
    ctx.close();
  }
}


function parseRunHostArgs(rest: string[], command: string): { host?: string; run: string } {
  let parsed: { values: Record<string, string | undefined> };
  try {
    parsed = parseArgs({
      args: rest,
      options: { host: { type: 'string' }, run: { type: 'string' } },
      allowPositionals: false,
      strict: true,
    });
  } catch {
    throw usageError(
      `Invalid options for report ${command}.`,
      `Usage: orca-telemetry report ${command} --run <run-id> [--host <host-id>] [--json]`,
    );
  }
  const host = parsed.values.host;
  const run = parsed.values.run;
  if (host !== undefined && host.length === 0) {
    throw usageError('Empty --host.', 'Pass an exact host ID or omit --host.');
  }
  if (!run) {
    throw usageError('Missing --run.', `Pass --run for report ${command}.`);
  }
  return { host, run };
}

export async function runReportRetries(
  rest: string[],
  options: { json: boolean; cwd: string },
): Promise<RouteResult> {
  const args = parseRunHostArgs(rest, 'retries');
  const ctx = await openOverheadReportContext();
  try {
    const host = args.host ?? resolveOverheadHost(ctx, args.run);
    const data = buildRetriesReport(ctx, host, args.run);
    if (options.json) return { kind: 'ok', data };
    return { kind: 'text', write: () => process.stdout.write(formatRetriesReportText(data)) };
  } finally {
    ctx.close();
  }
}

export async function runReportDuplicates(
  rest: string[],
  options: { json: boolean; cwd: string },
): Promise<RouteResult> {
  const args = parseRunHostArgs(rest, 'duplicates');
  const ctx = await openOverheadReportContext();
  try {
    const host = args.host ?? resolveOverheadHost(ctx, args.run);
    const data = buildDuplicatesReport(ctx, host, args.run);
    if (options.json) return { kind: 'ok', data };
    return { kind: 'text', write: () => process.stdout.write(formatDuplicatesReportText(data)) };
  } finally {
    ctx.close();
  }
}

export async function runReportBudget(
  rest: string[],
  options: { json: boolean; cwd: string },
): Promise<RouteResult> {
  let parsed: { values: Record<string, string | undefined> };
  try {
    parsed = parseArgs({
      args: rest,
      options: {
        'limit-usd': { type: 'string' },
        issue: { type: 'string' },
        rollup: { type: 'string' },
      },
      allowPositionals: false,
      strict: true,
    });
  } catch {
    throw usageError(
      'Invalid options for report budget.',
      'Usage: orca-telemetry report budget --limit-usd <n> [--issue <sel>] [--rollup direct|inclusive] [--json]',
    );
  }
  const limitRaw = parsed.values['limit-usd'];
  if (!limitRaw) {
    throw usageError('Missing --limit-usd.', 'Pass a positive USD limit.');
  }
  const limitUsd = Number(limitRaw);
  const rollup = (parsed.values.rollup ?? 'direct') as 'direct' | 'inclusive';
  if (rollup !== 'direct' && rollup !== 'inclusive') {
    throw usageError('Invalid --rollup.', 'Use direct or inclusive.');
  }
  const ctx = await openReportContext(options.cwd);
  try {
    const data = buildBudgetReport(ctx, {
      limitUsd,
      issueArg: parsed.values.issue,
      rollup,
    });
    if (options.json) return { kind: 'ok', data };
    return { kind: 'text', write: () => process.stdout.write(formatBudgetReportText(data)) };
  } finally {
    ctx.close();
  }
}
