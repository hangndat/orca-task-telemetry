import { parseArgs } from 'node:util';
import { usageError } from '../errors.js';
import { openReportContext } from '../reports/tasks.js';
import {
  buildWritebackPreview,
  formatWritebackPreviewText,
  type WritebackRollup,
} from '../writeback/preview.js';
import type { RouteResult } from './router.js';

export type WritebackCommandOptions = {
  json: boolean;
  cwd: string;
};

function parseRollup(value: string | undefined): WritebackRollup {
  if (value === undefined || value === 'direct') {
    return 'direct';
  }
  if (value === 'inclusive') {
    return 'inclusive';
  }
  throw usageError(
    `Invalid --rollup '${value}'.`,
    'Use --rollup direct or --rollup inclusive.',
  );
}

export function parseWritebackArgs(rest: string[]): {
  field?: string;
  fieldId?: string;
  rollup: WritebackRollup;
  issues: string[];
  forceOverwrite: boolean;
} {
  try {
    const parsed = parseArgs({
      args: rest,
      options: {
        field: { type: 'string' },
        'field-id': { type: 'string' },
        rollup: { type: 'string' },
        issue: { type: 'string', multiple: true },
        apply: { type: 'boolean' },
        yes: { type: 'boolean' },
        'force-overwrite': { type: 'boolean' },
        project: { type: 'string' },
        owner: { type: 'string' },
      },
      allowPositionals: true,
      strict: true,
    });

    if (parsed.positionals.length > 0) {
      throw usageError(
        `Unexpected arguments: ${parsed.positionals.join(' ')}`,
        'Usage: orca-telemetry writeback --field <name> [options]',
      );
    }

    if (parsed.values.apply) {
      throw usageError(
        '--apply is not available in this release.',
        'Writeback runs in dry-run preview mode only; live apply ships in a later slice.',
      );
    }
    if (parsed.values.yes) {
      throw usageError(
        '--yes requires --apply.',
        'Dry-run preview does not prompt or write to GitHub.',
      );
    }
    if (parsed.values.project !== undefined) {
      throw usageError(
        '--project is not supported.',
        'Project and owner come from the init profile for this repository.',
      );
    }
    if (parsed.values.owner !== undefined) {
      throw usageError(
        '--owner is not supported.',
        'Project and owner come from the init profile for this repository.',
      );
    }

    const field = parsed.values.field;
    const fieldId = parsed.values['field-id'];
    if (field && fieldId) {
      throw usageError(
        'Pass only one of --field or --field-id.',
        'Use --field-id when multiple fields share a name.',
      );
    }
    if (field !== undefined && field.length === 0) {
      throw usageError('--field requires a value.', 'Example: --field "Estimated cost"');
    }
    if (fieldId !== undefined && fieldId.length === 0) {
      throw usageError('--field-id requires a value.', 'Pass the project field node id.');
    }

    const issues = parsed.values.issue ?? [];
    for (const issue of issues) {
      if (issue.length === 0) {
        throw usageError('--issue requires a value.', 'Example: --issue owner/repo#1');
      }
    }

    return {
      field,
      fieldId,
      rollup: parseRollup(parsed.values.rollup),
      issues,
      forceOverwrite: parsed.values['force-overwrite'] === true,
    };
  } catch (err) {
    if (err instanceof Error && err.name === 'TypeError') {
      throw usageError(err.message, 'Usage: orca-telemetry writeback --field <name> [--json]');
    }
    throw err;
  }
}

export async function runWriteback(
  rest: string[],
  options: WritebackCommandOptions,
): Promise<RouteResult> {
  const args = parseWritebackArgs(rest);
  if (!args.field && !args.fieldId) {
    throw usageError(
      'Missing --field or --field-id.',
      'Pass a NUMBER custom field from the init profile project.',
    );
  }

  const ctx = await openReportContext(options.cwd);
  try {
    const data = await buildWritebackPreview(ctx, {
      fieldName: args.field,
      fieldId: args.fieldId,
      rollup: args.rollup,
      issueSelectors: args.issues.length > 0 ? args.issues : undefined,
      forceOverwrite: args.forceOverwrite,
    });

    if (options.json) {
      return { kind: 'ok', data };
    }
    return {
      kind: 'text',
      write: () => {
        process.stdout.write(formatWritebackPreviewText(data));
      },
    };
  } finally {
    ctx.close();
  }
}
