/**
 * Child helper for legacy WAL fixtures.
 * Usage: read-only-writer.mjs hold <dbPath>  — keeps WAL DB open until stdin byte received.
 */
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { migrateDatabase } from '../../dist/db/migrate.js';

const mode = process.argv[2];
const dbPath = process.argv[3];
if (mode !== 'hold' || !dbPath) {
  process.stderr.write('usage: read-only-writer.mjs hold <dbPath>\n');
  process.exit(2);
}

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA wal_autocheckpoint = 0');
migrateDatabase(db);
db.prepare(
  `INSERT INTO collection_logs (source, status, message, recorded_at)
   VALUES ('orca', 'success', 'legacy-wal-probe', '2026-01-02T00:00:00.000Z')`,
).run();

if (!existsSync(`${dbPath}-wal`)) {
  process.stderr.write('expected -wal sidecar while WAL writer is open\n');
  process.exit(1);
}

process.stdout.write('ready\n');
await new Promise((resolve) => {
  process.stdin.once('data', () => resolve());
});
db.close();
process.stdout.write('closed\n');
