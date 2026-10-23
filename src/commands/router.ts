import { runDoctor, collectDoctorData } from '../doctor.js';
import { notImplemented, usageError, unknownCommand } from '../errors.js';
import { commandHelpText } from './help.js';
import { writeJsonSuccess } from './output.js';
import { runProjects } from './projects.js';

const STUB_COMMANDS = new Set(['init', 'collect', 'link']);

const REPORT_SUBCOMMANDS = new Set(['tasks', 'task', 'project', 'unmapped']);

export type RouteResult = { kind: 'ok'; data?: unknown } | { kind: 'text'; write: () => void };

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
    if (json) {
      return { kind: 'ok', data: collectDoctorData() };
    }
    return {
      kind: 'text',
      write: () => {
        runDoctor();
      },
    };
  }

  if (command === 'projects') {
    return runProjects(restPositionals, {
      json,
      cwd: options.cwd ?? process.cwd(),
    });
  }

  if (STUB_COMMANDS.has(command)) {
    throw notImplemented(command);
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
    const label = sub === 'task' ? `report task ${subRest[0]}` : `report ${sub}`;
    throw notImplemented(label);
  }

  throw unknownCommand(command);
}

export function finishRoute(result: RouteResult, json: boolean): number {
  if (result.kind === 'ok') {
    if (json) {
      writeJsonSuccess(result.data);
    }
    return 0;
  }
  result.write();
  return 0;
}
