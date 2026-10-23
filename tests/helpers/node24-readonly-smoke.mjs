import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openTelemetryDatabase } from '../../dist/db/index.js';
import { readUserVersionReadOnly } from '../../dist/db/read-only.js';

const dir = mkdtempSync(join(tmpdir(), 'node24-ro-'));
const dbPath = join(dir, 'telemetry.sqlite');
const home = join(dir, 'home');
writeFileSync(join(dir, 'marker'), 'x');
const handle = openTelemetryDatabase({ dbPath });
handle.close();
const before = readdirSync(dir).sort().join(',');
const version = await readUserVersionReadOnly(dbPath);
if (version !== 1) {
  throw new Error(`expected schema 1 got ${version}`);
}
const after = readdirSync(dir).sort().join(',');
if (before !== after) {
  throw new Error(`home inventory changed: ${before} -> ${after}`);
}
rmSync(dir, { recursive: true, force: true });
process.stdout.write(`${process.version}\nok\n`);
