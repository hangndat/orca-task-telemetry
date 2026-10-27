/**
 * Endpoint-bound source host identity from verified Orca CLI JSON only.
 *
 * Orca 1.4.241 exposes `hostId: "local"` on Dispatch/worker rows and
 * `host list` local `id: "local"` — those labels collide across machines.
 * `status.result.runtime.runtimeId` (also mirrored in `_meta.runtimeId`) is
 * the verified endpoint session id for the answering runtime. Storage uses
 * `orca:runtime:v1:<runtimeId>` so two concurrent endpoints never share a
 * scoped namespace even when both report `local`.
 *
 * Limitation (AC3 residual): runtimeId changes when the Orca app restarts,
 * so historical `(host_id, run_id)` rows are not continuous across restart.
 * This does not invent Orca fields; it namespaces a verified CLI value.
 */

const RUNTIME_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const ORCA_HOST_LABEL_LOCAL = 'local';
export const SOURCE_HOST_RUNTIME_PREFIX = 'orca:runtime:v1:';

export type SourceHostIdentity = {
  /** Label matched against Dispatch `host_scope.hostId` / worker `projection.host.id`. */
  orcaHostLabel: typeof ORCA_HOST_LABEL_LOCAL;
  /** Durable-within-endpoint id used as SQLite `host_id`. */
  storageHostId: string;
  runtimeId: string;
};

export type SourceHostFailure = {
  code:
    | 'orca_source_host_unverified'
    | 'source_host_remote_unsupported'
    | 'source_host_invalid';
  message: string;
};

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function id(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function storageHostIdForRuntime(runtimeId: string): string {
  return `${SOURCE_HOST_RUNTIME_PREFIX}${runtimeId.toLowerCase()}`;
}

export function parseRuntimeId(value: unknown): string | null {
  const raw = id(value);
  if (!raw || !RUNTIME_UUID_RE.test(raw)) return null;
  return raw.toLowerCase();
}

/**
 * Derive endpoint identity from a parsed `orca status --json` envelope.
 * Requires `target.kind=local` and matching runtime UUID on result + `_meta`.
 */
export function resolveLocalSourceHostIdentity(
  statusJson: unknown,
): SourceHostIdentity | SourceHostFailure {
  const root = object(statusJson);
  if (!root || root['ok'] !== true) {
    return {
      code: 'orca_source_host_unverified',
      message: 'Orca status did not return an ok envelope for source identity.',
    };
  }
  const result = object(root['result']);
  const target = object(result?.['target']);
  if (target?.['kind'] !== 'local') {
    return {
      code: 'source_host_remote_unsupported',
      message: 'Orca source host identity requires target.kind=local.',
    };
  }
  const runtime = object(result?.['runtime']);
  const fromRuntime = parseRuntimeId(runtime?.['runtimeId']);
  const fromMeta = parseRuntimeId(object(root['_meta'])?.['runtimeId']);
  if (!fromRuntime || !fromMeta || fromRuntime !== fromMeta) {
    return {
      code: 'orca_source_host_unverified',
      message:
        'Orca local host has no verified durable runtime endpoint identity.',
    };
  }
  return {
    orcaHostLabel: ORCA_HOST_LABEL_LOCAL,
    storageHostId: storageHostIdForRuntime(fromRuntime),
    runtimeId: fromRuntime,
  };
}

/**
 * Confirm `host list --json` has exactly one local row with id `local`.
 * Uses only verified CLI fields; does not treat machineName as identity.
 */
export function assertLocalHostListRow(hostListJson: unknown): SourceHostFailure | null {
  const root = object(hostListJson);
  if (!root || root['ok'] !== true) {
    return {
      code: 'source_host_invalid',
      message: 'Orca host list did not return an ok envelope.',
    };
  }
  const result = object(root['result']);
  const hosts = result?.['hosts'];
  if (!Array.isArray(hosts)) {
    return {
      code: 'source_host_invalid',
      message: 'Orca host list is missing hosts[].',
    };
  }
  const localRows = hosts.filter((row) => object(row)?.['kind'] === 'local');
  if (localRows.length !== 1) {
    return {
      code: 'source_host_invalid',
      message: 'Orca host list must contain exactly one kind=local row.',
    };
  }
  const local = object(localRows[0]);
  if (id(local?.['id']) !== ORCA_HOST_LABEL_LOCAL) {
    return {
      code: 'source_host_invalid',
      message: 'Orca local host list id is not the verified label "local".',
    };
  }
  return null;
}

export function runtimeIdFromStdout(stdout: string): string | null {
  try {
    const root = object(JSON.parse(stdout) as unknown);
    return parseRuntimeId(object(root?.['_meta'])?.['runtimeId']);
  } catch {
    return null;
  }
}
