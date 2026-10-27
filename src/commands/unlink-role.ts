import { parseArgs } from 'node:util';
import { unlinkSessionRole, type RoleLinkRole } from '../attribution/role-link.js';
import { USAGE_PROVIDERS, type UsageProvider } from '../contracts.js';
import { openTelemetryDatabase } from '../db/index.js';
import { VERIFIER_PATTERN } from '../db/run-provenance.js';
import { usageError } from '../errors.js';
import { createDefaultPathEnv, resolveAppPaths } from '../paths.js';
import { resolveRepository } from '../repo.js';
import type { RouteResult } from './router.js';

type UnlinkRoleArgs = {
  host: string;
  run: string;
  role: RoleLinkRole;
  provider: UsageProvider;
  session: string;
  dispatch?: string;
  verifier: string;
};

function parseUnlinkRoleArgs(rest: string[]): UnlinkRoleArgs {
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
      },
      allowPositionals: false,
      strict: true,
    });
  } catch {
    throw usageError('Invalid options for unlink-role.', 'Run orca-telemetry unlink-role --help.');
  }
  const v = parsed.values;
  const host = v.host as string | undefined;
  const run = v.run as string | undefined;
  const role = v.role as string | undefined;
  const provider = v.provider as string | undefined;
  const session = v.session as string | undefined;
  const dispatch = v.dispatch as string | undefined;
  const verifier = v.verifier as string | undefined;

  if (!host) throw usageError('Missing --host.', 'Pass the Orca host id of the existing link.');
  if (!run) throw usageError('Missing --run.', 'Pass the Orca Run id of the existing link.');
  if (role !== 'coordinator' && role !== 'worker') {
    throw usageError('Missing or invalid --role.', 'Use --role coordinator or worker.');
  }
  if (!provider || !(USAGE_PROVIDERS as readonly string[]).includes(provider)) {
    throw usageError('Missing or invalid --provider.', 'Use --provider claude or codex.');
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

  return { host, run, role, provider: provider as UsageProvider, session, dispatch, verifier };
}

export async function runUnlinkRole(
  rest: string[],
  options: { json: boolean; cwd: string },
): Promise<RouteResult> {
  const args = parseUnlinkRoleArgs(rest);

  const paths = resolveAppPaths(createDefaultPathEnv());
  const resolved = await resolveRepository(options.cwd);
  const handle = openTelemetryDatabase({ dbPath: paths.dbPath, gitRoot: resolved.gitRoot });
  try {
    const unlinkedAt = new Date().toISOString();
    const result = unlinkSessionRole(handle.db, {
      provider: args.provider,
      rawSessionId: args.session,
      role: args.role,
      hostId: args.host,
      runId: args.run,
      dispatchId: args.dispatch ?? null,
      verifier: args.verifier,
      unlinkedAt,
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
          `Role link ${result.outcome}: ${result.link.sessionKey} ${result.link.role} ${scope}\n`,
        );
      },
    };
  } finally {
    handle.close();
  }
}
