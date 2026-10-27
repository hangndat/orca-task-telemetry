import { CliError, EXIT_USAGE } from '../errors.js';
import { buildHierarchyReport } from './hierarchy.js';
import type { ReportContext } from './tasks.js';
import { formatUsd, sanitizeDisplayText } from './render.js';

export type BudgetWarning = {
  issueNodeId: string;
  repositoryNameWithOwner: string;
  number: number;
  title: string;
  rollup: 'direct' | 'inclusive';
  knownCostUsd: number;
  limitUsd: number;
  overByUsd: number;
  status: 'ok' | 'over';
};

export type BudgetReport = {
  kind: 'budget';
  projectId: string;
  repository: string;
  limitUsd: number;
  rollup: 'direct' | 'inclusive';
  warnings: BudgetWarning[];
  totals: { checked: number; overCount: number };
};

export function buildBudgetReport(
  ctx: ReportContext,
  options: { limitUsd: number; issueArg?: string; rollup: 'direct' | 'inclusive' },
): BudgetReport {
  if (!(options.limitUsd > 0) || !Number.isFinite(options.limitUsd)) {
    throw new CliError({
      code: 'budget_limit_invalid',
      message: 'Budget --limit-usd must be a finite number greater than zero.',
      exitCode: EXIT_USAGE,
    });
  }

  const hierarchy = buildHierarchyReport(ctx);
  const nodes = options.issueArg
    ? hierarchy.nodes.filter((n) => {
        const sel = options.issueArg!;
        const issue = n.issue;
        return (
          issue.issueNodeId === sel ||
          `${issue.repository.nameWithOwner}#${issue.number}` === sel ||
          String(issue.number) === sel
        );
      })
    : hierarchy.nodes;

  if (options.issueArg && nodes.length === 0) {
    throw new CliError({
      code: 'budget_issue_not_found',
      message: `Issue ${JSON.stringify(sanitizeDisplayText(options.issueArg))} is not in the hierarchy report.`,
      exitCode: EXIT_USAGE,
    });
  }

  const warnings: BudgetWarning[] = [];
  let overCount = 0;
  for (const node of nodes) {
    const known =
      options.rollup === 'inclusive'
        ? node.inclusive.cost.knownAmountUsd
        : node.direct.cost.knownAmountUsd;
    const over = known > options.limitUsd;
    if (over) overCount += 1;
    warnings.push({
      issueNodeId: node.issue.issueNodeId,
      repositoryNameWithOwner: node.issue.repository.nameWithOwner,
      number: node.issue.number,
      title: node.issue.title,
      rollup: options.rollup,
      knownCostUsd: known,
      limitUsd: options.limitUsd,
      overByUsd: over ? known - options.limitUsd : 0,
      status: over ? 'over' : 'ok',
    });
  }

  return {
    kind: 'budget',
    projectId: hierarchy.projectId,
    repository: hierarchy.repository,
    limitUsd: options.limitUsd,
    rollup: options.rollup,
    warnings,
    totals: { checked: warnings.length, overCount },
  };
}

export function formatBudgetReportText(report: BudgetReport): string {
  const lines = [
    `Budget check (${report.rollup}) limit=${formatUsd(report.limitUsd)} for ${sanitizeDisplayText(report.repository)}`,
    `checked=${report.totals.checked} over=${report.totals.overCount}`,
    '',
  ];
  for (const w of report.warnings.filter((x) => x.status === 'over')) {
    lines.push(
      `OVER ${sanitizeDisplayText(w.repositoryNameWithOwner)}#${w.number} ` +
        `known=${formatUsd(w.knownCostUsd)} overBy=${formatUsd(w.overByUsd)} ` +
        `${sanitizeDisplayText(w.title)}`,
    );
  }
  if (report.totals.overCount === 0) {
    lines.push('No Issues exceeded the budget limit.');
  }
  return `${lines.join('\n')}\n`;
}
