#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { rootHelpText, VERSION } from './commands/help.js';
import {
  emitCliError,
  emitUnexpectedError,
  writeJsonSuccess,
} from './commands/output.js';
import { finishRoute, routeCommand } from './commands/router.js';
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
  let positionals: string[] = [];

  try {
    const parsed = parseArgs({
      args: argv,
      options: {
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
        json: { type: 'boolean' },
      },
      allowPositionals: true,
      strict: true,
    });
    json = parsed.values.json === true;
    positionals = parsed.positionals;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const cliErr = usageError(message, 'Run orca-telemetry --help for usage.');
    emitCliError(cliErr, argv.includes('--json'));
    return cliErr.exitCode;
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

  if (wantsHelp && command === undefined) {
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

  if (command === INTERNAL_TEST_COMMAND) {
    throw new Error('internal test unexpected error');
  }

  try {
    const result = await routeCommand(command, rest, { json, wantsHelp });
    return finishRoute(result, json);
  } catch (err) {
    if (err instanceof CliError) {
      emitCliError(err, json);
      return err.exitCode;
    }
    return emitUnexpectedError(err, json);
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
