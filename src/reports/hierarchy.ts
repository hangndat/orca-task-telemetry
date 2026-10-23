import { aggregateLinkedUsageForProject, type CostRollup } from '../attribution/aggregate.js';
import { dbError } from '../db/errors.js';
import type { GitHubIssue } from '../contracts.js';
import { formatUsd, sanitizeDisplayText, type CollectionFreshnessSlice } from './render.js';
import { listProjectIssues, loadCollectionFreshness, type ReportContext } from './tasks.js';

export type HierarchyCostSummary = {
  sessionCount: number;
  cost: CostRollup;
};

export type HierarchyIssueNode = {
  issue: GitHubIssue;
  depth: number;
  parentIssueNodeId: string | null;
  parentStatus: 'none' | 'in_project' | 'outside_project';
  /** Present when `parentStatus` is `outside_project` (AC3 JSON contract). */
  outsideProjectParentIssueNodeId?: string;
  direct: HierarchyCostSummary;
  inclusive: HierarchyCostSummary;
};

export type HierarchyReport = {
  kind: 'hierarchy';
  projectId: string;
  repository: string;
  freshness: CollectionFreshnessSlice[];
  projectTotals: HierarchyCostSummary;
  nodes: HierarchyIssueNode[];
};

type ParentRow = {
  issue_node_id: string;
  parent_issue_node_id: string | null;
  parent_issue_observed: number;
};

type WorkingNode = {
  issue: GitHubIssue;
  parentIssueNodeId: string | null;
  parentStatus: HierarchyIssueNode['parentStatus'];
  children: WorkingNode[];
};

function emptySummary(): HierarchyCostSummary {
  return {
    sessionCount: 0,
    cost: { knownAmountUsd: 0, knownEstimatedCount: 0, unknownAmountCount: 0 },
  };
}

function addSummary(target: HierarchyCostSummary, part: HierarchyCostSummary): void {
  target.sessionCount += part.sessionCount;
  target.cost.knownAmountUsd += part.cost.knownAmountUsd;
  target.cost.knownEstimatedCount += part.cost.knownEstimatedCount;
  target.cost.unknownAmountCount += part.cost.unknownAmountCount;
}

function sortIssue(a: WorkingNode, b: WorkingNode): number {
  return (
    a.issue.repository.nameWithOwner.localeCompare(b.issue.repository.nameWithOwner) ||
    a.issue.number - b.issue.number ||
    a.issue.issueNodeId.localeCompare(b.issue.issueNodeId)
  );
}

/** Roll up one Project snapshot only; out-of-Project parents remain visible boundaries. */
export function buildHierarchyReport(ctx: ReportContext): HierarchyReport {
  const projectId = ctx.profile.project.id;
  const issues = listProjectIssues(ctx.db, projectId);
  const rollup = aggregateLinkedUsageForProject(ctx.db, projectId);
  const parents = ctx.db.prepare(
    `SELECT i.issue_node_id, i.parent_issue_node_id, i.parent_issue_observed
     FROM project_memberships pm
     INNER JOIN issues i ON i.issue_node_id = pm.issue_node_id
     WHERE pm.project_id = ?`,
  ).all(projectId) as ParentRow[];
  const parentById = new Map(parents.map((row) => [row.issue_node_id, row]));
  const usageById = new Map(rollup.issues.map((issue) => [issue.issueNodeId, issue]));
  const byId = new Map<string, WorkingNode>();

  for (const issue of issues) {
    const parent = parentById.get(issue.issueNodeId);
    if (!parent || parent.parent_issue_observed !== 1) {
      throw dbError(
        'Issue hierarchy has not been collected for every Issue in this Project.',
        'Run orca-telemetry collect, then retry report hierarchy.',
      );
    }
    byId.set(issue.issueNodeId, {
      issue,
      parentIssueNodeId: parent.parent_issue_node_id,
      parentStatus: 'none',
      children: [],
    });
  }

  const roots: WorkingNode[] = [];
  for (const node of byId.values()) {
    const parentId = node.parentIssueNodeId;
    const parent = parentId === null ? undefined : byId.get(parentId);
    if (parent) {
      node.parentStatus = 'in_project';
      parent.children.push(node);
    } else {
      node.parentStatus = parentId === null ? 'none' : 'outside_project';
      roots.push(node);
    }
  }
  roots.sort(sortIssue);
  for (const node of byId.values()) node.children.sort(sortIssue);

  const nodes: HierarchyIssueNode[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();
  function visit(node: WorkingNode, depth: number): HierarchyCostSummary {
    const id = node.issue.issueNodeId;
    if (visiting.has(id) || visited.has(id)) {
      throw dbError('Issue hierarchy cycle detected in local telemetry data.');
    }
    visiting.add(id);
    const directRollup = usageById.get(id);
    const direct: HierarchyCostSummary = directRollup
      ? { sessionCount: directRollup.sessionKeys.length, cost: { ...directRollup.cost } }
      : emptySummary();
    const inclusive: HierarchyCostSummary = {
      sessionCount: direct.sessionCount,
      cost: { ...direct.cost },
    };
    const output: HierarchyIssueNode = {
      issue: node.issue,
      depth,
      parentIssueNodeId: node.parentIssueNodeId,
      parentStatus: node.parentStatus,
      direct,
      inclusive,
    };
    if (node.parentStatus === 'outside_project' && node.parentIssueNodeId !== null) {
      output.outsideProjectParentIssueNodeId = node.parentIssueNodeId;
    }
    nodes.push(output);
    for (const child of node.children) addSummary(inclusive, visit(child, depth + 1));
    visiting.delete(id);
    visited.add(id);
    return inclusive;
  }
  for (const root of roots) visit(root, 0);
  if (visited.size !== byId.size) {
    throw dbError('Issue hierarchy cycle detected in local telemetry data.');
  }

  return {
    kind: 'hierarchy',
    projectId,
    repository: ctx.profile.repository.nameWithOwner,
    freshness: loadCollectionFreshness(ctx.db),
    projectTotals: { sessionCount: rollup.sessionKeys.length, cost: rollup.cost },
    nodes,
  };
}

function costText(summary: HierarchyCostSummary): string {
  return `${formatUsd(summary.cost.knownAmountUsd)}; unknown=${summary.cost.unknownAmountCount}; sessions=${summary.sessionCount}`;
}

export function formatHierarchyReportText(report: HierarchyReport): string {
  const lines = [
    `Hierarchy report — ${report.projectId}`,
    `Repository: ${report.repository}`,
    `Project totals (linked, est. API-equiv): ${costText(report.projectTotals)}`,
    'Unmapped sessions are excluded.',
    '',
  ];
  if (report.nodes.length === 0) lines.push('(no Issues in this Project)');
  for (const node of report.nodes) {
    const indent = '  '.repeat(node.depth);
    const outside = node.parentStatus === 'outside_project'
      ? ` [parent outside Project: ${sanitizeDisplayText(node.parentIssueNodeId ?? '')}]`
      : '';
    const issueIdentity = `${sanitizeDisplayText(node.issue.repository.nameWithOwner)}#${node.issue.number}`;
    lines.push(
      `${indent}${issueIdentity} ${sanitizeDisplayText(node.issue.title)}${outside}`,
      `${indent}  direct: ${costText(node.direct)} | inclusive: ${costText(node.inclusive)}`,
    );
  }
  return `${lines.join('\n')}\n`;
}
