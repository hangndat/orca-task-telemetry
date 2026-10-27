import assert from 'node:assert/strict';
import { test } from 'vitest';
import { collectOrcaRunProvenance } from '../dist/orca/run-provenance.js';

const runId = 'run_A';
const hostId = 'local';
const response = (result) => ({ stdout: JSON.stringify({ ok: true, result }), stderr: '', exitCode: 0 });

function fixture({ tasks = 102, host = hostId, workerHost = host, run = runId, brokenPage = false,
  cursorLoop = false, truncatedTasks = false, taskListTruncated = false,
  missingWorker = false, duplicate = false } = {}) {
  const calls = [];
  const taskRows = Array.from({ length: tasks }, (_, i) => ({
    id: `task_${i}`, run_id: run, parent_id: null, status: 'completed',
    spec: 'SECRET_TASK_SPEC', spec_truncated: true,
  }));
  const workerRows = taskRows.map((task, i) => ({
    dispatchId: duplicate && i === 1 ? 'ctx_0' : `ctx_${i}`,
    taskId: task.id, runId: run, agentTerminalHandle: null, terminalState: 'released',
    resource: { worktreeId: null, preview: 'SECRET_PREVIEW' },
    projection: { dispatchId: duplicate && i === 1 ? 'ctx_0' : `ctx_${i}`,
      taskId: task.id, runId: run, host: { id: workerHost }, provider: { secret: 'SECRET_PROVIDER' } },
  })).filter((_, i) => !missingWorker || i !== 0);
  async function invoke(argv) {
    calls.push(argv);
    const command = argv[1];
    if (command === 'run-show') return response({ run: { id: run, coordinator_handle: null, objective: 'SECRET_OBJECTIVE' } });
    if (command === 'task-list') return response({ runId: run, tasks: taskRows,
      count: tasks + Number(truncatedTasks), truncated: truncatedTasks || taskListTruncated });
    if (command === 'dispatch-show') {
      const index = Number(argv[argv.indexOf('--task') + 1].split('_')[1]);
      return response({ dispatch: { id: duplicate && index === 1 ? 'ctx_0' : `ctx_${index}`,
        run_id: run, task_id: `task_${index}`,
        host_scope: JSON.stringify({ kind: 'local', hostId: host }),
        creator_orca_session_id: null, assignee_orca_session_id: null,
        preview: 'SECRET_DISPATCH' } });
    }
    if (command === 'worker-list') {
      const cursor = argv.includes('--cursor') ? argv[argv.indexOf('--cursor') + 1] : null;
      if (brokenPage && cursor) throw new Error('SECRET_ERROR');
      const offset = cursor ? 100 : 0;
      const rows = workerRows.slice(offset, offset + 100);
      const hasMore = offset + rows.length < workerRows.length;
      return response({ scope: { run, source: 'flag' }, workers: rows,
        page: { limit: 100, total: workerRows.length, hasMore,
          nextCursor: hasMore ? (cursorLoop ? 'loop' : 'page2') : null } });
    }
    throw new Error(`unexpected ${argv.join(' ')}`);
  }
  return { calls, invoke };
}

async function collect(stub, overrides = {}) {
  return collectOrcaRunProvenance(runId, {
    sourceHostId: hostId, readVersion: async () => '1.4.241', invoke: stub.invoke, ...overrides,
  });
}

test('enumerates 102 Tasks/Dispatches and two worker pages, preserving nulls and allowlist', async () => {
  const stub = fixture();
  const result = await collect(stub);
  assert.equal(result.complete, true);
  assert.equal(result.tasks.length, 102);
  assert.equal(result.dispatches.length, 102);
  assert.equal(result.workers.length, 102);
  assert.equal(result.pagesRead, 2);
  assert.equal(stub.calls.length, 106); // run + task + 102 dispatch + 2 pages
  assert.equal(result.coordinatorHandle, null);
  assert.equal(result.workers[0].worktreeId, null);
  assert.ok(!JSON.stringify(result).includes('SECRET'));
  assert.ok(stub.calls.every((argv) => !argv.includes('--preamble')));
});

