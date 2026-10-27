import type { DatabaseSync } from 'node:sqlite';
import { listUnmappedSessions } from './unmapped.js';
import { parseSessionKey } from '../contracts.js';

export type SuggestionConfidence = 'high' | 'ambiguous' | 'none';

export type LinkSuggestion = {
  provider: string;
  rawSessionId: string;
  sessionKey: string;
  projectHint: string | null;
  confidence: SuggestionConfidence;
  candidateIssueNodeIds: string[];
  reason: string;
  status: 'ready' | 'needs_approval' | 'no_match';
};

function normalizeHint(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9/_-]+/g, '');
}

/**
 * Suggest Issue links for unmapped sessions using only the stored agent-top
 * projectHint against Issue repository nameWithOwner / title tokens.
 * Never creates links; high confidence requires exactly one candidate.
 */
export function suggestSessionLinks(
  db: DatabaseSync,
  projectId: string,
): LinkSuggestion[] {
  const issues = db
    .prepare(
      `SELECT i.issue_node_id AS id, i.repository_name_with_owner AS repo, i.title AS title, i.number AS number
       FROM project_memberships pm
       JOIN issues i ON i.issue_node_id = pm.issue_node_id
       WHERE pm.project_id = ?`,
    )
    .all(projectId) as { id: string; repo: string; title: string; number: number }[];

  const unmapped = listUnmappedSessions(db);
  const out: LinkSuggestion[] = [];

  for (const session of unmapped) {
    const parsed = parseSessionKey(session.sessionKey);
    const hint = session.projectHint;
    if (!hint || hint.trim().length === 0) {
      out.push({
        provider: parsed.provider,
        rawSessionId: parsed.rawId,
        sessionKey: session.sessionKey,
        projectHint: hint,
        confidence: 'none',
        candidateIssueNodeIds: [],
        reason: 'missing_project_hint',
        status: 'no_match',
      });
      continue;
    }
    const norm = normalizeHint(hint);
    const candidates = issues.filter((issue) => {
      const repoNorm = normalizeHint(issue.repo);
      const titleNorm = normalizeHint(issue.title);
      return (
        repoNorm === norm ||
        repoNorm.endsWith(`/${norm}`) ||
        norm === repoNorm.split('/')[1] ||
        (norm.length >= 4 && titleNorm.includes(norm))
      );
    });

    if (candidates.length === 1) {
      out.push({
        provider: parsed.provider,
        rawSessionId: parsed.rawId,
        sessionKey: session.sessionKey,
        projectHint: hint,
        confidence: 'high',
        candidateIssueNodeIds: [candidates[0]!.id],
        reason: 'unique_project_hint_match',
        status: 'ready',
      });
    } else if (candidates.length > 1) {
      out.push({
        provider: parsed.provider,
        rawSessionId: parsed.rawId,
        sessionKey: session.sessionKey,
        projectHint: hint,
        confidence: 'ambiguous',
        candidateIssueNodeIds: candidates.map((c) => c.id),
        reason: 'multiple_project_hint_matches',
        status: 'needs_approval',
      });
    } else {
      out.push({
        provider: parsed.provider,
        rawSessionId: parsed.rawId,
        sessionKey: session.sessionKey,
        projectHint: hint,
        confidence: 'none',
        candidateIssueNodeIds: [],
        reason: 'no_project_hint_match',
        status: 'no_match',
      });
    }
  }

  return out;
}
