const MIN_NODE_MAJOR = 24;

export type NodeVersionCheckResult =
  | { ok: true }
  | { ok: false; message: string };

/** Pure check against a Node-style version string (e.g. `process.version` or `v24.0.0`). */
export function checkNodeVersion(versionString: string): NodeVersionCheckResult {
  const match = /^v?(\d+)/.exec(versionString.trim());
  if (!match) {
    return {
      ok: false,
      message: `Unsupported Node.js version "${versionString}". Requires Node.js >= ${MIN_NODE_MAJOR}.`,
    };
  }
  const major = Number.parseInt(match[1]!, 10);
  if (major < MIN_NODE_MAJOR) {
    return {
      ok: false,
      message: `Node.js ${versionString.replace(/^v/, '')} is not supported. Requires Node.js >= ${MIN_NODE_MAJOR}.`,
    };
  }
  return { ok: true };
}
