import type { GitHubIssue, ProjectItem } from '../contracts.js';
import { attributionEligibility } from './identity.js';

export type ProjectMembership = {
  projectId: string;
  issueNodeId: string;
};

export type ExcludedProjectItem = {
  projectId: string;
  itemId: string;
  reason: string;
};

export type NormalizedProjectMemberships = {
  issues: GitHubIssue[];
  memberships: ProjectMembership[];
  excluded: ExcludedProjectItem[];
};

function membershipKey(projectId: string, issueNodeId: string): string {
  return `${projectId}\u0000${issueNodeId}`;
}

/**
 * Distinct Issues by GitHub node id; many-to-many memberships per project.
 * Non-Issue items are excluded with {@link attributionEligibility} reasons.
 */
export function normalizeProjectMemberships(
  items: ProjectItem[],
): NormalizedProjectMemberships {
  const issuesByNode = new Map<string, GitHubIssue>();
  const membershipSeen = new Set<string>();
  const memberships: ProjectMembership[] = [];
  const excluded: ExcludedProjectItem[] = [];

  for (const item of items) {
    const eligibility = attributionEligibility(item);
    if (!eligibility.eligible) {
      excluded.push({
        projectId: item.projectId,
        itemId: item.itemId,
        reason: eligibility.reason,
      });
      continue;
    }
    if (!item.issue) {
      excluded.push({
        projectId: item.projectId,
        itemId: item.itemId,
        reason: 'missing_issue',
      });
      continue;
    }
    const issue = item.issue;
    const existing = issuesByNode.get(issue.issueNodeId);
    if (existing) {
      if (existing.repository.nameWithOwner !== issue.repository.nameWithOwner) {
        throw new Error(
          `Issue node ${issue.issueNodeId} has conflicting repositories`,
        );
      }
      if (
        existing.parentIssueNodeId !== undefined &&
        issue.parentIssueNodeId !== undefined &&
        existing.parentIssueNodeId !== issue.parentIssueNodeId
      ) {
        throw new Error(
          `Issue node ${issue.issueNodeId} has conflicting parent references`,
        );
      }
    } else {
      issuesByNode.set(issue.issueNodeId, issue);
    }
    const key = membershipKey(item.projectId, issue.issueNodeId);
    if (!membershipSeen.has(key)) {
      membershipSeen.add(key);
      memberships.push({
        projectId: item.projectId,
        issueNodeId: issue.issueNodeId,
      });
    }
  }

  const issues = [...issuesByNode.values()].sort((a, b) =>
    a.issueNodeId.localeCompare(b.issueNodeId),
  );
  memberships.sort((a, b) =>
    membershipKey(a.projectId, a.issueNodeId).localeCompare(
      membershipKey(b.projectId, b.issueNodeId),
    ),
  );
  excluded.sort((a, b) =>
    `${a.projectId}\u0000${a.itemId}`.localeCompare(
      `${b.projectId}\u0000${b.itemId}`,
    ),
  );

  return { issues, memberships, excluded };
}
