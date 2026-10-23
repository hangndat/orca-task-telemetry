import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const settings = JSON.parse(readFileSync(join(root, '.claude/settings.json'), 'utf8'));

test('Claude imports the shared instructions and registers only the Agent guard', () => {
  assert.equal(readFileSync(join(root, 'CLAUDE.md'), 'utf8').trim(), '@AGENTS.md');
  assert.deepEqual(Object.keys(settings.hooks), ['PreToolUse']);
  assert.equal(settings.hooks.PreToolUse.length, 1);
  assert.equal(settings.hooks.PreToolUse[0].matcher, 'Agent');
});

test('configured hook denies native delegation from another cwd with spaces in the project path', () => {
  const temp = mkdtempSync(join(tmpdir(), 'telemetry-agent-hook-'));
  try {
    const project = join(temp, 'project with spaces');
    symlinkSync(root, project, 'dir');
    const command = settings.hooks.PreToolUse[0].hooks[0].command;
    const result = spawnSync(command, {
      shell: true,
      cwd: temp,
      env: { ...process.env, CLAUDE_PROJECT_DIR: project },
      input: JSON.stringify({ tool_name: 'Agent', tool_input: { prompt: 'PRIVATE_INPUT' } }),
      encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    const output = JSON.parse(result.stdout);
    assert.equal(output.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(output.hookSpecificOutput.permissionDecisionReason, /Orca/);
    assert.doesNotMatch(result.stdout, /PRIVATE_INPUT/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
