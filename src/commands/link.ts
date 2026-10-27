import { parseArgs } from 'node:util';
import { linkSessionToIssue } from '../attribution/link.js';
import { USAGE_PROVIDERS, type UsageProvider } from '../contracts.js';
import { loadConfig } from '../config.js';
import { importGitHubRecords } from '../db/repository.js';
import { openTelemetryDatabase } from '../db/index.js';
import { parseIssueRef, resolveIssue } from '../github/identity.js';
import { usageError } from '../errors.js';
import { createDefaultPathEnv, resolveAppPaths } from '../paths.js';
import { resolveRepository } from '../repo.js';
import type { RouteResult } from './router.js';

function parseLinkArgs(rest: string[]): {
  issue: string;
  provider: UsageProvider;
  session: string;
} {
  const parsed = parseArgs({
    args: rest,
    options: {
      issue: { type: 'string' },
      provider: { type: 'string' },
      session: { type: 'string' },
    },
    allowPositionals: false,
    strict: true,
  });
  const issue = parsed.values.issue;
  const providerRaw = parsed.values.provider;
  const session = parsed.values.session;
  if (!issue) {
    throw usageError('Missing --issue.', 'Usage: orca-telemetry link --issue <url|owner/repo#n> --provider claude|codex|cursor --session <id>');
  }
  if (!providerRaw) {
    throw usageError('Missing --provider.', 'Use --provider claude, codex, or cursor.');
  }
  if (!session || session.length === 0) {
    throw usageError('Missing --session.', 'Pass the provider session id (rawId).');
  }
  if (!(USAGE_PROVIDERS as readonly string[]).includes(providerRaw)) {
    throw usageError(
      `Invalid --provider '${providerRaw}'.`,
      'Use claude, codex, or cursor explicitly.',
    );
  }
  return { issue, provider: providerRaw as UsageProvider, session };
}

export async function runLink(
  rest: string[],
  options: { json: boolean; cwd: string },
): Promise<RouteResult> {
  const { issue, provider, session } = parseLinkArgs(rest);
  const ref = parseIssueRef(issue);
  const githubIssue = await resolveIssue(ref);

  const pathEnv = createDefaultPathEnv();
  const paths = resolveAppPaths(pathEnv);
  const resolved = await resolveRepository(options.cwd);
  const handle = openTelemetryDatabase({
    dbPath: paths.dbPath,
    gitRoot: resolved.gitRoot,
  });

  importGitHubRecords(handle.db, {
    issues: [githubIssue],
    memberships: [],
  });

  const linkedAt = new Date().toISOString();
  const result = linkSessionToIssue(handle.db, {
    provider,
    source: 'agent-top',
    rawSessionId: session,
    issueNodeId: githubIssue.issueNodeId,
    linkedAt,
  });
  handle.close();

  const data = {
    outcome: result.outcome,
    link: result.link,
    issue: {
      issueNodeId: githubIssue.issueNodeId,
      repository: githubIssue.repository.nameWithOwner,
      number: githubIssue.number,
    },
  };

  if (options.json) {
    return { kind: 'ok', data };
  }
  return {
    kind: 'text',
    write: () => {
      process.stdout.write(
        `Link ${result.outcome}: session ${result.link.sessionKey} → ${githubIssue.repository.nameWithOwner}#${githubIssue.number}\n`,
      );
    },
  };
}
