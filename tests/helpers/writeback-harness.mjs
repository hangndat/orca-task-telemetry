import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openReportContext } from '../../dist/reports/tasks.js';

const dir = dirname(fileURLToPath(import.meta.url));
const cli = resolve(dir, '../../dist/cli.js');

export function runCliWriteback(args, { cwd, env = {}, timeout = 20_000 }) {
  return spawnSync(process.execPath, [cli, 'writeback', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout,
  });
}

export function mockWritebackDeps({ fields, items, remoteByItemId = new Map() }) {
  return {
    readProjectFields: async () => fields,
    readProjectItems: async () => items,
    readProjectItemNumberFieldValue: async (itemId) =>
      remoteByItemId.has(itemId) ? remoteByItemId.get(itemId) : null,
  };
}

export async function withReportContext(appHome, repoRoot, run) {
  const prevHome = process.env.ORCA_TELEMETRY_HOME;
  process.env.ORCA_TELEMETRY_HOME = appHome;
  const ctx = await openReportContext(repoRoot);
  try {
    return await run(ctx);
  } finally {
    ctx.close();
    if (prevHome === undefined) delete process.env.ORCA_TELEMETRY_HOME;
    else process.env.ORCA_TELEMETRY_HOME = prevHome;
  }
}

export function projectItem(issue, itemId) {
  return {
    projectId: 'P_A',
    itemId,
    contentType: 'Issue',
    issue,
  };
}

export function pullRequestItem(itemId) {
  return {
    projectId: 'P_A',
    itemId,
    contentType: 'PullRequest',
    issue: null,
  };
}

export const NUMBER_FIELD = {
  id: 'PVTF_cost',
  name: 'Estimated cost',
  dataType: 'NUMBER',
};
