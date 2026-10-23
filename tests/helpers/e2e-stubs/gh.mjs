#!/usr/bin/env node
/**
 * Unified `gh` stub for E2E: init project discovery, collect pagination, link resolve.
 * Synthetic fixtures only — see tests/fixtures/e2e/README.md.
 */
import { appendFileSync, readFileSync } from 'node:fs';

function respond(stdout, code = 0) {
  process.stdout.write(stdout, () => process.exit(code));
}

function handleGraphqlBody(stdin) {
  if (process.env.GH_STUB_SCOPE_ERROR === '1') {
    return JSON.stringify({
      errors: [
        {
          message: 'read:project scope required',
          extensions: { type: 'INSUFFICIENT_SCOPES' },
        },
      ],
    });
  }

  const oneShot = process.env.GH_STUB_GRAPHQL_JSON;
  if (oneShot) {
    return oneShot;
  }

  let query = '';
  let after = null;
  try {
    const body = JSON.parse(stdin);
    query = body.query ?? '';
    after = body.variables?.after ?? null;
  } catch {
    process.stderr.write('invalid stdin json\n');
    process.exit(1);
  }

  const counter = process.env.GH_STUB_COUNTER_FILE;
  if (counter) {
    appendFileSync(counter, '1\n', 'utf8');
  }

  if (
    query.includes('RepositoryProjects') ||
    query.includes('UserProjects') ||
    query.includes('OrganizationProjects')
  ) {
    if (query.includes('RepositoryProjects')) {
      return process.env.GH_STUB_GRAPHQL_REPO_JSON ?? '{}';
    }
    return process.env.GH_STUB_GRAPHQL_OWNER_JSON ?? '{}';
  }

  if (query.includes('ProjectItems') || query.includes('node(id:')) {
    const page1 = process.env.GH_STUB_PAGE1_PATH;
    const page2 = process.env.GH_STUB_PAGE2_PATH;
    const path = after ? page2 : page1;
    if (!path) {
      process.stderr.write('GH_STUB_PAGE paths required\n');
      process.exit(1);
    }
    return readFileSync(path, 'utf8');
  }

  process.stderr.write(`e2e gh: unexpected query ${query.slice(0, 96)}\n`);
  process.exit(1);
}

const argv = process.argv.slice(2);

if (argv[0] === 'repo' && argv[1] === 'view') {
  respond(process.env.GH_STUB_REPO_VIEW_JSON ?? '{}');
} else if (argv[0] === 'api' && argv.includes('graphql')) {
  let stdin = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => {
    stdin += c;
  });
  process.stdin.on('end', () => {
    respond(handleGraphqlBody(stdin));
  });
  process.stdin.resume();
} else if (argv[0] === 'auth' && argv[1] === 'status') {
  respond(process.env.GH_STUB_AUTH_STATUS ?? 'Logged in to github.com as e2e-stub\n');
} else {
  process.stderr.write(`e2e gh: unexpected ${JSON.stringify(argv)}\n`);
  process.exit(2);
}
