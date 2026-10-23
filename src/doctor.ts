import { spawnSync } from 'node:child_process';

interface ToolStatus {
  name: string;
  found: boolean;
  version: string | null;
}

function checkTool(name: string): ToolStatus {
  const result = spawnSync(name, ['--version'], {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });
  const found = result.error === undefined || ('status' in result && result.status !== null);
  const version = (result.stdout || result.stderr || '').trim().split('\n')[0]?.slice(0, 160) || null;
  return { name, found, version };
}

export function runDoctor(): number {
  process.stdout.write(`Node.js: ${process.version}\n`);
  for (const name of ['git', 'gh', 'orca', 'codeburn']) {
    const status = checkTool(name);
    process.stdout.write(`${name}: ${status.found ? 'found' : 'not found'}${status.version ? ` (${status.version})` : ''}\n`);
  }
  process.stdout.write('Note: tool presence does not verify authentication or supported JSON schemas.\n');
  return 0;
}
