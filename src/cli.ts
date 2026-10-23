#!/usr/bin/env node
import { runDoctor } from './doctor.js';
import { checkNodeVersion } from './node-version.js';

const VERSION = '0.1.0';

function help(): void {
  process.stdout.write(`orca-task-telemetry ${VERSION} — foundation scaffold\n\nUsage:\n  orca-telemetry --help\n  orca-telemetry --version\n  orca-telemetry doctor\n\nPlanned MVP commands (not implemented yet):\n  init, projects, collect, link, report tasks, report task, report project, report unmapped\n\nSee docs/MVP-SPEC.md for acceptance criteria.\n`);
}

function main(argv: string[]): number {
  const nodeCheck = checkNodeVersion(process.version);
  if (!nodeCheck.ok) {
    process.stderr.write(`${nodeCheck.message}\n`);
    return 1;
  }

  const [command] = argv;
  if (command === undefined || command === '-h' || command === '--help' || command === 'help') {
    help();
    return 0;
  }
  if (command === '-v' || command === '--version') {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (command === 'doctor') {
    return runDoctor();
  }
  if (['init', 'projects', 'collect', 'link', 'report'].includes(command)) {
    process.stderr.write(`Command '${command}' is planned but not implemented. See docs/MVP-SPEC.md.\n`);
    return 2;
  }
  process.stderr.write(`Unknown command: ${command}. Run --help.\n`);
  return 2;
}

process.exitCode = main(process.argv.slice(2));
