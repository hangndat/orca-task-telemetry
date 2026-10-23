#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';

const argv = process.argv.slice(2);

if (
  argv[0] === 'repo' &&
  argv[1] === 'view' &&
  argv.includes('--json')
) {
  const stdout = process.env.GH_STUB_REPO_VIEW_JSON ?? '{}';
  process.stdout.write(stdout, () => process.exit(0));
} else if (argv[0] === 'api' && argv.includes('graphql')) {
  if (process.env.GH_STUB_SCOPE_ERROR === '1') {
    const body = JSON.stringify({
      errors: [
        {
          message: 'read:project scope required',
          extensions: { type: 'INSUFFICIENT_SCOPES' },
        },
      ],
    });
    process.stdout.write(body, () => process.exit(0));
  } else {
    const oneShot = process.env.GH_STUB_GRAPHQL_JSON;
    if (oneShot) {
      process.stdout.write(oneShot, () => process.exit(0));
    } else {
      let stdin = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (c) => {
        stdin += c;
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
          process.stderr.write('GH_STUB_PAGE paths required\n');
          process.exit(1);
        }
        process.stdout.write(readFileSync(path, 'utf8'), () => process.exit(0));
      });
      process.stdin.resume();
    }
  }
} else if (argv[0] === 'auth' && argv[1] === 'status') {
  process.stdout.write(process.env.GH_STUB_AUTH_STATUS ?? 'Logged in\n', () =>
    process.exit(0),
  );
} else {
  process.stderr.write(`gh-collect: unexpected ${JSON.stringify(argv)}\n`);
  process.exit(2);
}
