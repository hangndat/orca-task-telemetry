import type { DatabaseSync } from 'node:sqlite';
import { aggregateLinkedUsageForIssue } from '../attribution/aggregate.js';
import type { GitHubIssue, ProjectItem } from '../contracts.js';
import {
  readProjectFields,
  readProjectItemNumberFieldValue,
  selectNumberFieldById,
  selectNumberFieldByName,
  type ProjectFieldConfiguration,
} from '../github/fields.js';
import { readProjectItems } from '../github/items.js';
import type { GithubGraphqlOptions } from '../github/client.js';
import { buildHierarchyReport } from '../reports/hierarchy.js';
import {
  findIssueInDatabase,
  listProjectIssues,
  loadCollectionFreshness,
  type ReportContext,
} from '../reports/tasks.js';
import {
  renderTable,
  sanitizeDisplayText,
  type CollectionFreshnessSlice,
  type TableColumn,
} from '../reports/render.js';
import type { RepositoryProfile } from '../profiles.js';
import { usageError } from '../errors.js';

export const WRITEBACK_USD_DECIMALS = 6;

export type WritebackRollup = 'direct' | 'inclusive';

export type WritebackSkipReason =
  | 'unknown_cost'
  | 'no_usage'
  | 'unsupported_item_type'
  | 'remote_conflict'
  | 'unchanged'
  | 'rounds_to_zero'
  | 'missing_project_item';

export type WritebackPreviewItem = {
  issue: GitHubIssue;
  projectItemId: string | null;
  computed: {
    knownAmountUsd: number;
    sessionCount: number;
    rollup: WritebackRollup;
    costLabel: 'estimated_api_equivalent';
  };
  remote: number | null;
  proposed?: number;
  action: 'set' | 'skip';
  skipReason?: WritebackSkipReason;
  precisionWarning?: boolean;
};

export type WritebackPreviewReport = {
  kind: 'writeback_preview';
  mode: 'dry_run';
  project: {
    id: string;
    number: number;
    url: string;
    owner: RepositoryProfile['project']['owner'];
  };
  field: ProjectFieldConfiguration;
  rollup: WritebackRollup;
  freshness: CollectionFreshnessSlice[];
  warnings: string[];
  items: WritebackPreviewItem[];
  summary: {
    wouldSet: number;
    skips: number;
  };
};

export type WritebackPreviewOptions = {
  fieldName?: string;
  fieldId?: string;
  rollup: WritebackRollup;
  issueSelectors?: string[];
  forceOverwrite: boolean;
};

export type WritebackPreviewDeps = {
  readProjectFields: typeof readProjectFields;
  readProjectItems: typeof readProjectItems;
  readProjectItemNumberFieldValue: typeof readProjectItemNumberFieldValue;
  ghPath?: string;
};

const INCLUSIVE_DOUBLE_COUNT_WARNING =
  'Inclusive rollup writes summed descendant usage onto the selected issue field. ' +
  'Do not also write direct rollup to child issues on the same column or project totals may double-count.';

export function roundWritebackUsd(amount: number): number {
  const factor = 10 ** WRITEBACK_USD_DECIMALS;
  return Math.round(amount * factor) / factor;
}

export function formatWritebackUsd(amount: number): string {
  return amount.toFixed(WRITEBACK_USD_DECIMALS);
}

export type WritebackCostInput = {
  knownAmountUsd: number;
  sessionCount: number;
  unknownAmountCount: number;
};

export type WritebackDecision = {
  action: 'set' | 'skip';
  skipReason?: WritebackSkipReason;
  proposed?: number;
  precisionWarning?: boolean;
};

export function decideWritebackAction(
  cost: WritebackCostInput,
  remote: number | null,
  forceOverwrite: boolean,
): WritebackDecision {
  if (cost.unknownAmountCount > 0) {
    return { action: 'skip', skipReason: 'unknown_cost' };
  }
  if (cost.sessionCount === 0) {
    return { action: 'skip', skipReason: 'no_usage' };
  }
  const proposed = roundWritebackUsd(cost.knownAmountUsd);
  if (cost.knownAmountUsd > 0 && proposed === 0) {
    return {
      action: 'skip',
      skipReason: 'rounds_to_zero',
      precisionWarning: true,
    };
  }
  if (remote !== null) {
    const remoteRounded = roundWritebackUsd(remote);
    if (remoteRounded === proposed) {
      return { action: 'skip', skipReason: 'unchanged' };
    }
    if (!forceOverwrite) {
      return { action: 'skip', skipReason: 'remote_conflict', proposed };
    }
  }
  return { action: 'set', proposed };
}

function graphqlOpts(deps: WritebackPreviewDeps): GithubGraphqlOptions {
  return deps.ghPath ? { ghPath: deps.ghPath } : {};
}

function resolveField(
  fields: ProjectFieldConfiguration[],
  options: WritebackPreviewOptions,
): ProjectFieldConfiguration {
  if (options.fieldId) {
    return selectNumberFieldById(fields, options.fieldId);
  }
  if (options.fieldName) {
    return selectNumberFieldByName(fields, options.fieldName);
  }
  throw usageError(
    'Missing --field or --field-id.',
    'Pass a NUMBER custom field from the init profile project.',
  );
}

