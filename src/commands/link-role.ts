import { parseArgs } from 'node:util';
import { linkSessionToRole, type RoleLinkRole } from '../attribution/role-link.js';
import { USAGE_PROVIDERS, type UsageProvider } from '../contracts.js';
import { VERIFIER_PATTERN, type ManualEvidenceNote } from '../db/run-provenance.js';
import { openTelemetryDatabase } from '../db/index.js';
import { usageError } from '../errors.js';
import { createDefaultPathEnv, resolveAppPaths } from '../paths.js';
import { resolveRepository } from '../repo.js';
import type { RouteResult } from './router.js';

const EVIDENCE_NOTES = ['ids_visible_same_session', 'operator_observed_same_session'] as const;

type LinkRoleArgs = {
  host?: string;
  run?: string;
  role: RoleLinkRole;
  provider: UsageProvider;
  session: string;
  dispatch?: string;
  verifier: string;
  evidenceNote?: ManualEvidenceNote;
};

function parseLinkRoleArgs(rest: string[]): LinkRoleArgs {
  let parsed: { values: Record<string, string | boolean | undefined> };
  try {
    parsed = parseArgs({
      args: rest,
      options: {
        host: { type: 'string' },
        run: { type: 'string' },
        role: { type: 'string' },
        provider: { type: 'string' },
        session: { type: 'string' },
        dispatch: { type: 'string' },
        verifier: { type: 'string' },
        'evidence-note': { type: 'string' },
        'confirm-same-session': { type: 'boolean' },
      },
      allowPositionals: false,
      strict: true,
    });
  } catch {
    throw usageError('Invalid options for link-role.', 'Run orca-telemetry link-role --help.');
  }
  const v = parsed.values;
  const host = v.host as string | undefined;
  const run = v.run as string | undefined;
  const role = v.role as string | undefined;
  const provider = v.provider as string | undefined;
  const session = v.session as string | undefined;
  const dispatch = v.dispatch as string | undefined;
  const verifier = v.verifier as string | undefined;
  const evidenceNote = v['evidence-note'] as string | undefined;
  const confirmSameSession = v['confirm-same-session'];

  if (host !== undefined && host.length === 0) {
    throw usageError('Empty --host.', 'Pass an exact host ID or omit --host to let it resolve uniquely.');
  }
  if (run !== undefined && run.length === 0) {
    throw usageError('Empty --run.', 'Pass an exact Run ID or omit --run to let it resolve uniquely.');
  }
  if (role !== 'coordinator' && role !== 'worker') {
    throw usageError('Missing or invalid --role.', 'Use --role coordinator or worker.');
  }
  if (role === 'coordinator' && !run) {
    throw usageError('Missing --run.', 'Coordinator role links require --run.');
  }
  if (!provider || !(USAGE_PROVIDERS as readonly string[]).includes(provider)) {
    throw usageError('Missing or invalid --provider.', 'Use --provider claude, codex, or cursor.');
  }
  if (!session) {
    throw usageError('Missing --session.', 'Pass the raw provider session id.');
  }
  if (role === 'worker' && !dispatch) {
    throw usageError('Missing --dispatch.', 'Worker role links require --dispatch.');
  }
  if (role === 'coordinator' && dispatch) {
    throw usageError('Unexpected --dispatch.', 'Coordinator role links do not accept --dispatch.');
  }
  if (!verifier) {
    throw usageError('Missing --verifier.', 'Pass a short operator identifier (never raw evidence).');
  }
  if (!VERIFIER_PATTERN.test(verifier)) {
    throw usageError(
      'Invalid --verifier.',
      'Use a short operator identifier: starts with a letter, up to 128 chars of letters, digits, _.@- (never raw evidence).',
    );
  }
  if (evidenceNote !== undefined && !(EVIDENCE_NOTES as readonly string[]).includes(evidenceNote)) {
    throw usageError(
      `Invalid --evidence-note '${evidenceNote}'.`,
      `Use one of: ${EVIDENCE_NOTES.join(', ')}.`,
    );
  }
  if (confirmSameSession !== true) {
    throw usageError(
      'Missing --confirm-same-session.',
      'Pass --confirm-same-session to assert you identified both IDs in one observed session.',
    );
  }

  return {
    host,
    run,
    role,
    provider: provider as UsageProvider,
    session,
    dispatch,
    verifier,
    evidenceNote: evidenceNote as ManualEvidenceNote | undefined,
  };
}

export async function runLinkRole(
  rest: string[],
  options: { json: boolean; cwd: string },
): Promise<RouteResult> {
  const args = parseLinkRoleArgs(rest);

  const paths = resolveAppPaths(createDefaultPathEnv());
  const resolved = await resolveRepository(options.cwd);
  const handle = openTelemetryDatabase({ dbPath: paths.dbPath, gitRoot: resolved.gitRoot });
  try {
    const linkedAt = new Date().toISOString();
    const result = linkSessionToRole(handle.db, {
      provider: args.provider,
      rawSessionId: args.session,
      role: args.role,
      hostId: args.host,
      runId: args.run,
      dispatchId: args.dispatch ?? null,
      verifier: args.verifier,
      evidenceNote: args.evidenceNote ?? null,
      linkedAt,
    });

    const data = { outcome: result.outcome, link: result.link };
    if (options.json) {
      return { kind: 'ok', data };
    }
    return {
      kind: 'text',
      write: () => {
        const scope = `${result.link.hostId}/${result.link.runId}` +
          (result.link.dispatchId ? `/${result.link.dispatchId}` : '');
        process.stdout.write(
          `Role link ${result.outcome}: ${result.link.sessionKey} → ${result.link.role} ${scope}\n`,
        );
      },
    };
  } finally {
    handle.close();
  }
}
