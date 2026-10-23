#!/usr/bin/env node
/**
 * Paging stub for readProjectItems tests: reads GraphQL variables.after from stdin
 * and returns GH_STUB_PAGE1_PATH or GH_STUB_PAGE2_PATH JSON.
 */
import { appendFileSync, readFileSync } from 'node:fs';

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  stdin += chunk;
});
process.stdin.on('end', () => {
  const counter = process.env.GH_STUB_COUNTER_FILE;
  if (counter) {
    appendFileSync(counter, '1\n', 'utf8');
  }

  let after = null;
  try {
    const body = JSON.parse(stdin);
    after = body.variables?.after ?? null;
  } catch {
    // ignore
  }

  const page1 = process.env.GH_STUB_PAGE1_PATH;
  const page2 = process.env.GH_STUB_PAGE2_PATH;
  const path = after ? page2 : page1;
  if (!path) {
    process.stderr.write('GH_STUB_PAGE1_PATH / GH_STUB_PAGE2_PATH required\n');
    process.exit(1);
  }
  process.stdout.write(readFileSync(path, 'utf8'));
  process.exit(0);
});
process.stdin.resume();