function resolveScopedIssues(
  db: DatabaseSync,
  profileRepository: string,
  projectId: string,
  selectors: string[] | undefined,
): GitHubIssue[] {
  if (!selectors || selectors.length === 0) {
    return listProjectIssues(db, projectId);
  }
  const issues: GitHubIssue[] = [];
  const seen = new Set<string>();
  for (const selector of selectors) {
    const issue = findIssueInDatabase(db, selector, profileRepository);
    if (!issue) {
      throw usageError(
        `Issue not found in local telemetry data: ${selector}`,
        'Run orca-telemetry collect and ensure the issue is on the profile project.',
      );
    }
    const membership = db
      .prepare(
        `SELECT 1 FROM project_memberships WHERE project_id = ? AND issue_node_id = ? LIMIT 1`,
      )
      .get(projectId, issue.issueNodeId);
    if (!membership) {
      throw usageError(
        `Issue is not a member of the profile project: ${selector}`,
        'Only issues collected for the init project can be written back.',
      );
    }
    if (!seen.has(issue.issueNodeId)) {
      seen.add(issue.issueNodeId);
      issues.push(issue);
    }
  }
  issues.sort(
    (a, b) =>
      a.repository.nameWithOwner.localeCompare(b.repository.nameWithOwner) ||
      a.number - b.number,
  );
  return issues;
}

function directCostForIssue(
  db: DatabaseSync,
  issueNodeId: string,
): WritebackCostInput {
  const rollup = aggregateLinkedUsageForIssue(db, issueNodeId);
  return {
    knownAmountUsd: rollup.cost.knownAmountUsd,
    sessionCount: rollup.sessionKeys.length,
    unknownAmountCount: rollup.cost.unknownAmountCount,
  };
}

function createInclusiveCostResolver(ctx: ReportContext): (issueNodeId: string) => WritebackCostInput {
  let hierarchyReport: ReturnType<typeof buildHierarchyReport> | undefined;
  return (issueNodeId: string) => {
    if (!hierarchyReport) {
      hierarchyReport = buildHierarchyReport(ctx);
    }
    const node = hierarchyReport.nodes.find((n) => n.issue.issueNodeId === issueNodeId);
    if (!node) {
      return { knownAmountUsd: 0, sessionCount: 0, unknownAmountCount: 0 };
    }
    return {
      knownAmountUsd: node.inclusive.cost.knownAmountUsd,
      sessionCount: node.inclusive.sessionCount,
      unknownAmountCount: node.inclusive.cost.unknownAmountCount,
    };
  };
}

function mapIssueItems(projectItems: ProjectItem[]): Map<string, ProjectItem> {
  const byIssueId = new Map<string, ProjectItem>();
  for (const item of projectItems) {
    if (item.contentType === 'Issue' && item.issue) {
      byIssueId.set(item.issue.issueNodeId, item);
    }
  }
  return byIssueId;
}

export function previewItemForUnsupportedType(
  item: ProjectItem,
  rollup: WritebackRollup,
): WritebackPreviewItem | null {
  if (item.contentType === 'Issue' && item.issue) {
    return null;
  }
  const placeholderIssue: GitHubIssue = item.issue ?? {
    issueNodeId: item.itemId,
    repository: { nameWithOwner: 'unknown/unknown' },
    number: 0,
    url: '',
    title: item.contentType,
    state: 'UNKNOWN',
  };
  return {
    issue: placeholderIssue,
    projectItemId: item.itemId,
    computed: {
      knownAmountUsd: 0,
      sessionCount: 0,
      rollup,
      costLabel: 'estimated_api_equivalent',
    },
    remote: null,
    action: 'skip',
    skipReason: 'unsupported_item_type',
  };
}

