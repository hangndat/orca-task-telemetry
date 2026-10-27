import type { DatabaseSync } from 'node:sqlite';
import { sessionKey, type GitHubIssue, type UsageProvider } from '../contracts.js';
import { CliError, EXIT_SOURCE_UNAVAILABLE, EXIT_USAGE } from '../errors.js';
import type { PullTraceEvidence } from '../github/pull-trace.js';
import {
  requireManualIssueLink,
  requireManualPullLink,
  storeManualCommitLink,
  storeManualPullLink,
} from '../db/trace.js';

export function traceSessionKey(provider: UsageProvider, rawSessionId: string): string {
  return sessionKey(provider, 'agent-top', rawSessionId);
}

export function assertIssueLink(db: DatabaseSync, key: string, issueNodeId: string): void {
  requireManualIssueLink(db, key, issueNodeId);
}

export function assertPullLink(db: DatabaseSync, key: string, pullNodeId: string): void {
  requireManualPullLink(db, key, pullNodeId);
}

export function requireTraceEvidence(evidence: PullTraceEvidence): void {
  if (evidence.status === 'verified_current' && evidence.pull) return;
  if (evidence.errorCode === 'github_auth_required' || evidence.errorCode === 'github_scope_missing') {
    throw new CliError({
      code: 'trace_auth',
      message: 'GitHub authorization did not allow the pull trace to be verified.',
      hint: 'Check gh auth and repository read access, then retry.',
      exitCode: EXIT_SOURCE_UNAVAILABLE,
    });
  }
  throw new CliError({
    code: 'trace_partial',
    message: 'GitHub pull trace is incomplete or inaccessible; no link was written.',
    hint: 'Retry when the PR and its complete Issue/commit lists are readable.',
    exitCode: EXIT_SOURCE_UNAVAILABLE,
  });
}

export function linkSessionToPull(
  db: DatabaseSync,
  input: { provider: UsageProvider; rawSessionId: string; issue: GitHubIssue; evidence: PullTraceEvidence; linkedAt: string },
) {
  const key = traceSessionKey(input.provider, input.rawSessionId);
  requireTraceEvidence(input.evidence);
  return storeManualPullLink(db, { sessionKey: key, issue: input.issue, evidence: input.evidence, linkedAt: input.linkedAt });
}

export function linkSessionToCommit(
  db: DatabaseSync,
  input: { provider: UsageProvider; rawSessionId: string; oid: string; evidence: PullTraceEvidence; linkedAt: string },
) {
  const key = traceSessionKey(input.provider, input.rawSessionId);
  requireTraceEvidence(input.evidence);
  return storeManualCommitLink(db, { sessionKey: key, oid: input.oid, evidence: input.evidence, linkedAt: input.linkedAt });
}

export function parseFullCommitOid(raw: string): string {
  if (!/^[0-9a-fA-F]{40}$/.test(raw)) {
    throw new CliError({
      code: 'usage_error', message: 'Commit SHA must be a full 40-character Git OID.',
      exitCode: EXIT_USAGE,
    });
  }
  return raw.toLowerCase();
}
