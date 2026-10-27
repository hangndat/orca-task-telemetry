#!/usr/bin/env node
/**
 * Stub `gh` for project item-edit adapter tests.
 *
 * GH_ITEM_EDIT_STUB_LOG_PATH — append JSON { argv } per invocation (argv excludes node/gh path)
 * GH_ITEM_EDIT_STUB_STDOUT — stdout body (default empty)
 * GH_ITEM_EDIT_STUB_STDERR — stderr body (default empty)
 * GH_ITEM_EDIT_STUB_EXIT_CODE — exit code (default 0)
 * GH_ITEM_EDIT_STUB_DELAY_MS — optional delay before exit
 */
import { appendFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const logPath = process.env.GH_ITEM_EDIT_STUB_LOG_PATH;

if (process.env.GH_ITEM_EDIT_STUB_SIGNAL === 'zero') {
  process.on('SIGTERM', () => process.exit(0));
} else if (process.env.GH_ITEM_EDIT_STUB_SIGNAL === 'ignore') {
  process.on('SIGTERM', () => {});
}

function finish() {
  if (logPath) {
    appendFileSync(logPath, `${JSON.stringify({ argv })}\n`);
  }

  const stderr = process.env.GH_ITEM_EDIT_STUB_STDERR ?? '';
  const stdout = process.env.GH_ITEM_EDIT_STUB_STDOUT ?? '';
  const code = Number.parseInt(process.env.GH_ITEM_EDIT_STUB_EXIT_CODE ?? '0', 10);
  const exitCode = Number.isFinite(code) ? code : 0;

  if (stderr.length > 0) {
    process.stderr.write(stderr, () => {
      process.stdout.write(stdout, () => {
        process.exit(exitCode);
      });
    });
  } else {
    process.stdout.write(stdout, () => {
      process.exit(exitCode);
    });
  }
}

const delay = Number.parseInt(process.env.GH_ITEM_EDIT_STUB_DELAY_MS ?? '0', 10);
if (Number.isFinite(delay) && delay > 0) {
  setTimeout(finish, delay);
} else {
  finish();
}
