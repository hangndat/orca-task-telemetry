import { spawnSync } from 'node:child_process';

export interface ToolStatus {
  name: string;
  found: boolean;
  version: string | null;
}

export interface DoctorData {
  nodeVersion: string;
  tools: ToolStatus[];
  note: string;
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

export function collectDoctorData(): DoctorData {
  const tools: ToolStatus[] = [];
  for (const name of ['git', 'gh', 'orca', 'codeburn']) {
    tools.push(checkTool(name));
  }
  return {
    nodeVersion: process.version,
    tools,
    note: 'Tool presence does not verify authentication or supported JSON schemas.',
  };
}

export function runDoctor(): number {
  const data = collectDoctorData();
  process.stdout.write(`Node.js: ${data.nodeVersion}\n`);
  for (const status of data.tools) {
    process.stdout.write(
      `${status.name}: ${status.found ? 'found' : 'not found'}${status.version ? ` (${status.version})` : ''}\n`,
    );
  }
  process.stdout.write(`Note: ${data.note}\n`);
  return 0;
}
