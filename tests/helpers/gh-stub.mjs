#!/usr/bin/env node
/**
 * Test double for `gh`: reads GraphQL body from stdin, writes scripted stdout/stderr.
 * Reused by T14/T15/T38 — control via environment (no argv secrets).
 *
 * GH_STUB_STDOUT     — body written to stdout (default: {})
 * GH_STUB_STDERR     — body written to stderr (default: empty)
 * GH_STUB_EXIT_CODE  — process exit code (default: 0)
 * GH_STUB_COUNTER_FILE — if set, append "1\n" on each invocation (call counting)
 * GH_STUB_RECORD_FILE — if set, write JSON { argv, envTokenKeys } for AC4 checks
 * GH_STUB_PAD_BYTES   — if set, emit JSON `data.pad` with this many bytes (≥1 MiB tests)
 */
import { appendFileSync, writeFileSync } from 'node:fs';

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  stdin += chunk;
});
process.stdin.on('end', () => {
  run(stdin);
});
process.stdin.resume();

function run(stdinBody) {
  const delay = Number.parseInt(process.env.GH_STUB_DELAY_MS ?? '0', 10);
  if (Number.isFinite(delay) && delay > 0) {
    setTimeout(() => finishRun(stdinBody), delay);
    return;
  }
  finishRun(stdinBody);
}

function finishRun(stdinBody) {
  const recordPath = process.env.GH_STUB_RECORD_FILE;
  if (recordPath) {
    const envTokenKeys = Object.keys(process.env).filter((k) =>
      /TOKEN|PAT|AUTH/i.test(k),
    );
    writeFileSync(
      recordPath,
      JSON.stringify({
        argv: process.argv.slice(2),
        envTokenKeys,
        stdinLength: stdinBody.length,
      }),
      'utf8',
    );
  }

  const counter = process.env.GH_STUB_COUNTER_FILE;
  if (counter) {
    appendFileSync(counter, '1\n', 'utf8');
  }

  const stderr = process.env.GH_STUB_STDERR ?? '';
  if (stderr.length > 0) {
    process.stderr.write(stderr);
  }

  const padBytes = process.env.GH_STUB_PAD_BYTES;
  let stdout;
  if (padBytes) {
    const n = Number.parseInt(padBytes, 10);
    const pad = 'x'.repeat(Number.isFinite(n) && n > 0 ? n : 0);
    stdout = JSON.stringify({ data: { ok: true, pad } });
  } else {
    stdout = process.env.GH_STUB_STDOUT ?? '{}';
  }
  const code = Number.parseInt(process.env.GH_STUB_EXIT_CODE ?? '0', 10);
  const exitCode = Number.isFinite(code) ? code : 0;
  process.stdout.write(stdout, () => {
    process.exit(exitCode);
  });
}
