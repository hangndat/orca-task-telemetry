import { CliError, EXIT_PARTIAL, usageError } from '../errors.js';
import { readProjectItemNumberFieldValue } from '../github/fields.js';
import { sanitizeDisplayText } from '../reports/render.js';
import { setProjectItemNumberField } from './gh-apply.js';
import {
  decideWritebackAction,
  formatWritebackUsd,
  roundWritebackUsd,
  type WritebackPreviewItem,
  type WritebackPreviewReport,
} from './preview.js';

export type WritebackApplyItem = WritebackPreviewItem & {
  result: 'applied' | 'skipped' | 'failed' | 'cancelled';
  error?: { code: string; message: string; hint?: string };
};

export type WritebackApplyReport = Omit<WritebackPreviewReport, 'kind' | 'mode' | 'items' | 'summary'> & {
  kind: 'writeback_apply';
  mode: 'apply';
  cancelled: boolean;
  items: WritebackApplyItem[];
  summary: {
    plannedSets: number;
    applied: number;
    skips: number;
    failed: number;
    cancelled: number;
  };
};

export type WritebackApplyDeps = {
  readProjectItemNumberFieldValue: typeof readProjectItemNumberFieldValue;
  setProjectItemNumberField: typeof setProjectItemNumberField;
  ghPath?: string;
};

const DEFAULT_DEPS: WritebackApplyDeps = {
  readProjectItemNumberFieldValue,
  setProjectItemNumberField,
};

function itemError(error: unknown): NonNullable<WritebackApplyItem['error']> {
  if (error instanceof CliError) {
    if (error.code === 'github_scope_missing') {
      const readScope = error.hint === 'gh auth refresh -s read:project';
      return {
        code: error.code,
        message: readScope
          ? 'GitHub token is missing the read:project scope required to re-read the item.'
          : 'GitHub token is missing the project scope required for item-edit.',
        hint: readScope ? 'gh auth refresh -s read:project' : 'gh auth refresh -s project',
      };
    }
    if (error.code === 'github_auth_required') {
      return { code: error.code, message: 'GitHub CLI is not authenticated.', hint: 'gh auth login' };
    }
    if (error.code === 'gh_not_found') {
      return { code: error.code, message: 'GitHub CLI (gh) was not found on PATH.' };
    }
    if (error.code === 'github_unavailable') {
      return { code: error.code, message: 'GitHub was unavailable for this item.' };
    }
    if (error.code === 'github_apply_failed') {
      return { code: error.code, message: 'GitHub CLI could not update this item.' };
    }
  }
  return {
    code: 'writeback_item_failed',
    message: 'Could not read or update this project item; no write was confirmed.',
  };
}

function applyReport(preview: WritebackPreviewReport, cancelled: boolean): WritebackApplyReport {
  return {
    kind: 'writeback_apply',
    mode: 'apply',
    cancelled,
    project: preview.project,
    field: preview.field,
    rollup: preview.rollup,
    freshness: preview.freshness,
    warnings: preview.warnings,
    items: [],
    summary: {
      plannedSets: preview.summary.wouldSet,
      applied: 0,
      skips: 0,
      failed: 0,
      cancelled: 0,
    },
  };
}

