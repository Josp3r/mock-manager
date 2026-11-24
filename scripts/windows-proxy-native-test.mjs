// This script intentionally changes WinINet preferences. Never run on a user's PC.
// Its fail-closed gate permits disposable GitHub-hosted Windows CI only.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WindowsSystemProxy } from '../src/main/windows-system-proxy.ts';
import { SystemProxyController } from '../src/main/system-proxy.ts';

if (process.platform !== 'win32' || process.env.CI !== 'true' || process.env.GITHUB_ACTIONS !== 'true'
    || process.env.RUNNER_ENVIRONMENT !== 'github-hosted' || process.env.RUNNER_OS !== 'Windows'
    || process.env.MOCK_MANAGER_PROXY_MUTATION_TEST !== '1') {
  throw new Error('Real proxy mutation is restricted to opted-in disposable GitHub-hosted Windows runners.');
}
const adapter = new WindowsSystemProxy(resolve('src/native/windows-system-proxy.ps1'));
const original = await adapter.read();
const state = service => ({ enabled: service.enabled, configuration: service.configuration });
const root = await mkdtemp(join(tmpdir(), 'mock-manager-wininet-ci-'));
let restored = false;
try {
  // The first operation must preserve the untouched OS snapshot, including null
  // strings. This catches PowerShell coercing null C# strings to empty strings
  // before the compare, as well as accidental null/empty changes on writes.
  await adapter.write([{ id: 'lan', expected: state(original.services[0]), next: state(original.services[0]) }], original.location);
  assert.deepEqual(await adapter.read(), original, 'No-op compare/write must preserve the untouched Windows snapshot');
  // Establish an inactive, nonempty baseline to exercise Unicode, PAC and bypass restoration.
  const baseline = { enabled: true, configuration: {
    ...original.services[0].configuration,
    flags: 1, proxyServer: 'http=127.0.0.1:49876;socks=127.0.0.1:49877',
    proxyBypass: '<local>;*.example.test;内部.example.test', autoConfigURL: 'http://127.0.0.1:49878/settings.pac',
  } };
  await adapter.write([{ id: 'lan', expected: state(original.services[0]), next: baseline }], original.location);
  const baselineRead = await adapter.read();
  assert.deepEqual(state(baselineRead.services[0]), baseline, 'WinINet must preserve the complete inactive baseline');
  const controller = new SystemProxyController(root, adapter);
  assert.equal((await controller.enable({ host: '127.0.0.1', port: 49879 })).state, 'on');
  const installed = await adapter.read();
  assert.deepEqual(installed.services[0].configuration, {
    ...baseline.configuration, flags: 3, proxyServer: 'http=127.0.0.1:49879;https=127.0.0.1:49879',
  });
  await assert.rejects(adapter.write([{ id: 'lan', expected: baseline, next: baseline }], original.location), { code: 'conflict' });
  assert.deepEqual(await adapter.read(), installed, 'Stale expectations must not change Windows settings');
  assert.equal((await new SystemProxyController(root, adapter).disable()).state, 'off');
  assert.deepEqual(state((await adapter.read()).services[0]), baseline, 'Restart must restore every original field');
  console.log('Windows WinINet native read, write, conflict and restart recovery: passed');
} finally {
  // Always restore the runner's exact starting state, even when installation or assertions fail.
  // Re-read immediately before the compare/write so a stale test snapshot cannot be applied.
  try {
    const current = await adapter.read();
    await adapter.write([{ id: 'lan', expected: state(current.services[0]), next: state(original.services[0]) }], original.location);
    assert.deepEqual(await adapter.read(), original, 'Runner proxy restoration must be verified');
    restored = true;
    console.log('Windows WinINet original preferences restored and verified');
  } finally {
    // Preserve recovery journals if restoration failed; do not delete the only backup.
    if (restored) await rm(root, { recursive: true, force: true });
  }
}
