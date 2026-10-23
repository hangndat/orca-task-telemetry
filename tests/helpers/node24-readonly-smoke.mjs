import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openTelemetryDatabase, SUPPORTED_SCHEMA_VERSION } from '../../dist/db/index.js';
import { readUserVersionReadOnly } from '../../dist/db/read-only.js';
import { spawnLegacyWalHolder } from './spawn-legacy-wal.mjs';

async function coldLegacyWalFixture(dbPath) {
  const holder = spawnLegacyWalHolder(dbPath);
  await holder.ready;
  await holder.closeGracefully();
  if (existsSync(`${dbPath}-wal`) || existsSync(`${dbPath}-shm`)) {
    throw new Error('expected no WAL sidecars after graceful close');
  }
}

const dir = mkdtempSync(join(tmpdir(), 'node24-ro-'));
const dbPath = join(dir, 'telemetry.sqlite');
writeFileSync(join(dir, 'marker'), 'x');

const handle = openTelemetryDatabase({ dbPath });
handle.close();
const beforeDelete = readdirSync(dir).sort().join(',');
const version = await readUserVersionReadOnly(dbPath);
if (version !== SUPPORTED_SCHEMA_VERSION) {
  throw new Error(`expected schema ${SUPPORTED_SCHEMA_VERSION} got ${version}`);
}
const afterDelete = readdirSync(dir).sort().join(',');
if (beforeDelete !== afterDelete) {
  throw new Error(`DELETE home inventory changed: ${beforeDelete} -> ${afterDelete}`);
}

const coldDir = mkdtempSync(join(tmpdir(), 'node24-cold-wal-'));
const coldDb = join(coldDir, 'telemetry.sqlite');
await coldLegacyWalFixture(coldDb);
const coldBefore = readdirSync(coldDir).sort().join(',');
try {
  await readUserVersionReadOnly(coldDb);
  throw new Error('expected cold legacy WAL to be rejected');
} catch (err) {
  if (err?.code !== 'db_error') {
    throw err;
  }
}
const coldAfter = readdirSync(coldDir).sort().join(',');
if (coldBefore !== coldAfter) {
  throw new Error(`cold WAL home inventory changed: ${coldBefore} -> ${coldAfter}`);
}

rmSync(dir, { recursive: true, force: true });
rmSync(coldDir, { recursive: true, force: true });
process.stdout.write(`${process.version}\nok\n`);