export async function buildWritebackPreview(
  ctx: ReportContext,
  options: WritebackPreviewOptions,
  deps: WritebackPreviewDeps = {
    readProjectFields,
    readProjectItems,
    readProjectItemNumberFieldValue,
  },
): Promise<WritebackPreviewReport> {
  if (options.rollup === 'inclusive' && (!options.issueSelectors || options.issueSelectors.length === 0)) {
    throw usageError(
      '--rollup inclusive requires at least one --issue.',
      'Pass --issue owner/repo#n (repeat for multiple issues).',
    );
  }

  const projectId = ctx.profile.project.id;
  const gql = graphqlOpts(deps);
  const fields = await deps.readProjectFields(projectId, gql);
  const field = resolveField(fields, options);
  const inclusiveCostForIssue = createInclusiveCostResolver(ctx);
  const projectItems = await deps.readProjectItems(projectId, gql);
  const issueItemById = mapIssueItems(projectItems);

  const scopedIssues = resolveScopedIssues(
    ctx.db,
    ctx.profile.repository.nameWithOwner,
    projectId,
    options.issueSelectors,
  );

  const warnings: string[] = [];
  if (options.rollup === 'inclusive' && options.issueSelectors && options.issueSelectors.length > 0) {
    warnings.push(INCLUSIVE_DOUBLE_COUNT_WARNING);
  }

  const items: WritebackPreviewItem[] = [];

  for (const issue of scopedIssues) {
    const liveItem = issueItemById.get(issue.issueNodeId);
    if (!liveItem) {
      items.push({
        issue,
        projectItemId: null,
        computed: {
          knownAmountUsd: 0,
          sessionCount: 0,
          rollup: options.rollup,
          costLabel: 'estimated_api_equivalent',
        },
        remote: null,
        action: 'skip',
        skipReason: 'missing_project_item',
      });
      continue;
    }

    const cost =
      options.rollup === 'inclusive'
        ? inclusiveCostForIssue(issue.issueNodeId)
        : directCostForIssue(ctx.db, issue.issueNodeId);

    const remote = await deps.readProjectItemNumberFieldValue(
      liveItem.itemId,
      field.id,
      gql,
    );

    const decision = decideWritebackAction(
      cost,
      remote,
      options.forceOverwrite,
    );

    const row: WritebackPreviewItem = {
      issue,
      projectItemId: liveItem.itemId,
      computed: {
        knownAmountUsd: cost.knownAmountUsd,
        sessionCount: cost.sessionCount,
        rollup: options.rollup,
        costLabel: 'estimated_api_equivalent',
      },
      remote,
      action: decision.action,
    };
    if (decision.proposed !== undefined) {
      row.proposed = decision.proposed;
    }
    if (decision.skipReason) {
      row.skipReason = decision.skipReason;
    }
    if (decision.precisionWarning) {
      row.precisionWarning = true;
    }
    items.push(row);
  }

  const outputItemIds = new Set(
    items.map((row) => row.projectItemId).filter((id): id is string => id !== null),
  );
  for (const projectItem of projectItems) {
    if (projectItem.contentType === 'Issue') {
      continue;
    }
    if (outputItemIds.has(projectItem.itemId)) {
      continue;
    }
    const skipRow = previewItemForUnsupportedType(projectItem, options.rollup);
    if (skipRow) {
      items.push(skipRow);
    }
  }

  items.sort((a, b) => {
    const ar = a.issue.repository.nameWithOwner;
    const br = b.issue.repository.nameWithOwner;
    return ar.localeCompare(br) || a.issue.number - b.issue.number;
  });

  const wouldSet = items.filter((i) => i.action === 'set').length;
  const skips = items.length - wouldSet;

  return {
    kind: 'writeback_preview',
    mode: 'dry_run',
    project: {
      id: ctx.profile.project.id,
      number: ctx.profile.project.number,
      url: ctx.profile.project.url,
      owner: ctx.profile.project.owner,
    },
    field,
    rollup: options.rollup,
    freshness: loadCollectionFreshness(ctx.db),
    warnings,
    items,
    summary: { wouldSet, skips },
  };
}

export function formatWritebackPreviewText(report: WritebackPreviewReport): string {
  const ownerLogin = report.project.owner.login;
  const lines = [
    `Writeback preview (dry-run) — ${ownerLogin}/projects/${report.project.number}`,
    `Field: ${sanitizeDisplayText(report.field.name)} (${report.field.id})`,
    `Rollup: ${report.rollup} · estimated API equivalent (USD)`,
    '',
  ];

  for (const warning of report.warnings) {
    lines.push(`Warning: ${warning}`, '');
  }

  if (report.freshness.length > 0) {
    lines.push('Collection freshness:');
    for (const slice of report.freshness) {
      lines.push(
        `  ${slice.source}: ${slice.status} @ ${slice.recordedAt}`,
      );
    }
    lines.push('');
  }

  const columns: TableColumn[] = [
    { key: 'issue', header: 'Issue', width: 22 },
    { key: 'computed', header: 'Computed', width: 14, align: 'right' },
    { key: 'remote', header: 'Remote', width: 14, align: 'right' },
    { key: 'proposed', header: 'Proposed', width: 14, align: 'right' },
    { key: 'action', header: 'Action', width: 18 },
  ];

  const rows = report.items.map((item) => {
    const identity = `${item.issue.repository.nameWithOwner}#${item.issue.number}`;
    const computed =
      item.computed.sessionCount === 0 && item.computed.knownAmountUsd === 0
        ? '—'
        : formatWritebackUsd(roundWritebackUsd(item.computed.knownAmountUsd));
    const remote =
      item.remote === null ? '—' : formatWritebackUsd(roundWritebackUsd(item.remote));
    const proposed =
      item.proposed === undefined ? '—' : formatWritebackUsd(item.proposed);
    const action =
      item.action === 'set'
        ? 'set'
        : `skip (${item.skipReason ?? 'unknown'})`;
    return {
      issue: identity,
      computed,
      remote,
      proposed,
      action,
    };
  });

  lines.push(renderTable(columns, rows).trimEnd());
  lines.push(
    '',
    `Would apply ${report.summary.wouldSet} sets, ${report.summary.skips} skips.`,
  );
  return `${lines.join('\n')}\n`;
}
