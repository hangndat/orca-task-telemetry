import {
  formatDoctorText,
  runDoctorWithDeps,
  buildDefaultDoctorDeps,
} from '../doctor.js';
import { usageError, unknownCommand } from '../errors.js';
import { commandHelpText } from './help.js';
import { writeJsonSuccess } from './output.js';
import { runInit } from './init.js';
import { runProjects } from './projects.js';
import { runCollect } from './collect.js';
import { runLink } from './link.js';
import { runReport, runReportTask } from './report.js';

const REPORT_SUBCOMMANDS = new Set(['tasks', 'task', 'project', 'hierarchy', 'unmapped']);

export type RouteResult =
  | { kind: 'ok'; data?: unknown; exitCode?: number }
  | { kind: 'text'; write: () => void; exitCode?: number };

export async function routeCommand(
  command: string,
  restPositionals: string[],
  options: { json: boolean; wantsHelp: boolean; cwd?: string },
): Promise<RouteResult> {
  const { json, wantsHelp } = options;

  if (wantsHelp) {
    return {
      kind: 'text',
      write: () => {
        process.stdout.write(commandHelpText(command));
      },
    };
  }

  if (command === 'doctor') {
    const cwd = options.cwd ?? process.cwd();
    const report = await runDoctorWithDeps(await buildDefaultDoctorDeps(cwd));
    if (json) {
      return { kind: 'ok', data: report, exitCode: report.exitCode };
    }
    return {
      kind: 'text',
      exitCode: report.exitCode,
      write: () => {
        process.stdout.write(formatDoctorText(report));
      },
    };
  }

  if (command === 'collect') {
    return runCollect(restPositionals, {
      json,
      cwd: options.cwd ?? process.cwd(),
    });
  }

  if (command === 'link') {
    return runLink(restPositionals, {
      json,
      cwd: options.cwd ?? process.cwd(),
    });
  }

  if (command === 'projects') {
    return runProjects(restPositionals, {
      json,
      cwd: options.cwd ?? process.cwd(),
    });
  }

  if (command === 'init') {
    return runInit(restPositionals, {
      json,
      cwd: options.cwd ?? process.cwd(),
    });
  }

  if (command === 'report') {
    const [sub, ...subRest] = restPositionals;
    if (sub === undefined) {
      throw usageError('Missing report subcommand.', 'Run orca-telemetry report --help.');
    }
    if (sub === 'task' && subRest.length === 0) {
      throw usageError('Missing issue id for report task.', 'Usage: orca-telemetry report task <issue-id>');
    }
    if (!REPORT_SUBCOMMANDS.has(sub)) {
      throw usageError(`Unknown report subcommand: ${sub}.`, 'Run orca-telemetry report --help.');
    }
    if (subRest.length > 0 && sub !== 'task') {
      throw usageError(
        `Unexpected arguments: ${subRest.join(' ')}`,
        `Usage: orca-telemetry report ${sub}`,
      );
    }
    const cwd = options.cwd ?? process.cwd();
    if (sub === 'task') {
      const issueArg = subRest[0];
      if (!issueArg) {
        throw usageError(
          'Missing issue id for report task.',
          'Usage: orca-telemetry report task <issue-id>',
        );
      }
      return runReportTask(issueArg, subRest.slice(1), { json, cwd });
    }
    return runReport(sub as 'tasks' | 'project' | 'hierarchy' | 'unmapped', subRest, {
      json,
      cwd,
    });
  }

  throw unknownCommand(command);
}

export function finishRoute(result: RouteResult, json: boolean): number {
  if (result.kind === 'ok') {
    if (json) {
      writeJsonSuccess(result.data);
    }
    return result.exitCode ?? 0;
  }
  result.write();
  return result.exitCode ?? 0;
}
