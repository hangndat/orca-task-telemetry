import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { emptyConfig, saveConfig } from '../dist/config.js';
import { upsertProfile } from '../dist/profiles.js';
import { at, oidA, setupTraceDb } from './helpers/trace-slice3-harness.mjs';

// Local package install and synthetic/redacted GitHub responses; no live integration claim.
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('installed package executes trace collect and report trace JSON/text outside source', () => {
  const fixture = setupTraceDb();
  const pack = mkdtempSync(join(tmpdir(), 'orca-trace-pack-'));
  const prefix = mkdtempSync(join(tmpdir(), 'orca-trace-install-'));
  try {
    const { config } = upsertProfile(emptyConfig(),
      { id: 'R_1', nameWithOwner: 'o/r', url: 'https://github.com/o/r' },
      { id: 'P_1', number: 1, title: 'Synthetic',
        url: 'https://github.com/users/o/projects/1', closed: false,
        owner: { kind: 'user', login: 'o' }, sources: ['repository'] });
    saveConfig(fixture.home, config);
    const stub = join(fixture.home, 'gh-stub.mjs');
    writeFileSync(stub, `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
if (process.env.GH_DENY_ALL === '1') process.exit(7);
if (process.argv[2] === 'repo' && process.argv[3] === 'view') {
  if (process.env.GH_DENY_REPO_VIEW === '1') process.exit(7);
  process.stdout.write(JSON.stringify({id:'R_1',nameWithOwner:'o/r',url:'https://github.com/o/r'}));
  process.exit(0);
}
if (process.argv[2] !== 'api' || process.argv[3] !== 'graphql') process.exit(2);
const request = JSON.parse(readFileSync(0, 'utf8'));
const id = request.variables.id;
const number = Number(id.slice(3));
const pull = {__typename:'PullRequest',id,number,url:'https://github.com/o/r/pull/'+number,
  state:'OPEN',isDraft:true,mergedAt:null,headRefOid:'${oidA}',repository:{nameWithOwner:'o/r'}};
let body;
if (request.query.includes('TracePullIssues')) body = {data:{rateLimit:{remaining:100,resetAt:'${at}'},node:{__typename:'PullRequest',id,
  closingIssuesReferences:{nodes:[{id:'I_1'}],pageInfo:{hasNextPage:false,endCursor:null}}}}};
else if (request.query.includes('TracePullCommits')) body = {data:{rateLimit:{remaining:100,resetAt:'${at}'},node:{__typename:'PullRequest',id,
  commits:{nodes:[{commit:{oid:'${oidA}',url:'https://github.com/o/r/commit/${oidA}'}}],pageInfo:{hasNextPage:false,endCursor:null}}}}};
else if (request.query.includes('TracePullNode')) body = {data:{node:pull}};
else process.exit(3);
process.stdout.write(JSON.stringify(body));
`);
    chmodSync(stub, 0o755);
    execFileSync('pnpm', ['pack', '--pack-destination', pack], { cwd: packageRoot, stdio: 'pipe' });
    const tarball = join(pack, readdirSync(pack).find(name => name.endsWith('.tgz')));
    execFileSync('npm', ['install', tarball, '--prefix', prefix, '--omit=dev', '--ignore-scripts', '--no-fund', '--no-audit'], { stdio: 'pipe' });
    const bin = join(prefix, 'node_modules', '.bin', 'orca-telemetry');
    const env = { ...process.env, ORCA_TELEMETRY_HOME: fixture.home, ORCA_TELEMETRY_GH: stub };
    const run = (args, extraEnv = {}) => spawnSync(bin, args,
      { cwd: fixture.repo, env: { ...env, ...extraEnv }, encoding: 'utf8' });
    const before = run(['report', 'trace', '3', '--json'], { GH_DENY_ALL: '1' });
    assert.equal(before.status, 0, before.stderr);
    assert.equal(JSON.parse(before.stdout).data.issueUsage.sessionCount, 3);
    const collected = run(['trace', 'collect', '--json']);
    assert.equal(collected.status, 0, collected.stderr);
    assert.equal(JSON.parse(collected.stdout).data.verifiedCount, 2);
    const text = run(['report', 'trace', '3'], { GH_DENY_ALL: '1' });
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /Trace report/);
    assert.match(run(['trace', '--help']).stdout, /trace collect/);
  } finally {
    fixture.close();
    rmSync(pack, { recursive: true, force: true });
    rmSync(prefix, { recursive: true, force: true });
  }
}, 60_000);