/** Applies only candidate sets in a just-computed preview, sequentially and without retries. */
export async function applyWritebackPreview(
  preview: WritebackPreviewReport,
  options: { forceOverwrite: boolean; confirmed: boolean },
  deps: WritebackApplyDeps = DEFAULT_DEPS,
): Promise<WritebackApplyReport> {
  if (preview.kind !== 'writeback_preview' || preview.mode !== 'dry_run') {
    throw usageError('Apply requires a current writeback preview.');
  }
  if (preview.field.dataType !== 'NUMBER') {
    throw usageError('Apply requires a NUMBER field.');
  }

  const report = applyReport(preview, !options.confirmed);
  const gql = deps.ghPath ? { ghPath: deps.ghPath } : {};

  for (const item of preview.items) {
    if (item.action !== 'set') {
      report.items.push({ ...item, result: 'skipped' });
      report.summary.skips += 1;
      continue;
    }
    if (!options.confirmed) {
      report.items.push({ ...item, result: 'cancelled' });
      report.summary.cancelled += 1;
      continue;
    }

    // Invalid or mismatched proposals must fail before either a re-read or a write.
    if (
      !item.projectItemId ||
      item.proposed === undefined ||
      !Number.isFinite(item.proposed) ||
      !Number.isFinite(item.computed.knownAmountUsd) ||
      !Number.isSafeInteger(item.computed.sessionCount) ||
      item.computed.sessionCount < 1 ||
      roundWritebackUsd(item.computed.knownAmountUsd) !== item.proposed
    ) {
      report.items.push({
        ...item,
        result: 'failed',
        error: { code: 'invalid_proposal', message: 'Invalid computed NUMBER proposal; no write attempted.' },
      });
      report.summary.failed += 1;
      continue;
    }

    try {
      const remote = await deps.readProjectItemNumberFieldValue(
        item.projectItemId,
        preview.field.id,
        gql,
      );
      if (remote !== null && !Number.isFinite(remote)) {
        throw usageError('Remote NUMBER is not finite.');
      }
      const decision = decideWritebackAction(
        {
          knownAmountUsd: item.computed.knownAmountUsd,
          sessionCount: item.computed.sessionCount,
          unknownAmountCount: 0,
        },
        remote,
        options.forceOverwrite,
      );
      const rereadItem: WritebackApplyItem = {
        ...item,
        remote,
        action: decision.action,
        ...(decision.proposed !== undefined ? { proposed: decision.proposed } : {}),
        ...(decision.skipReason ? { skipReason: decision.skipReason } : {}),
        result: decision.action === 'set' ? 'applied' : 'skipped',
      };
      if (decision.action === 'skip') {
        report.items.push(rereadItem);
        report.summary.skips += 1;
        continue;
      }
      if (decision.proposed === undefined || !Number.isFinite(decision.proposed)) {
        throw usageError('Computed NUMBER proposal is not finite.');
      }
      await deps.setProjectItemNumberField(
        {
          projectItemId: item.projectItemId,
          fieldId: preview.field.id,
          projectId: preview.project.id,
          number: decision.proposed,
        },
        deps.ghPath ? { ghPath: deps.ghPath } : {},
      );
      report.items.push(rereadItem);
      report.summary.applied += 1;
    } catch (error) {
      report.items.push({ ...item, result: 'failed', error: itemError(error) });
      report.summary.failed += 1;
    }
  }

  return report;
}

export function applyExitCode(report: WritebackApplyReport): number {
  return report.summary.failed > 0 ? EXIT_PARTIAL : 0;
}

export function formatWritebackApplyText(report: WritebackApplyReport): string {
  const lines = [
    `Writeback apply — ${sanitizeDisplayText(report.project.owner.login)}/projects/${report.project.number}`,
    `Field: ${sanitizeDisplayText(report.field.name)} (${report.field.id})`,
    `Rollup: ${report.rollup} · estimated API equivalent (USD)`,
  ];
  for (const warning of report.warnings) lines.push(`Warning: ${warning}`);
  if (report.freshness.length > 0) {
    lines.push('Collection freshness:');
    for (const slice of report.freshness) {
      lines.push(`  ${slice.source}: ${slice.status} @ ${slice.recordedAt}`);
    }
  }
  for (const item of report.items) {
    const identity = `${item.issue.repository.nameWithOwner}#${item.issue.number}`;
    const value = item.proposed === undefined ? '—' : formatWritebackUsd(item.proposed);
    const detail = item.error ? ` (${item.error.code}: ${item.error.message})` :
      item.skipReason ? ` (${item.skipReason})` : '';
    lines.push(`${sanitizeDisplayText(identity)}  ${value}  ${item.result}${detail}`);
  }
  lines.push(
    `Applied ${report.summary.applied}, skipped ${report.summary.skips}, failed ${report.summary.failed}, cancelled ${report.summary.cancelled} (planned ${report.summary.plannedSets}).`,
  );
  return `${lines.join('\n')}\n`;
}
