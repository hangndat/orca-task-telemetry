#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const key = argv.join(' ');

function respond(stdout, code = 0) {
  process.stdout.write(stdout, () => process.exit(code));
}

if (argv.length === 1 && argv[0] === '--version') {
  respond(`${process.env.ORCA_STUB_VERSION ?? '1.4.241'}\n`);
} else if (key === 'status --json') {
  const path = process.env.ORCA_STUB_STATUS_PATH;
  if (!path) {
    process.stderr.write('ORCA_STUB_STATUS_PATH required\n');
    process.exit(1);
  }
  respond(readFileSync(path, 'utf8'));
} else if (key.startsWith('orchestration worker-list')) {
  const path = process.env.ORCA_STUB_WORKER_LIST_PATH;
  if (!path) {
    respond(JSON.stringify({ ok: true, result: { workers: [] } }));
  } else {
    respond(readFileSync(path, 'utf8'));
  }
} else {
  process.stderr.write(`orca-router: unhandled argv ${JSON.stringify(argv)}\n`);
  process.exit(1);
}
