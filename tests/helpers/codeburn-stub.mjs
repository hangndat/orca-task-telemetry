#!/usr/bin/env node
import { appendFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const logPath = process.env.CODEBURN_STUB_LOG_PATH;
if (logPath) {
  appendFileSync(logPath, `${JSON.stringify({ argv })}\n`);
}

const stdout = process.env.CODEBURN_STUB_STDOUT ?? '[]\n';
const stderr = process.env.CODEBURN_STUB_STDERR ?? '';
const code = Number.parseInt(process.env.CODEBURN_STUB_EXIT_CODE ?? '0', 10);

const done = () => process.exit(Number.isFinite(code) ? code : 0);
if (stderr.length > 0) {
  process.stderr.write(stderr, () => process.stdout.write(stdout, done));
} else {
  process.stdout.write(stdout, done);
}
