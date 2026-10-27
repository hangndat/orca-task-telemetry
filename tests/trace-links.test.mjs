import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'vitest';
import { openTelemetryDatabase } from '../dist/db/index.js';
import { MIGRATION_V1_STATEMENTS } from '../dist/db/migrations/v1.js';
import { MIGRATION_V2_STATEMENTS } from '../dist/db/migrations/v2.js';
import { refreshStoredPullTrace } from '../dist/db/trace.js';

// Synthetic, redacted GitHub/agent-top fixtures. These are not live integration evidence.
const cli = resolve(dirname(fileURLToPath(import.meta.url)), '../dist/cli.js');
const oid = 'a'.repeat(40);
const otherOid = 'b'.repeat(40);
const issue = {
  id: 'I_1', number: 3, url: 'https://github.com/o/r/issues/3',
  title: 'Synthetic issue', state: 'OPEN', repository: { nameWithOwner: 'o/r' },
};
const pull = {
  id: 'PR_7', number: 7, url: 'https://github.com/o/r/pull/7',
  state: 'OPEN', isDraft: true, mergedAt: null, headRefOid: oid,
  repository: { nameWithOwner: 'o/r' },
};
const issuePage = ids => ({ data: { rateLimit: { remaining: 100, resetAt: '2026-10-24T00:00:00Z' }, node: {
  __typename: 'PullRequest', id: pull.id,
  closingIssuesReferences: { nodes: ids.map(id => ({ id })), pageInfo: { hasNextPage: false, endCursor: null } },
} } });
const commitPage = oids => ({ data: { rateLimit: { remaining: 100, resetAt: '2026-10-24T00:00:00Z' }, node: {
  __typename: 'PullRequest', id: pull.id,
  commits: { nodes: oids.map(oid => ({ commit: { oid, url: `https://github.com/o/r/commit/${oid}` } })), pageInfo: { hasNextPage: false, endCursor: null } },
} } });
const issueStep = node => ({ query: 'ResolveIssue', body: { data: { repository: { issue: node } } } });
const pullSteps = ({ issueIds = ['I_1'], oids = [oid], pr = pull } = {}) => [
  { query: 'ResolveTracePull', body: { data: { repository: { pullRequest: pr } } } },
  { query: 'TracePullIssues', body: issuePage(issueIds) },
  { query: 'TracePullCommits', body: commitPage(oids) },
  { query: 'TracePullNode', body: { data: { node: { __typename: 'PullRequest', ...pr } } } },
];

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'orca-trace-test-'));
  const repo = join(root, 'repo');
  const appHome = join(root, 'home');
  execFileSync('mkdir', ['-p', repo, appHome]);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/o/r.git'], { cwd: repo });
  const dbPath = join(appHome, 'telemetry.sqlite');
  const handle = openTelemetryDatabase({ dbPath, gitRoot: repo });
  handle.db.prepare(
    `INSERT INTO issues (issue_node_id, repository_name_with_owner, number, url, title, state)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(issue.id, 'o/r', 3, issue.url, issue.title, issue.state);
  handle.db.prepare(
    `INSERT INTO usage_sessions (session_key, provider, source, raw_id) VALUES (?, 'codex', 'agent-top', ?)`,
  ).run('codex:agent-top:s1', 's1');
  handle.db.prepare(
    `INSERT INTO usage_snapshots (session_key, observed_at, tokens_json, cost_amount_usd, cost_kind)
     VALUES (?, ?, ?, ?, 'estimated_api_equivalent')`,
  ).run('codex:agent-top:s1', '2026-01-01T00:00:00Z', '{}', 1.23);
  handle.db.prepare(
    `INSERT INTO session_links (session_key, issue_node_id, method, linked_at)
     VALUES (?, ?, 'manual', ?)`,
  ).run('codex:agent-top:s1', issue.id, '2026-01-01T00:00:00Z');
  handle.close();

  const stub = join(root, 'gh-stub.mjs');
  writeFileSync(stub, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
if (process.argv[2] === 'repo' && process.argv[3] === 'view') {
  process.stdout.write(JSON.stringify({id:'R_1',nameWithOwner:'o/r',url:'https://github.com/o/r'}));
  process.exit(0);
}
if (process.argv[2] !== 'api' || process.argv[3] !== 'graphql') process.exit(2);
const request = JSON.parse(readFileSync(0, 'utf8'));
const steps = JSON.parse(process.env.GH_TRACE_STEPS);
const index = Number(readFileSync(process.env.GH_TRACE_COUNTER, 'utf8'));
writeFileSync(process.env.GH_TRACE_COUNTER, String(index + 1));
const step = steps[index];
if (!step || !request.query.includes(step.query)) process.exit(3);
process.stdout.write(JSON.stringify(step.body));
process.exit(step.exitCode ?? 0);
`);
  chmodSync(stub, 0o755);
  const counter = join(root, 'counter');
  return { root, repo, appHome, dbPath, stub, counter };
}

