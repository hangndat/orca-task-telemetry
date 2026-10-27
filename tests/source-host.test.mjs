import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  assertLocalHostListRow,
  resolveLocalSourceHostIdentity,
  storageHostIdForRuntime,
} from '../dist/orca/source-host.js';

const RUNTIME_A = '06551f0f-165a-47ae-8eb4-62044b73db9f';
const RUNTIME_B = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function statusEnvelope(runtimeId, kind = 'local') {
  return {
    ok: true,
    result: {
      target: { kind },
      runtime: { reachable: true, runtimeId },
    },
    _meta: { runtimeId },
  };
}

test('resolveLocalSourceHostIdentity namespaces verified runtimeId', () => {
  const identity = resolveLocalSourceHostIdentity(statusEnvelope(RUNTIME_A));
  assert.equal(identity.orcaHostLabel, 'local');
  assert.equal(identity.runtimeId, RUNTIME_A);
  assert.equal(identity.storageHostId, storageHostIdForRuntime(RUNTIME_A));
  assert.match(identity.storageHostId, /^orca:runtime:v1:/);
});

test('two runtime endpoints never share storage host id (clone / collision fixture)', () => {
  const a = resolveLocalSourceHostIdentity(statusEnvelope(RUNTIME_A));
  const b = resolveLocalSourceHostIdentity(statusEnvelope(RUNTIME_B));
  assert.notEqual(a.storageHostId, b.storageHostId);
});

test('remote target is refused', () => {
  const failure = resolveLocalSourceHostIdentity(statusEnvelope(RUNTIME_A, 'ssh'));
  assert.equal(failure.code, 'source_host_remote_unsupported');
});

test('missing or mismatched runtimeId stays unverified', () => {
  assert.equal(
    resolveLocalSourceHostIdentity({
      ok: true,
      result: { target: { kind: 'local' }, runtime: { reachable: true } },
      _meta: {},
    }).code,
    'orca_source_host_unverified',
  );
  assert.equal(
    resolveLocalSourceHostIdentity({
      ok: true,
      result: {
        target: { kind: 'local' },
        runtime: { reachable: true, runtimeId: RUNTIME_A },
      },
      _meta: { runtimeId: RUNTIME_B },
    }).code,
    'orca_source_host_unverified',
  );
});

test('assertLocalHostListRow accepts exactly one local id=local', () => {
  assert.equal(
    assertLocalHostListRow({
      ok: true,
      result: {
        hosts: [
          { kind: 'local', id: 'local', machineName: 'box', platform: 'darwin' },
          { kind: 'ssh', id: 'ssh-1' },
        ],
      },
    }),
    null,
  );
  assert.equal(
    assertLocalHostListRow({
      ok: true,
      result: { hosts: [{ kind: 'local', id: 'not-local' }] },
    }).code,
    'source_host_invalid',
  );
});
