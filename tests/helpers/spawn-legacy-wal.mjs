import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const helper = resolve(dir, 'read-only-writer.mjs');

/**
 * Start legacy WAL child; resolves when stdout prints "ready" and -wal exists.
 * Caller must call stop() (SIGKILL) before cleanup when abrupt close is needed.
 */
export function spawnLegacyWalHolder(dbPath) {
  const child = spawn(process.execPath, [helper, 'hold', dbPath], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  let stdout = '';
  const ready = new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      if (stdout.includes('ready')) {
        if (!existsSync(`${dbPath}-wal`)) {
          reject(new Error('missing -wal while holder ready'));
          return;
        }
        resolve();
      }
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (!stdout.includes('ready')) {
        reject(new Error(`legacy wal holder exited early code=${code} signal=${signal}`));
      }
    });
  });
  return {
    ready,
    stop() {
      child.kill('SIGKILL');
    },
    closeGracefully() {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error('legacy wal holder close timeout'));
        }, 3000);
        child.once('exit', (code) => {
          clearTimeout(timer);
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`legacy wal holder exit ${code}`));
          }
        });
        child.stdin.end('x\n');
      });
    },
  };
}
