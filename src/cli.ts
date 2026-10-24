#!/usr/bin/env node
import { rootHelpText, VERSION } from './commands/help.js';
import {
  emitCliError,
  emitUnexpectedError,
  writeJsonSuccess,
} from './commands/output.js';
import { finishRoute, routeCommand } from './commands/router.js';
import { peekOverheadJsonFormat } from './commands/report.js';
import { CliError, nodeVersionError, usageError } from './errors.js';
import { checkNodeVersion } from './node-version.js';

const INTERNAL_TEST_COMMAND = '__internal_test_unexpected_error';

export async function runCli(argv: string[]): Promise<number> {
  const nodeCheck = checkNodeVersion(process.version);
  if (!nodeCheck.ok) {
    const err = nodeVersionError(nodeCheck.message);
    emitCliError(err, argv.includes('--json'));
    return err.exitCode;
  }

  let json = false;
  const positionals: string[] = [];
  for (const arg of argv) {
    if (arg === '--json') {
      json = true;
      continue;
    }
    positionals.push(arg);
  }

  const wantsHelp = argv.includes('--help') || argv.includes('-h');

  if (argv.includes('--version') || argv.includes('-v')) {
    if (json) {
      writeJsonSuccess({ version: VERSION });
    } else {
      process.stdout.write(`${VERSION}\n`);
    }
    return 0;
  }

  const [command, ...rest] = positionals;

  if (
    command !== undefined &&
    command.startsWith('-') &&
    command !== '-h' &&
    command !== '--help'
  ) {
    const err = usageError(
      `Unknown option '${command}'.`,
      'Run orca-telemetry --help for usage.',
    );
    emitCliError(err, json);
    return err.exitCode;
  }

  if (wantsHelp && (command === undefined || command === '-h' || command === '--help')) {
    if (json) {
      writeJsonSuccess({ help: rootHelpText() });
    } else {
      process.stdout.write(rootHelpText());
    }
    return 0;
  }

  if (command === undefined) {
    if (json) {
      writeJsonSuccess({ help: rootHelpText() });
    } else {
      process.stdout.write(rootHelpText());
    }
    return 0;
  }

  if (wantsHelp && (command === '-h' || command === '--help')) {
    if (json) {
      writeJsonSuccess({ help: rootHelpText() });
    } else {
      process.stdout.write(rootHelpText());
    }
    return 0;
  }

  if (command === INTERNAL_TEST_COMMAND) {
    throw new Error('internal test unexpected error');
  }

  // `report overhead --format json` must render JSON for its errors too, even
  // without the global --json flag; detect that ahead of the strict argument
  // parse so a usage error (e.g. a missing --host) still gets the JSON the
  // caller asked for, not plain text.
  const overheadJson =
    command === 'report' && rest[0] === 'overhead' && peekOverheadJsonFormat(rest.slice(1));
  const errorJson = json || overheadJson;

  try {
    const result = await routeCommand(command, rest, { json, wantsHelp });
    return finishRoute(result, json);
  } catch (err) {
    if (err instanceof CliError) {
      emitCliError(err, errorJson);
      return err.exitCode;
    }
    return emitUnexpectedError(err, errorJson);
  }
}

async function main(argv: string[]): Promise<number> {
  try {
    return await runCli(argv);
  } catch (err) {
    const json = argv.includes('--json');
    return emitUnexpectedError(err, json);
  }
}

void main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
