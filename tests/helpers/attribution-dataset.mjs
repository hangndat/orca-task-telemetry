import { sessionKey } from '../../dist/contracts.js';
import { importCodeBurnUsage, importGitHubRecords, openTelemetryDatabase } from '../../dist/db/index.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function loadSyntheticDataset(fixture) {
  const dir = mkdtempSync(join(tmpdir(), 'orca-attr-'));
  const dbPath = join(dir, 'telemetry.sqlite');
  const handle = openTelemetryDatabase({ dbPath });
  importGitHubRecords(handle.db, {
    issues: fixture.issues,
    memberships: fixture.memberships,
  });
  const rows = fixture.sessions.map((s) => {
    const key = sessionKey(s.provider, 'codeburn', s.rawId);
    return {
      session: {
        sessionKey: key,
        provider: s.provider,
        source: 'codeburn',
        rawId: s.rawId,
      },
      snapshot: {
        sessionKey: key,
        observedAt: s.observedAt,
        tokens: s.tokens,
        cost: s.cost,
      },
      claudeModels: s.claudeModels ?? null,
      claudeTokenAllocation: s.claudeTokenAllocation ?? null,
      claudeProjectHint: s.claudeProjectHint ?? null,
    };
  });
  importCodeBurnUsage(handle.db, rows);
  return { ...handle, dir, fixture };
}

export function disposeDataset(ctx) {
  ctx.close();
  rmSync(ctx.dir, { recursive: true, force: true });
}
