#!/usr/bin/env node
/**
 * Stub Orca CLI for adapter tests.
 *
 * ORCA_STUB_STDOUT — bytes written to stdout before exit
 * ORCA_STUB_STDERR — optional stderr (not echoed to test output by default)
 * ORCA_STUB_EXIT_CODE — exit code (default 0)
 * ORCA_STUB_LOG_PATH — append JSON line { "argv": [...] } per invocation
 */
import { appendFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const logPath = process.env.ORCA_STUB_LOG_PATH;
if (logPath) {
  appendFileSync(logPath, `${JSON.stringify({ argv })}\n`);
}

const stdout = process.env.ORCA_STUB_STDOUT ?? '';
const stderr = process.env.ORCA_STUB_STDERR ?? '';
const code = Number.parseInt(process.env.ORCA_STUB_EXIT_CODE ?? '0', 10);

if (stderr.length > 0) {
  process.stderr.write(stderr, () => {
    process.stdout.write(stdout, () => {
      process.exit(Number.isFinite(code) ? code : 0);
    });
  });
} else {
  process.stdout.write(stdout, () => {
    process.exit(Number.isFinite(code) ? code : 0);
  });
}
