import { parseArgs } from 'node:util';
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
import {
  buildOverheadReport,
  formatOverheadReportText,
  openOverheadReportContext,
} from '../reports/overhead.js';

export type ReportSubcommand = 'tasks' | 'task' | 'project' | 'hierarchy' | 'unmapped';

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

/**
 * Best-effort scan for `--format json` on `report overhead` args, used only to
 * pick the error-boundary output mode (cli.ts) before the real strict parse
 * in parseOverheadArgs runs — so a parse failure itself still renders as JSON
 * when the caller explicitly asked for JSON. The strict parser decides whether
 * duplicate or malformed options are valid; this scan only selects the error envelope.
 */
export function peekOverheadJsonFormat(rest: string[]): boolean {
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--format=json' || (arg === '--format' && rest[i + 1] === 'json')) {
      return true;
    }
  }
  return false;
}

function parseOverheadArgs(rest: string[]): { host: string; run: string; json: boolean } {
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
      'Usage: orca-telemetry report overhead --host <host-id> --run <run-id> [--format json]',
    );
  }
  const host = parsed.values.host as string | undefined;
  const run = parsed.values.run as string | undefined;
  const format = parsed.values.format as string | undefined;
  if (!host) {
    throw usageError('Missing --host.', 'Pass the exact Orca host id this Run was collected from.');
  }
  if (!run) {
    throw usageError('Missing --run.', 'Pass the exact Orca Run id.');
  }
  if (format !== undefined && format !== 'json') {
    throw usageError(`Invalid --format '${format}'.`, 'The only supported --format value is json.');
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
    const data = buildOverheadReport(ctx, args.host, args.run);
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