function run(fixture, steps, ...args) {
  writeFileSync(fixture.counter, '0');
  return spawnSync(process.execPath, [cli, 'trace', ...args], {
    cwd: fixture.repo, encoding: 'utf8',
    env: { ...process.env, ORCA_TELEMETRY_HOME: fixture.appHome,
      ORCA_TELEMETRY_GH: fixture.stub, GH_TRACE_STEPS: JSON.stringify(steps),
      GH_TRACE_COUNTER: fixture.counter },
  });
}

function rows(fixture, sql) {
  const db = new DatabaseSync(fixture.dbPath, { readOnly: true });
  try { return db.prepare(sql).all(); } finally { db.close(); }
}

const prArgs = ['link-pr', '--issue', 'https://github.com/o/r/issues/3', '--pr', 'o/r#7', '--provider', 'codex', '--session', 's1', '--json'];
const commitArgs = ['link-commit', '--pr', 'o/r#7', '--sha', oid.toUpperCase(), '--provider', 'codex', '--session', 's1', '--json'];

test('manual Issue→PR→commit CLI links are durable, idempotent, and leave usage cost untouched', () => {
  const fixture = setup();
  try {
    const first = run(fixture, [issueStep(issue), ...pullSteps()], ...prArgs);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(JSON.parse(first.stdout).data.outcome, 'created');
    const firstLink = rows(fixture, 'SELECT * FROM session_pull_links')[0];
    const again = run(fixture, [issueStep(issue), ...pullSteps()], ...prArgs);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(JSON.parse(again.stdout).data.outcome, 'already_linked');
    assert.deepEqual(rows(fixture, 'SELECT * FROM session_pull_links')[0], firstLink);

    const commit = run(fixture, pullSteps(), ...commitArgs);
    assert.equal(commit.status, 0, commit.stderr);
    assert.equal(JSON.parse(commit.stdout).data.link.oid, oid);
    const againCommit = run(fixture, pullSteps(), ...commitArgs);
    assert.equal(JSON.parse(againCommit.stdout).data.outcome, 'already_linked');
    assert.equal(rows(fixture, 'SELECT * FROM session_commit_links').length, 1);
    assert.equal(rows(fixture, 'SELECT cost_amount_usd FROM usage_snapshots')[0].cost_amount_usd, 1.23);
    assert.equal(rows(fixture, 'SELECT status FROM issue_pull_relations')[0].status, 'verified_current');
    assert.equal(rows(fixture, 'SELECT status FROM pull_commits')[0].status, 'verified_current');
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('wrong Issue, PR, and commit relations reject without partial link rows', () => {
  const fixture = setup();
  try {
    const wrongIssue = run(fixture, [issueStep(issue), ...pullSteps({ issueIds: ['I_other'] })], ...prArgs);
    assert.equal(JSON.parse(wrongIssue.stdout).error.code, 'issue_pr_unverified');
    const wrongIssueText = run(fixture, [issueStep(issue), ...pullSteps({ issueIds: ['I_other'] })], ...prArgs.filter(x => x !== '--json'));
    assert.equal(wrongIssueText.status, 2);
    assert.match(wrongIssueText.stderr, /closingIssuesReferences/);
    assert.equal(rows(fixture, 'SELECT * FROM pull_requests').length, 0);
    const issueAsPr = run(fixture, [issueStep(issue),
      { query: 'ResolveTracePull', body: { data: { repository: { pullRequest: null } } } },
      { query: 'TracePullIssueKind', body: { data: { repository: { issue: issue } } } },
    ], ...prArgs);
    assert.equal(JSON.parse(issueAsPr.stdout).error.code, 'not_pull_request');
    assert.equal(run(fixture, [], ...prArgs.map(x => x === 'https://github.com/o/r/issues/3' ? 'https://github.com/o/r/pull/3' : x)).status, 2);
    assert.equal(run(fixture, [issueStep(issue), ...pullSteps()], ...prArgs).status, 0);
    const wrongCommit = run(fixture, pullSteps({ oids: [otherOid] }), ...commitArgs);
    assert.equal(JSON.parse(wrongCommit.stdout).error.code, 'commit_pr_unverified');
    assert.equal(rows(fixture, 'SELECT * FROM session_commit_links').length, 0);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('partial, private/inaccessible, and rate error evidence never creates a link', () => {
  const fixture = setup();
  try {
    const cases = [
      [issueStep(issue), { query: 'ResolveTracePull', body: { data: { repository: null } } }],
      [issueStep(issue), pullSteps()[0], { query: 'TracePullIssues', body: { errors: [{ type: 'RATE_LIMITED', message: 'rate limit' }] }, exitCode: 1 }],
      [issueStep(issue), pullSteps()[0], { query: 'TracePullIssues', body: { data: { node: { id: pull.id } }, errors: [{ type: 'FORBIDDEN', message: 'private' }] }, exitCode: 1 }],
    ];
    for (const steps of cases) {
      const result = run(fixture, steps, ...prArgs);
      assert.equal(result.status, 4);
      assert.equal(JSON.parse(result.stdout).error.code, 'trace_partial');
      assert.equal(rows(fixture, 'SELECT * FROM session_pull_links').length, 0);
    }
    const scope = run(fixture, [issueStep(issue), pullSteps()[0],
      { query: 'TracePullIssues', body: { errors: [{ message: 'read:project scope required', extensions: { type: 'INSUFFICIENT_SCOPES' } }] } },
    ], ...prArgs);
    assert.equal(scope.status, 4);
    assert.equal(JSON.parse(scope.stdout).error.code, 'trace_auth');
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('manual multi-PR links are explicit; cross-repo Issue identity and session chain are enforced', () => {
  const fixture = setup();
  try {
    assert.equal(run(fixture, [issueStep(issue), ...pullSteps()], ...prArgs).status, 0);
    const second = { ...pull, id: 'PR_8', number: 8, url: 'https://github.com/o/r/pull/8' };
    const secondArgs = prArgs.map(x => x === 'o/r#7' ? 'o/r#8' : x);
    const secondSteps = [issueStep(issue), ...pullSteps({ pr: second })];
    secondSteps[2].body.data.node.id = second.id;
    secondSteps[3].body.data.node.id = second.id;
    assert.equal(run(fixture, secondSteps, ...secondArgs).status, 0);
    assert.equal(rows(fixture, 'SELECT * FROM session_pull_links').length, 2);

    const sameNumberOtherNode = { ...issue, id: 'I_foreign', repository: { nameWithOwner: 'foreign/r' } };
    const conflicting = run(fixture, [issueStep(sameNumberOtherNode), ...pullSteps({ issueIds: ['I_foreign'] })], ...prArgs);
    assert.equal(JSON.parse(conflicting.stdout).error.code, 'trace_conflict');
    assert.equal(rows(fixture, 'SELECT * FROM session_pull_links').length, 2);
    const db = new DatabaseSync(fixture.dbPath);
    db.exec('PRAGMA foreign_keys = ON');
    try {
      db.prepare(`INSERT INTO issues (issue_node_id, repository_name_with_owner, number, url, title, state)
        VALUES ('I_foreign', 'foreign/r', 3, 'https://github.com/foreign/r/issues/3', 'x', 'OPEN')`).run();
      db.prepare(`INSERT INTO issue_pull_relations (issue_node_id, pull_node_id, status, source, last_verified_at)
        VALUES ('I_foreign', 'PR_7', 'verified_current', 'closingIssuesReferences', '2026-10-24T00:00:00Z')`).run();
      assert.throws(() => db.prepare(`INSERT INTO session_pull_links
        (session_key, issue_node_id, pull_node_id, method, linked_at)
        VALUES ('codex:agent-top:s1', 'I_foreign', 'PR_7', 'manual', '2026-10-24T00:00:00Z')`).run());
    } finally { db.close(); }
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('commit linking requires the prior manual PR link; unknown sessions and invalid OIDs fail cleanly', () => {
  const fixture = setup();
  try {
    const withoutPr = run(fixture, pullSteps(), ...commitArgs);
    assert.equal(withoutPr.status, 2);
    assert.equal(JSON.parse(withoutPr.stdout).error.code, 'trace_conflict');
    assert.equal(rows(fixture, 'SELECT * FROM pull_requests').length, 0);
    const unknownSession = run(fixture, [issueStep(issue)], ...prArgs.map(x => x === 's1' ? 's2' : x));
    assert.equal(JSON.parse(unknownSession.stdout).error.code, 'attribution_session_unknown');
    const shortOid = run(fixture, [], ...commitArgs.map(x => x === oid.toUpperCase() ? oid.slice(0, 8) : x));
    assert.equal(JSON.parse(shortOid.stdout).error.code, 'usage_error');
    assert.equal(rows(fixture, 'SELECT * FROM session_commit_links').length, 0);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('refresh of unknown and stale evidence retains manual audit links and last successful verification', () => {
  const fixture = setup();
  try {
    assert.equal(run(fixture, [issueStep(issue), ...pullSteps()], ...prArgs).status, 0);
    assert.equal(run(fixture, pullSteps(), ...commitArgs).status, 0);
    const db = new DatabaseSync(fixture.dbPath);
    db.exec('PRAGMA foreign_keys = ON');
    try {
      const before = rows(fixture, 'SELECT last_verified_at FROM issue_pull_relations')[0].last_verified_at;
      const unknown = { pull: null, observedAt: '2026-10-25T00:00:00Z', status: 'unknown',
        closingIssueNodeIds: null, commits: null, issueRelations: {}, commitRelations: {}, errorCode: 'trace_partial' };
      refreshStoredPullTrace(db, pull.id, unknown);
      assert.equal(rows(fixture, 'SELECT last_verified_at FROM issue_pull_relations')[0].last_verified_at, before);
      assert.equal(rows(fixture, 'SELECT status FROM issue_pull_relations')[0].status, 'unknown');
      const stale = { ...unknown, pull: { ...pull, pullNodeId: pull.id },
        observedAt: '2026-10-26T00:00:00Z', status: 'verified_current',
        closingIssueNodeIds: [], commits: [], errorCode: null };
      refreshStoredPullTrace(db, pull.id, stale);
      assert.equal(rows(fixture, 'SELECT status FROM issue_pull_relations')[0].status, 'stale');
      assert.equal(rows(fixture, 'SELECT status FROM pull_commits')[0].status, 'stale');
      assert.equal(rows(fixture, 'SELECT * FROM session_pull_links').length, 1);
      assert.equal(rows(fixture, 'SELECT * FROM session_commit_links').length, 1);
      assert.equal(rows(fixture, 'SELECT cost_amount_usd FROM usage_snapshots')[0].cost_amount_usd, 1.23);
    } finally { db.close(); }
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('a later successful link read refreshes other stored relations without removing audit links', () => {
  const fixture = setup();
  try {
    assert.equal(run(fixture, [issueStep(issue), ...pullSteps()], ...prArgs).status, 0);
    assert.equal(run(fixture, pullSteps(), ...commitArgs).status, 0);
    const later = run(fixture, [issueStep(issue), ...pullSteps({ oids: [] })], ...prArgs);
    assert.equal(later.status, 0, later.stderr);
    assert.equal(JSON.parse(later.stdout).data.outcome, 'already_linked');
    assert.equal(rows(fixture, 'SELECT status FROM pull_commits')[0].status, 'stale');
    assert.equal(rows(fixture, 'SELECT * FROM session_commit_links').length, 1);
    const laterCommit = run(fixture, pullSteps({ issueIds: [] }), ...commitArgs);
    assert.equal(laterCommit.status, 0, laterCommit.stderr);
    assert.equal(rows(fixture, 'SELECT status FROM issue_pull_relations')[0].status, 'stale');
    assert.equal(rows(fixture, 'SELECT status FROM pull_commits')[0].status, 'verified_current');
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('schema migrates from v1 and v2 through agent-top+V1.4; issues remain, CodeBurn usage links dropped', () => {
  for (const version of [1, 2]) {
    const root = mkdtempSync(join(tmpdir(), `orca-trace-v${version}-`));
    const dbPath = join(root, 'legacy.sqlite');
    const db = new DatabaseSync(dbPath);
    for (const statement of MIGRATION_V1_STATEMENTS) db.exec(statement);
    if (version === 2) for (const statement of MIGRATION_V2_STATEMENTS) db.exec(statement);
    db.exec(`PRAGMA user_version = ${version}`);
    db.prepare(`INSERT INTO issues (issue_node_id, repository_name_with_owner, number, url, title, state)
      VALUES ('I_old', 'o/r', 1, 'https://github.com/o/r/issues/1', 'old', 'OPEN')`).run();
    db.prepare(`INSERT INTO usage_sessions (session_key, provider, source, raw_id)
      VALUES ('codex:codeburn:old', 'codex', 'codeburn', 'old')`).run();
    db.prepare(`INSERT INTO session_links (session_key, issue_node_id, method, linked_at)
      VALUES ('codex:codeburn:old', 'I_old', 'manual', '2026-01-01T00:00:00Z')`).run();
    db.close();
    const migrated = openTelemetryDatabase({ dbPath });
    try {
      assert.equal(migrated.db.prepare('PRAGMA user_version').get().user_version, 7);
      assert.equal(migrated.db.prepare('SELECT COUNT(*) AS n FROM session_links').get().n, 0);
      assert.equal(migrated.db.prepare('SELECT COUNT(*) AS n FROM issues').get().n, 1);
      assert.equal(migrated.db.prepare('PRAGMA foreign_key_check').all().length, 0);
    } finally { migrated.close(); rmSync(root, { recursive: true, force: true }); }
  }
});
