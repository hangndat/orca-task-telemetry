import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openTelemetryDatabase } from '../../dist/db/index.js';

const dir = mkdtempSync(join(tmpdir(), 'node24-db-'));
const dbPath = join(dir, 'telemetry.sqlite');
openTelemetryDatabase({ dbPath }).close();
rmSync(dir, { recursive: true, force: true });
process.stdout.write('ok\n');
