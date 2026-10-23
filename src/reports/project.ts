import { aggregateLinkedUsageForProject } from '../attribution/aggregate.js';
import { listUnmappedSessions } from '../attribution/unmapped.js';
import type { UsageProvider } from '../contracts.js';
import {
  formatUsd,
  renderTable,
  sanitizeDisplayText,
  type CollectionFreshnessSlice,
  type TableColumn,
} from './render.js';
import {
  type ReportContext,
  loadCollectionFreshness,
  listProjectIssues,
} from './tasks.js';

export type ProjectModelSlice = {
  provider: UsageProvider;
  model: string;
  allocation: 'known' | 'unknown';
  sessionCount: number;
};

export type ProjectReport = {
  kind: 'project';
  projectId: string;
  repository: string;
  freshness: CollectionFreshnessSlice[];
  linkedSessionCount: number;
  totalsByProvider: {
    provider: UsageProvider;
    sessionCount: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    models: string[];
    mixedModelAllocation: 'known' | 'unknown';
  }[];
  totalsByModel: ProjectModelSlice[];
  cost: {
    knownAmountUsd: number;
    knownEstimatedCount: number;
    unknownAmountCount: number;
  };
  unmappedNotInProjectTotals: {
    sessionCount: number;
    input: number;
    output: number;
    costKnownUsd: number;
    costUnknownCount: number;
  };
  issuesInProject: { issueNodeId: string; number: number; url: string; sessionCount: number }[];
};

function buildModelSlices(
  rollup: ReturnType<typeof aggregateLinkedUsageForProject>,
): ProjectModelSlice[] {
  const slices: ProjectModelSlice[] = [];
  for (const issue of rollup.issues) {
    for (const provider of issue.byProvider) {
      if (provider.models.length === 0) {
        slices.push({
          provider: provider.provider,
          model: 'unknown',
          allocation: 'unknown',
          sessionCount: provider.sessionCount,
        });
        continue;
      }
      if (provider.mixedModelAllocation === 'unknown' || provider.models.length > 1) {
        for (const model of provider.models) {
          slices.push({
            provider: provider.provider,
            model,
            allocation: 'unknown',
            sessionCount: provider.sessionCount,
          });
        }
        continue;
      }
      slices.push({
        provider: provider.provider,
        model: provider.models[0]!,
        allocation: 'known',
        sessionCount: provider.sessionCount,
      });
    }
  }
  return slices;
}

export function buildProjectReport(ctx: ReportContext): ProjectReport {
  const projectId = ctx.profile.project.id;
  const rollup = aggregateLinkedUsageForProject(ctx.db, projectId);
  const unmapped = listUnmappedSessions(ctx.db);
  const issues = listProjectIssues(ctx.db, projectId);

  let unmappedInput = 0;
  let unmappedOutput = 0;
  let unmappedCostKnown = 0;
  let unmappedCostUnknown = 0;
  for (const session of unmapped) {
    unmappedInput += session.snapshot.tokens.input;
    unmappedOutput += session.snapshot.tokens.output;
    const amount = session.snapshot.cost.amountUsd;
    if (amount !== null && Number.isFinite(amount)) {
      unmappedCostKnown += amount;
    } else {
      unmappedCostUnknown += 1;
    }
  }

  const mergedProviders = new Map<
    UsageProvider,
    ProjectReport['totalsByProvider'][number]
  >();
  for (const issue of rollup.issues) {
    for (const p of issue.byProvider) {
      const existing = mergedProviders.get(p.provider);
      if (!existing) {
        mergedProviders.set(p.provider, { ...p });
        continue;
      }
      existing.sessionCount += p.sessionCount;
      existing.input += p.input;
      existing.output += p.output;
      existing.cacheRead += p.cacheRead;
      existing.cacheWrite += p.cacheWrite;
      for (const m of p.models) {
        if (!existing.models.includes(m)) {
          existing.models.push(m);
        }
      }
      if (p.mixedModelAllocation === 'unknown') {
        existing.mixedModelAllocation = 'unknown';
      }
    }
  }

  return {
    kind: 'project',
    projectId,
    repository: ctx.profile.repository.nameWithOwner,
    freshness: loadCollectionFreshness(ctx.db),
    linkedSessionCount: rollup.sessionKeys.length,
    totalsByProvider: [...mergedProviders.values()].sort((a, b) =>
      a.provider.localeCompare(b.provider),
    ),
    totalsByModel: buildModelSlices(rollup),
    cost: rollup.cost,
    unmappedNotInProjectTotals: {
      sessionCount: unmapped.length,
      input: unmappedInput,
      output: unmappedOutput,
      costKnownUsd: unmappedCostKnown,
      costUnknownCount: unmappedCostUnknown,
    },
    issuesInProject: issues.map((issue) => {
      const issueRollup = rollup.issues.find(
        (i) => i.issueNodeId === issue.issueNodeId,
      );
      return {
        issueNodeId: issue.issueNodeId,
        number: issue.number,
        url: issue.url,
        sessionCount: issueRollup?.sessionKeys.length ?? 0,
      };
    }),
  };
}

export function formatProjectReportText(report: ProjectReport): string {
  const lines = [
    `Project report — ${report.projectId}`,
    `Repository: ${report.repository}`,
    `Linked sessions (deduped): ${report.linkedSessionCount}`,
  ];
  if (report.freshness.length > 0) {
    lines.push('Collection snapshot (latest per source):');
    for (const f of report.freshness) {
      lines.push(`  ${f.source}: ${f.status} @ ${f.recordedAt}`);
    }
  }
  lines.push('');
  lines.push('Totals by provider (linked to issues in this project only):');
  const provCols: TableColumn[] = [
    { key: 'provider', header: 'Provider', width: 8 },
    { key: 'sessions', header: 'Sessions', width: 8, align: 'right' },
    { key: 'in', header: 'In', width: 8, align: 'right' },
    { key: 'out', header: 'Out', width: 8, align: 'right' },
    { key: 'models', header: 'Models', width: 24 },
  ];
  const provRows = report.totalsByProvider.map((p) => ({
    provider: p.provider,
    sessions: String(p.sessionCount),
    in: String(p.input),
    out: String(p.output),
    models:
      p.models.length === 0
        ? 'unknown'
        : p.mixedModelAllocation === 'unknown'
          ? `${p.models.join(', ')} (allocation unknown)`
          : p.models.join(', '),
  }));
  if (provRows.length === 0) {
    lines.push('  (no linked usage in project scope)');
  } else {
    lines.push(renderTable(provCols, provRows).trimEnd());
  }
  lines.push('');
  lines.push(
    `Project cost — known (est. API-equiv): ${formatUsd(report.cost.knownAmountUsd)}; sessions with unknown cost: ${report.cost.unknownAmountCount}`,
  );
  lines.push('');
  lines.push('Unmapped sessions (not included in project totals above):');
  lines.push(
    `  count=${report.unmappedNotInProjectTotals.sessionCount} in=${report.unmappedNotInProjectTotals.input} out=${report.unmappedNotInProjectTotals.output} costKnown=${formatUsd(report.unmappedNotInProjectTotals.costKnownUsd)} unknownCostSessions=${report.unmappedNotInProjectTotals.costUnknownCount}`,
  );
  lines.push('');
  lines.push('Issues in project:');
  for (const issue of report.issuesInProject) {
    lines.push(
      `  #${issue.number} ${sanitizeDisplayText(issue.url)} linkedSessions=${issue.sessionCount}`,
    );
  }
  return `${lines.join('\n')}\n`;
}
