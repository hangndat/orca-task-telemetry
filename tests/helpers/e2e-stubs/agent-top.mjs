#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);

function loadRows(path) {
  if (!path) {
    return [];
  }
  const raw = readFileSync(path, 'utf8').trim();
  if (raw.length === 0) {
    return [];
  }
  const parsed = JSON.parse(raw.startsWith('[') ? raw : `[${raw}]`);
  return Array.isArray(parsed) ? parsed : [parsed];
}

if (argv.length === 1 && argv[0] === '--version') {
  process.stdout.write(`${process.env.AGENT_TOP_STUB_VERSION ?? '0.27.1'}\n`, () =>
    process.exit(0),
  );
} else if (argv[0] === 'sql' && argv[1] === '--json') {
  const combined = [
    ...loadRows(process.env.AGENT_TOP_STUB_CLAUDE_PATH),
    ...loadRows(process.env.AGENT_TOP_STUB_CODEX_PATH),
  ];
  const single = process.env.AGENT_TOP_STUB_SESSIONS_PATH;
  const body = `${JSON.stringify(single ? loadRows(single) : combined)}\n`;
  const stderr = process.env.AGENT_TOP_STUB_STDERR ?? '';
  const code = Number.parseInt(process.env.AGENT_TOP_STUB_EXIT_CODE ?? '0', 10);
  const done = () => process.exit(Number.isFinite(code) ? code : 0);
  if (stderr.length > 0) {
    process.stderr.write(stderr, () => process.stdout.write(body, done));
  } else {
    process.stdout.write(body, done);
  }
} else {
  process.stderr.write(`e2e agent-top: unhandled ${JSON.stringify(argv)}\n`);
  process.exit(1);
}
