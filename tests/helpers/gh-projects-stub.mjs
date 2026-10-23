#!/usr/bin/env node
/**
 * Stub `gh repo view` and `gh api graphql` for projects discovery tests.
 *
 * GH_STUB_REPO_VIEW_JSON — repo view response
 * GH_STUB_GRAPHQL_REPO_JSON — RepositoryProjects response
 * GH_STUB_GRAPHQL_OWNER_JSON — UserProjects or OrganizationProjects response
 * GH_STUB_OWNER_TYPENAME — User | Organization (default User)
 */
import { readFileSync } from 'node:fs';

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  stdin += c;
});
process.stdin.on('end', () => {
  const argv = process.argv.slice(2);
  if (argv[0] === 'repo' && argv[1] === 'view') {
    const stdout = process.env.GH_STUB_REPO_VIEW_JSON ?? '{}';
    process.stdout.write(stdout, () => process.exit(0));
    return;
  }

  if (argv[0] === 'api' && argv[1] === 'graphql') {
    let query = '';
    try {
      query = JSON.parse(stdin).query ?? '';
    } catch {
      process.stderr.write('invalid stdin json\n');
      process.exit(1);
    }

    let stdout = '{}';
    if (query.includes('RepositoryProjects')) {
      stdout = process.env.GH_STUB_GRAPHQL_REPO_JSON ?? '{}';
    } else if (query.includes('OrganizationProjects')) {
      stdout = process.env.GH_STUB_GRAPHQL_OWNER_JSON ?? '{}';
    } else if (query.includes('UserProjects')) {
      stdout = process.env.GH_STUB_GRAPHQL_OWNER_JSON ?? '{}';
    } else {
      process.stderr.write(`unexpected query: ${query.slice(0, 80)}\n`);
      process.exit(1);
    }

    const stderr = process.env.GH_STUB_STDERR ?? '';
    if (stderr.length > 0) {
      process.stderr.write(stderr);
    }
    const code = Number.parseInt(process.env.GH_STUB_EXIT_CODE ?? '0', 10);
    process.stdout.write(stdout, () => {
      process.exit(Number.isFinite(code) ? code : 0);
    });
    return;
  }

  process.stderr.write('gh-projects-stub: unexpected argv\n');
  process.exit(2);
});
process.stdin.resume();
