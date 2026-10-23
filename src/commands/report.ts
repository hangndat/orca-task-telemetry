import { usageError } from '../errors.js';
import { buildProjectReport, formatProjectReportText } from '../reports/project.js';
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

export type ReportSubcommand = 'tasks' | 'task' | 'project' | 'unmapped';

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
