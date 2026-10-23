import { parseArgs } from 'node:util';
import {
  assertIssueLink,
  assertPullLink,
  linkSessionToCommit,
  linkSessionToPull,
  parseFullCommitOid,
  requireTraceEvidence,
  traceSessionKey,
} from '../attribution/trace.js';
import { USAGE_PROVIDERS, type UsageProvider } from '../contracts.js';
import { openTelemetryDatabase } from '../db/index.js';
import { usageError } from '../errors.js';
import { parseIssueRef, resolveIssue } from '../github/identity.js';
import { parsePullRef, readPullTrace } from '../github/pull-trace.js';
import { createDefaultPathEnv, resolveAppPaths } from '../paths.js';
import { resolveRepository } from '../repo.js';
import type { RouteResult } from './router.js';

type TraceCommandOptions = { json: boolean; cwd: string };

function parseLinkArgs(kind: 'link-pr' | 'link-commit', rest: string[]) {
  let parsed: { values: {
    issue?: string; pr?: string; sha?: string; provider?: string; session?: string;
  } };
  try {
    parsed = parseArgs({
      args: rest,
      options: {
        issue: { type: 'string' }, pr: { type: 'string' },
        sha: { type: 'string' }, provider: { type: 'string' }, session: { type: 'string' },
      },
      allowPositionals: false,
      strict: true,
    });
  } catch {
    throw usageError(`Invalid options for trace ${kind}.`, 'Run orca-telemetry trace --help.');
  }
  const { issue, pr, sha, provider, session } = parsed.values;
  if (!pr) throw usageError('Missing --pr.', `Run orca-telemetry trace ${kind} --help.`);
  if (!provider || !(USAGE_PROVIDERS as readonly string[]).includes(provider)) {
    throw usageError('Invalid or missing --provider.', 'Use --provider claude or codex.');
  }
  if (!session) throw usageError('Missing --session.', 'Pass the CodeBurn provider session ID.');
  if (kind === 'link-pr' && (!issue || sha)) {
    throw usageError('link-pr requires --issue and does not accept --sha.');
  }
  if (kind === 'link-commit' && (!sha || issue)) {
    throw usageError('link-commit requires --sha and does not accept --issue.');
  }
  return {
    issue, pr, sha, provider: provider as UsageProvider, session,
  };
}

export async function runTrace(rest: string[], options: TraceCommandOptions): Promise<RouteResult> {
  const [subcommand, ...subRest] = rest;
  if (subcommand !== 'link-pr' && subcommand !== 'link-commit') {
    throw usageError(
      subcommand ? `Unknown trace subcommand: ${subcommand}.` : 'Missing trace subcommand.',
      'Available: trace link-pr, trace link-commit.',
    );
  }
  const args = parseLinkArgs(subcommand, subRest);
  const pullRef = parsePullRef(args.pr);
  const issue = subcommand === 'link-pr' ? await resolveIssue(parseIssueRef(args.issue!)) : null;
  const paths = resolveAppPaths(createDefaultPathEnv());
  const resolved = await resolveRepository(options.cwd);
  const handle = openTelemetryDatabase({ dbPath: paths.dbPath, gitRoot: resolved.gitRoot });
  try {
    const key = traceSessionKey(args.provider, args.session);
    if (issue) assertIssueLink(handle.db, key, issue.issueNodeId);
    const oid = subcommand === 'link-commit' ? parseFullCommitOid(args.sha!) : null;
    const evidence = await readPullTrace(pullRef, {
      issueNodeIds: issue ? [issue.issueNodeId] : [],
      commitOids: oid ? [oid] : [],
    });
    requireTraceEvidence(evidence);
    if (oid) {
      assertPullLink(handle.db, key, evidence.pull!.pullNodeId);
    }
    const linkedAt = new Date().toISOString();
    const result = issue
      ? linkSessionToPull(handle.db, {
        provider: args.provider, rawSessionId: args.session, issue, evidence, linkedAt,
      })
      : linkSessionToCommit(handle.db, {
        provider: args.provider, rawSessionId: args.session, oid: oid!, evidence, linkedAt,
      });
    const data = {
      outcome: result.outcome,
      link: result.link,
      pullRequest: evidence.pull,
      relation: issue ? evidence.issueRelations[issue.issueNodeId] : evidence.commitRelations[oid!],
      observedAt: evidence.observedAt,
    };
    if (options.json) return { kind: 'ok', data };
    return {
      kind: 'text',
      write: () => process.stdout.write(
        `Trace ${subcommand} ${result.outcome}: ${key} → ${evidence.pull!.url}${oid ? ` @ ${oid}` : ''}\n`,
      ),
    };
  } finally {
    handle.close();
  }
}
