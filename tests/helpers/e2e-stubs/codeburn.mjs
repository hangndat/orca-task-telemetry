#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);

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
  const stderr = process.env.CODEBURN_STUB_STDERR ?? '';
  const code = Number.parseInt(process.env.CODEBURN_STUB_EXIT_CODE ?? '0', 10);
  const done = () => process.exit(Number.isFinite(code) ? code : 0);
  if (stderr.length > 0) {
    process.stderr.write(stderr, () => process.stdout.write(body, done));
  } else {
    process.stdout.write(body, done);
  }
} else {
  process.stderr.write(`e2e codeburn: unhandled ${JSON.stringify(argv)}\n`);
  process.exit(1);
}
