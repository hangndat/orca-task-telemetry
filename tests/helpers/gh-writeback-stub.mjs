#!/usr/bin/env node
/** Fixture-only gh stub for a single Project NUMBER field; never calls GitHub. */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const statePath = process.env.GH_WRITEBACK_STATE_PATH;
const logPath = process.env.GH_WRITEBACK_LOG_PATH;
if (!statePath || !logPath) process.exit(90);
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
const log = (kind) => appendFileSync(logPath, `${JSON.stringify({ kind, argv })}\n`);

if (argv[0] === 'auth' && argv[1] === 'status') {
  log('auth');
  const mode = process.env.GH_WRITEBACK_AUTH ?? 'project';
  if (mode === 'ignore-term') {
    process.on('SIGTERM', () => {});
    setTimeout(() => process.exit(0), 16_000);
  } else if (mode === 'unknown') {
    process.stdout.write('{invalid json');
  } else {
    const accounts = mode === 'unauthenticated' ? [] : [{
      active: true,
      state: 'success',
      scopes: mode === 'read' || mode === 'inactive-project' ? 'repo, read:project' : 'repo, read:project, project',
      tokenSource: 'keyring',
    }];
    if (mode === 'inactive-project') {
      accounts.push({ active: false, state: 'success', scopes: 'repo, project', tokenSource: 'keyring' });
    }
    process.stdout.write(JSON.stringify({ hosts: { 'github.com': accounts } }));
  }
} else if (argv[0] === 'repo' && argv[1] === 'view') {
  process.stdout.write(JSON.stringify({
    id: 'R_reports',
    nameWithOwner: 'org-a/repo',
    url: 'https://github.com/org-a/repo',
  }));
} else if (argv[0] === 'api' && argv[1] === 'graphql') {
  let body = '';
  for await (const chunk of process.stdin) body += chunk;
  const { query } = JSON.parse(body);
  if (query.includes('query ProjectFields(')) {
    log('fields');
    process.stdout.write(JSON.stringify({ data: { node: {
      id: 'PVT_attr_synthetic_project',
      fields: {
        totalCount: 1,
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [{ id: 'PVTF_cost', name: 'Estimated cost', dataType: 'NUMBER' }],
      },
    } } }));
  } else if (query.includes('query ProjectItems(')) {
    log('items');
    process.stdout.write(JSON.stringify({ data: { node: {
      id: 'PVT_attr_synthetic_project',
      items: {
        totalCount: 1,
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [{
          id: 'PVTI_alpha',
          type: 'ISSUE',
          content: {
            __typename: 'Issue',
            id: 'I_attr_issue_alpha',
            number: 1,
            title: 'Alpha',
            url: 'https://github.com/org-a/repo/issues/1',
            state: 'OPEN',
            parent: null,
            repository: { nameWithOwner: 'org-a/repo' },
          },
          fieldValues: { nodes: [] },
        }],
      },
    } } }));
  } else if (query.includes('query ProjectItemFieldValues(')) {
    log('remote');
    const nodes = state.remote === undefined ? [] : [{
      __typename: 'ProjectV2ItemFieldNumberValue',
      number: state.remote,
      field: { id: 'PVTF_cost' },
    }];
    process.stdout.write(JSON.stringify({ data: { node: {
      id: 'PVTI_alpha',
      fieldValues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes },
    } } }));
  } else {
    process.stderr.write('unexpected GraphQL query\n');
    process.exitCode = 91;
  }
} else if (argv[0] === 'project' && argv[1] === 'item-edit') {
  log('item-edit');
  if (process.env.GH_WRITEBACK_FAIL === 'scope') {
    process.stderr.write('HTTP 403: insufficient_scopes ghp_SUPERSECRET123\n');
    process.exitCode = 1;
  } else {
    const value = Number(argv[argv.indexOf('--number') + 1]);
    state.remote = value;
    writeFileSync(statePath, JSON.stringify(state));
  }
} else {
  process.stderr.write('unexpected gh argv\n');
  process.exitCode = 92;
}
