/**
 * `preview overhead` — read-only, in-memory UAT preview of coordinator vs worker
 * overhead for one Orca Run and operator-supplied role mappings. Never opens the
 * telemetry database or writes anywhere; see docs/UAT-PREVIEW.md.
 */
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import type { UsageProvider } from '../contracts.js';
import {
  CODEBURN_VERIFIED_VERSION,
  invokeCodeburn,
  parseSessionsJsonArray,
  readCodeburnVersion,
  schemaDrift,
} from '../codeburn/adapter.js';
import { parseClaudeSessions } from '../codeburn/claude.js';
import { parseCodexSessions } from '../codeburn/codex.js';
import { CliError, EXIT_SOURCE_UNAVAILABLE, EXIT_USAGE, usageError } from '../errors.js';
import { assertRuntimeReachable, invokeOrcaReadOnly, readOrcaVersion } from '../orca/adapter.js';
import { collectOrcaRunProvenance } from '../orca/run-provenance.js';
import {
  MAX_ROLES_BYTES,
  buildOverheadPreview,
  formatOverheadPreviewText,
  parseRolesFile,
  type ProviderSource,
  type RoleEntry,
} from '../reports/overhead-preview.js';
import type { RouteResult } from './router.js';

const USAGE = 'Usage: orca-telemetry preview overhead --run <run-id> --roles <roles.json> [--json]';

// 1.4.237 has no verified durable endpoint identity (AC3); this label is only
// accepted after `status` reports target.kind=local, and is flagged unverified.
const PREVIEW_HOST_ID = 'local';

function parsePreviewArgs(rest: string[]): { run: string; roles: string } {
  let values: { run?: string; roles?: string };
  try {
    values = parseArgs({
      args: rest,
      options: { run: { type: 'string' }, roles: { type: 'string' } },
      allowPositionals: false,
      strict: true,
    }).values;
  } catch {
    throw usageError('Invalid options for preview overhead.', USAGE);
  }
  if (!values.run) throw usageError('Missing --run.', USAGE);
  if (!values.roles) throw usageError('Missing --roles.', USAGE);
  return { run: values.run, roles: values.roles };
}

function readRolesFile(file: string): RoleEntry[] {
  let text: string;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_ROLES_BYTES) {
      throw new Error('unreadable');
    }
    text = fs.readFileSync(file, 'utf8');
  } catch {
    throw new CliError({
      code: 'preview_roles_unreadable',
      message: `Roles file must be a regular file of at most ${MAX_ROLES_BYTES} bytes.`,
      exitCode: EXIT_USAGE,
    });
  }
  return parseRolesFile(text);
}

async function assertLocalOrcaEndpoint(): Promise<string> {
  const version = await readOrcaVersion();
  const status = await invokeOrcaReadOnly(['status', '--json']);
  let parsed: unknown;
  try {
    if (status.exitCode !== 0) throw new Error('status failed');
    parsed = JSON.parse(status.stdout) as unknown;
  } catch {
    throw new CliError({
      code: 'orca_runtime_unavailable',
      message: 'Orca status failed or returned invalid JSON.',
      exitCode: EXIT_SOURCE_UNAVAILABLE,
    });
  }
  assertRuntimeReachable(parsed);
  const result = (parsed as Record<string, unknown>)['result'] as Record<string, unknown> | undefined;
  const target = result?.['target'] as Record<string, unknown> | null | undefined;
  if (target?.['kind'] !== 'local') {
    throw new CliError({
      code: 'orca_source_host_unverified',
      message: 'Orca source host is not verified as local.',
      exitCode: EXIT_SOURCE_UNAVAILABLE,
    });
  }
  return version;
}

function sourceErrorCode(err: unknown): string {
  return err instanceof CliError ? err.code : 'source_error';
}

async function readProviders(
  providers: UsageProvider[],
): Promise<Partial<Record<UsageProvider, ProviderSource>>> {
  const out: Partial<Record<UsageProvider, ProviderSource>> = {};
  let version: string;
  try {
    version = await readCodeburnVersion();
    if (version !== CODEBURN_VERIFIED_VERSION) throw new Error('version');
  } catch (err) {
    for (const provider of providers) out[provider] = { status: 'error', errorCode: sourceErrorCode(err) };
    return out;
  }
  const observedAt = new Date().toISOString();
  for (const provider of providers) {
    try {
      const result = await invokeCodeburn(
        ['sessions', '--provider', provider, '--period', 'all', '--format', 'json', '--no-pager'],
      );
      if (result.exitCode !== 0) {
        throw new CliError({
          code: 'codeburn_runtime_unavailable', message: 'CodeBurn sessions failed.',
          exitCode: EXIT_SOURCE_UNAVAILABLE,
        });
      }
      if (result.stdout.trim().length === 0) throw schemaDrift('root', 'stdout is not valid JSON');
      const rows = parseSessionsJsonArray(result.stdout);
      out[provider] = {
        status: 'ok',
        sessions: provider === 'claude'
          ? parseClaudeSessions(rows, observedAt, version)
          : parseCodexSessions(rows, observedAt, version),
      };
    } catch (err) {
      out[provider] = { status: 'error', errorCode: sourceErrorCode(err) };
    }
  }
  return out;
}

export async function runPreviewOverhead(
  rest: string[],
  options: { json: boolean },
): Promise<RouteResult> {
  const args = parsePreviewArgs(rest);
  const entries = readRolesFile(args.roles);
  const version = await assertLocalOrcaEndpoint();
  const provenance = await collectOrcaRunProvenance(args.run, {
    sourceHostId: PREVIEW_HOST_ID, readVersion: async () => version,
  });
  const requested = [...new Set(entries.map((entry) => entry.provider))];
  const providers = await readProviders(requested);
  const data = buildOverheadPreview({
    hostId: PREVIEW_HOST_ID, runId: args.run, entries, provenance, providers,
  });
  if (options.json) return { kind: 'ok', data };
  return { kind: 'text', write: () => process.stdout.write(formatOverheadPreviewText(data)) };
}
