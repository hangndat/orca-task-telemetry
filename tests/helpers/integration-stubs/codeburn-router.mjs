#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const argv = process.argv.slice(2);
if (process.env.CODEBURN_STUB_REQUIRE_RUNNING_ATTEMPTS_DB) {
  const db = new DatabaseSync(process.env.CODEBURN_STUB_REQUIRE_RUNNING_ATTEMPTS_DB);
  const rows = db.prepare(`SELECT provider FROM collection_attempts AS a
    WHERE source = 'codeburn' AND status = 'running' AND attempt_id = (
      SELECT MAX(attempt_id) FROM collection_attempts
      WHERE source = 'codeburn' AND provider = a.provider)`).all();
  db.close();
  const running = new Set(rows.map((row) => row.provider));
  const expected = argv[0] === '--version'
    ? ['claude', 'codex']
    : [argv[argv.indexOf('--provider') + 1]];
  if (expected.some((provider) => !running.has(provider))) process.exit(9);
}
if (process.env.CODEBURN_STUB_CALLS_PATH) {
  appendFileSync(process.env.CODEBURN_STUB_CALLS_PATH, `${JSON.stringify(argv)}\n`);
}

if (argv.length === 1 && argv[0] === '--version') {
  process.stdout.write(`${process.env.CODEBURN_STUB_VERSION ?? '0.9.27'}\n`, () =>
    process.exit(0),
  );
} else if (argv[0] === 'sessions') {
  const providerIdx = argv.indexOf('--provider');
  const provider = providerIdx >= 0 ? argv[providerIdx + 1] : '';
  const envKey =
    provider === 'codex'
      ? 'CODEBURN_STUB_CODEX_PATH'
      : 'CODEBURN_STUB_CLAUDE_PATH';
  const path = process.env[envKey] ?? process.env.CODEBURN_STUB_STDOUT_PATH;
  let body = '[]\n';
  if (path) {
    const raw = readFileSync(path, 'utf8').trim();
    body = raw.startsWith('[') ? `${raw}\n` : `[${raw}]\n`;
  }
  if (process.env[`CODEBURN_STUB_${provider.toUpperCase()}_INVALID_JSON`] === '1') {
    body = 'SECRET_INVALID_JSON\n';
  }
  const stderr = process.env.CODEBURN_STUB_STDERR ?? '';
  const code = Number.parseInt(
    process.env[`CODEBURN_STUB_${provider.toUpperCase()}_EXIT_CODE`]
      ?? process.env.CODEBURN_STUB_EXIT_CODE ?? '0', 10);
  const done = () => process.exit(Number.isFinite(code) ? code : 0);
  if (stderr.length > 0) {
    process.stderr.write(stderr, () => process.stdout.write(body, done));
  } else {
    process.stdout.write(body, done);
  }
} else {
  process.stderr.write(`codeburn-router: unhandled ${JSON.stringify(argv)}\n`);
  process.exit(1);
}