test('task-list count disagreement is partial, never silently complete', async () => {
  const result = await collect(fixture({ tasks: 1, truncatedTasks: true }));
  assert.equal(result.complete, false);
  assert.ok(result.errors.some((error) => error.code === 'unprovable_completeness'));
});

test('task-list truncation marker is partial even when count equals returned rows', async () => {
  const result = await collect(fixture({ tasks: 1, taskListTruncated: true }));
  assert.equal(result.complete, false);
  assert.ok(result.errors.some((error) => error.code === 'unprovable_completeness'));
});

test('verified Dispatch without a worker row is partial', async () => {
  const result = await collect(fixture({ tasks: 1, missingWorker: true }));
  assert.equal(result.complete, false);
  assert.ok(result.errors.some((error) => error.code === 'missing_worker'));
});

test('second worker page failure is partial with no inferred workers', async () => {
  const result = await collect(fixture({ brokenPage: true }));
  assert.equal(result.complete, false);
  assert.equal(result.workers.length, 100);
  assert.ok(result.errors.some((error) => error.code === 'source_failure'));
  assert.ok(!JSON.stringify(result).includes('SECRET_ERROR'));
});

test('cursor loop terminates as partial', async () => {
  const stub = fixture({ tasks: 250, cursorLoop: true });
  const result = await collect(stub);
  assert.equal(result.complete, false);
  assert.ok(result.errors.some((error) => error.code === 'cursor_loop'));
  assert.ok(result.pagesRead <= 3);
});

test('more than 100 advertised worker pages stops at the page cap', async () => {
  const stub = fixture({ tasks: 100 });
  const baseInvoke = stub.invoke;
  const invoke = async (argv) => {
    if (argv[1] !== 'worker-list') return baseInvoke(argv);
    stub.calls.push(argv);
    const index = argv.includes('--cursor') ? Number(argv[argv.indexOf('--cursor') + 1]) : 0;
    return response({ scope: { run: runId, source: 'flag' },
      workers: [{ dispatchId: `ctx_${index}`, taskId: `task_${index}`, runId,
        agentTerminalHandle: null, terminalState: null, resource: { worktreeId: null },
        projection: { dispatchId: `ctx_${index}`, taskId: `task_${index}`, runId,
          host: { id: hostId } } }],
      page: { limit: 100, total: 10_000, hasMore: true, nextCursor: String(index + 1) } });
  };
  const result = await collect({ invoke });
  assert.equal(result.complete, false);
  assert.equal(result.pagesRead, 100);
  assert.equal(stub.calls.filter((argv) => argv[1] === 'worker-list').length, 100);
  assert.ok(result.errors.some((error) => error.code === 'page_limit'));
});

test('wrong source host and duplicate dispatch IDs are rejected', async () => {
  const wrongHost = await collect(fixture({ tasks: 1, host: 'other' }));
  assert.equal(wrongHost.complete, false);
  assert.ok(wrongHost.errors.some((error) => error.code === 'host_mismatch'));
  const wrongWorkerHost = await collect(fixture({ tasks: 1, workerHost: 'other' }));
  assert.equal(wrongWorkerHost.complete, false);
  assert.ok(wrongWorkerHost.errors.some((error) => error.code === 'worker_mismatch'));
  const duplicate = await collect(fixture({ tasks: 2, duplicate: true }));
  assert.equal(duplicate.complete, false);
  assert.ok(duplicate.errors.some((error) => error.code === 'duplicate_dispatch'));
});

test('empty Run has no host proof and stays partial', async () => {
  const result = await collect(fixture({ tasks: 0 }));
  assert.equal(result.complete, false);
  assert.ok(result.errors.some((error) => error.code === 'host_unverified'));
});

test('same host and raw dispatch ID remain separate under two explicit Runs', async () => {
  const a = fixture({ tasks: 1 });
  const b = fixture({ tasks: 1, run: 'run_B' });
  const first = await collect(a);
  const second = await collectOrcaRunProvenance('run_B', {
    sourceHostId: hostId, readVersion: async () => '1.4.241', invoke: b.invoke,
  });
  assert.equal(first.complete, true);
  assert.equal(second.complete, true);
  assert.equal(first.dispatches[0].dispatchId, second.dispatches[0].dispatchId);
  assert.notEqual(first.runId, second.runId);
});
