import { parseArgs } from 'node:util';
import { suggestSessionLinks } from '../attribution/suggest.js';
import { linkSessionToIssue } from '../attribution/link.js';
import { loadConfig } from '../config.js';
import { importGitHubRecords } from '../db/repository.js';
import { openTelemetryDatabase } from '../db/index.js';
import { CliError, EXIT_USAGE, usageError } from '../errors.js';
import { parseIssueRef, resolveIssue } from '../github/identity.js';
import { createDefaultPathEnv, resolveAppPaths } from '../paths.js';
import { getProfile } from '../profiles.js';
import { resolveRepository } from '../repo.js';
import { sanitizeDisplayText, shellSingleQuote } from '../reports/render.js';
import type { RouteResult } from './router.js';

const LIST_USAGE = 'Usage: orca-telemetry suggest-links [--json]';
const APPLY_USAGE =
  'Usage: orca-telemetry suggest-links apply --issue <sel> --provider claude|codex --session <id> --yes [--json]';

export async function runSuggestLinks(
  rest: string[],
  options: { json: boolean; cwd: string },
): Promise<RouteResult> {
  if (rest[0] === 'apply') {
    return runSuggestLinksApply(rest.slice(1), options);
  }
  if (rest.length > 0) {
    throw usageError(`Unexpected arguments: ${rest.join(' ')}`, LIST_USAGE);
  }

  const pathEnv = createDefaultPathEnv();
  const paths = resolveAppPaths(pathEnv);
  const resolved = await resolveRepository(options.cwd);
  const config = loadConfig(paths.appHome);
  const profile = getProfile(config, resolved.github.id);
  const handle = openTelemetryDatabase({
    dbPath: paths.dbPath,
    gitRoot: resolved.gitRoot,
  });
  try {
    const suggestions = suggestSessionLinks(handle.db, profile.project.id);
    const data = {
      kind: 'suggest_links',
      projectId: profile.project.id,
      repository: resolved.github.nameWithOwner,
      suggestions,
      totals: {
        ready: suggestions.filter((s) => s.status === 'ready').length,
        needsApproval: suggestions.filter((s) => s.status === 'needs_approval').length,
        noMatch: suggestions.filter((s) => s.status === 'no_match').length,
      },
    };
    if (options.json) return { kind: 'ok', data };
    const lines = [
      `Link suggestions for ${sanitizeDisplayText(data.repository)}`,
      `ready=${data.totals.ready} needs_approval=${data.totals.needsApproval} no_match=${data.totals.noMatch}`,
      '',
    ];
    for (const s of suggestions) {
      lines.push(
        `${s.status} ${s.provider} session=${sanitizeDisplayText(s.rawSessionId)} ` +
          `hint=${s.projectHint ? sanitizeDisplayText(s.projectHint) : 'none'} ` +
          `candidates=${s.candidateIssueNodeIds.length} (${s.reason})`,
      );
      if (s.status === 'ready') {
        lines.push(
          `  suggest: orca-telemetry suggest-links apply --issue ${shellSingleQuote(s.candidateIssueNodeIds[0]!)} --provider ${s.provider} --session ${shellSingleQuote(s.rawSessionId)} --yes`,
        );
      }
    }
    return {
      kind: 'text',
      write: () => {
        process.stdout.write(`${lines.join('\n')}\n`);
      },
    };
  } finally {
    handle.close();
  }
}

async function runSuggestLinksApply(
  rest: string[],
  options: { json: boolean; cwd: string },
): Promise<RouteResult> {
  let values: {
    issue?: string;
    provider?: string;
    session?: string;
    yes?: boolean;
  };
  try {
    values = parseArgs({
      args: rest,
      options: {
        issue: { type: 'string' },
        provider: { type: 'string' },
        session: { type: 'string' },
        yes: { type: 'boolean', default: false },
      },
      allowPositionals: false,
      strict: true,
    }).values;
  } catch {
    throw usageError('Invalid options for suggest-links apply.', APPLY_USAGE);
  }
  if (!values.issue || !values.provider || !values.session) {
    throw usageError('Missing required --issue/--provider/--session.', APPLY_USAGE);
  }
  if (values.provider !== 'claude' && values.provider !== 'codex') {
    throw usageError('Invalid --provider.', APPLY_USAGE);
  }
  if (!values.yes) {
    throw new CliError({
      code: 'suggest_apply_requires_yes',
      message: 'suggest-links apply requires explicit --yes; nothing was linked.',
      hint: APPLY_USAGE,
      exitCode: EXIT_USAGE,
    });
  }

  const githubIssue = await resolveIssue(parseIssueRef(values.issue));
  const pathEnv = createDefaultPathEnv();
  const paths = resolveAppPaths(pathEnv);
  const resolved = await resolveRepository(options.cwd);
  const config = loadConfig(paths.appHome);
  const profile = getProfile(config, resolved.github.id);
  const handle = openTelemetryDatabase({
    dbPath: paths.dbPath,
    gitRoot: resolved.gitRoot,
  });
  try {
    const suggestions = suggestSessionLinks(handle.db, profile.project.id);
    const ready = suggestions.find(
      (s) =>
        s.provider === values.provider &&
        s.rawSessionId === values.session &&
        s.status === 'ready' &&
        s.candidateIssueNodeIds.includes(githubIssue.issueNodeId),
    );
    if (!ready) {
      throw new CliError({
        code: 'suggest_apply_not_ready',
        message:
          'Refusing to apply: suggestion is not high-confidence ready for this exact session/issue pair.',
        hint: 'Re-run suggest-links; ambiguous matches require manual `link`.',
        exitCode: EXIT_USAGE,
      });
    }

    importGitHubRecords(handle.db, {
      issues: [githubIssue],
      memberships: [],
    });
    const result = linkSessionToIssue(handle.db, {
      provider: values.provider,
      source: 'agent-top',
      rawSessionId: values.session,
      issueNodeId: githubIssue.issueNodeId,
      linkedAt: new Date().toISOString(),
    });
    const data = {
      kind: 'suggest_links_apply',
      outcome: result.outcome,
      issueNodeId: githubIssue.issueNodeId,
      provider: values.provider,
      session: values.session,
      linked: true,
    };
    if (options.json) return { kind: 'ok', data };
    return {
      kind: 'text',
      write: () => {
        process.stdout.write(
          `Linked ${result.outcome}: ${values.provider} session ${sanitizeDisplayText(values.session!)} → ${githubIssue.repository.nameWithOwner}#${githubIssue.number}\n`,
        );
      },
    };
  } finally {
    handle.close();
  }
}
