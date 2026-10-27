#!/usr/bin/env node
/**
 * Deterministic gh stub for suggest-links apply tests.
 * repo view → GH_STUB_REPO_VIEW_JSON; GraphQL ResolveIssue → issue matching variables.number.
 */
import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const issues = {
  1: {
    id: 'I1',
    number: 1,
    url: 'https://github.com/acme/app/issues/1',
    title: 'App work',
    state: 'OPEN',
    repository: { nameWithOwner: 'acme/app' },
  },
  2: {
    id: 'I2',
    number: 2,
    url: 'https://github.com/acme/app/issues/2',
    title: 'Other app',
    state: 'OPEN',
    repository: { nameWithOwner: 'acme/app' },
  },
  3: {
    id: 'I3',
    number: 3,
    url: 'https://github.com/acme/other/issues/3',
    title: 'x',
    state: 'OPEN',
    repository: { nameWithOwner: 'acme/other' },
  },
};

if (argv[0] === 'repo' && argv[1] === 'view' && argv.includes('--json')) {
  process.stdout.write(process.env.GH_STUB_REPO_VIEW_JSON ?? '{}', () => process.exit(0));
} else if (argv[0] === 'api' && argv.includes('graphql')) {
  let stdin = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => {
    stdin += c;
  });
  process.stdin.on('end', () => {
    let number = 3;
    try {
      const body = JSON.parse(stdin);
      if (Number.isSafeInteger(body.variables?.number)) {
        number = body.variables.number;
      }
    } catch {
      // default
    }
    const issue = issues[number] ?? null;
    const payload = {
      data: {
        repository: {
          issue,
          pullRequest: null,
        },
      },
    };
    process.stdout.write(JSON.stringify(payload), () => process.exit(0));
  });
  process.stdin.resume();
} else if (argv[0] === 'auth' && argv[1] === 'status') {
  process.stdout.write('Logged in\n', () => process.exit(0));
} else {
  process.stderr.write(`gh-suggest: unexpected ${JSON.stringify(argv)}\n`);
  process.exit(2);
}

void readFileSync;
