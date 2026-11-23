import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WindowsSystemProxy } from '../src/main/windows-system-proxy';
import type { ProxyChange, ProxySnapshot } from '../src/main/system-proxy-types';

const transport = vi.hoisted(() => ({ fixture: '', invocation: undefined as unknown }));
vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return { ...original, spawn: (executable: string, args: string[], options: object) => {
    transport.invocation = { executable, args, options };
    // Execute a real child process for stdio, Unicode, exit and output-limit behavior.
    // Only Windows PowerShell itself is replaced; no machine preferences are touched.
    return original.spawn(process.execPath, [transport.fixture, args.at(-1)!], options);
  } };
});
const snapshot: ProxySnapshot = { location: 'wininet-current-user', services: [{
  id: 'lan', name: 'Windows LAN', enabled: true, active: true,
  configuration: { flags: 13, proxyServer: null, proxyBypass: '<local>;*.内部.example', autoConfigURL: 'https://pac.example/配置.pac', autoDiscoveryFlags: 32 },
}] };
const changes: ProxyChange[] = [{ id: 'lan',
  expected: { enabled: true, configuration: snapshot.services[0].configuration },
  next: { enabled: true, configuration: { ...snapshot.services[0].configuration, flags: 3, proxyServer: 'http=127.0.0.1:8899;https=127.0.0.1:8899' } },
}];
let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'windows-proxy-process-')); vi.stubEnv('SystemRoot', 'C:\\Windows'); });
afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { force: true, recursive: true }); });
async function helper(body: string) {
  transport.fixture = join(directory, 'fixture.cjs');
  await writeFile(transport.fixture, body);
  const adapter = new WindowsSystemProxy('C:\\应用 空格\\proxy ; literal.ps1');
  Object.defineProperty(adapter, 'supported', { value: true });
  return adapter;
}

describe('Windows system proxy process boundary', () => {
  it('uses the inbox PowerShell executable with literal arguments and exchanges UTF-8 over stdin/stdout', async () => {
    const adapter = await helper(`
      const fs = require('node:fs');
      if (process.argv[2] === 'read') process.stdout.write(JSON.stringify(${JSON.stringify(snapshot)}));
      else if (fs.readFileSync(0, 'utf8') === JSON.stringify(${JSON.stringify({ changes, expectedLocation: snapshot.location })})) process.stdout.write('{"ok":true}');
      else process.exitCode = 1;
    `);
    expect(await adapter.read()).toEqual(snapshot);
    await expect(adapter.write(changes, snapshot.location)).resolves.toBeUndefined();
    expect(transport.invocation).toEqual({
      executable: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\应用 空格\\proxy ; literal.ps1', 'write'],
      options: { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] },
    });
  });

  it('reports managed policy refusal without echoing helper private output', async () => {
    const adapter = await helper(`process.stdout.write('{"error":"unsupportedPolicy","secret":"private-PAC"}'); process.stderr.write('private-password'); process.exitCode = 1;`);
    await expect(adapter.read()).rejects.toMatchObject({ code: 'unsupportedPolicy', message: expect.stringMatching(/策略/) });
    await expect(adapter.read()).rejects.not.toThrow(/private/);
  });

  it.each([
    { ...snapshot, services: [snapshot.services[0], snapshot.services[0]] },
    { ...snapshot, services: [{ ...snapshot.services[0], configuration: { ...snapshot.services[0].configuration, flags: 16 } }] },
    { ...snapshot, services: [{ ...snapshot.services[0], configuration: { ...snapshot.services[0].configuration, proxyServer: 'user:password@private.example' } }] },
  ])('rejects unsafe native snapshots before they can enter a recovery journal', async value => {
    const adapter = await helper(`process.stdout.write(JSON.stringify(${JSON.stringify(value)}));`);
    await expect(adapter.read()).rejects.toMatchObject({ code: 'invalidResponse' });
  });

  it('kills an oversized response and rejects it without retaining its content', async () => {
    const adapter = await helper(`process.stdout.write('x'.repeat(3 * 1024 * 1024));`);
    await expect(adapter.read()).rejects.toMatchObject({ code: 'invalidResponse' });
  });

  it('rejects invalid writes before launching the native helper', async () => {
    const adapter = await helper(`process.stdout.write('{"ok":true}');`);
    transport.invocation = undefined;
    await expect(adapter.write([{ ...changes[0], next: { ...changes[0].next, configuration: { ...changes[0].next.configuration, unknownSecret: 'private' } } }])).rejects.toMatchObject({ code: 'invalidRequest' });
    expect(transport.invocation).toBeUndefined();
  });

  it('sanitizes unknown helper errors', async () => {
    const adapter = await helper(`process.stdout.write('{"error":"private-password"}'); process.exitCode = 1;`);
    await expect(adapter.read()).rejects.toMatchObject({ code: 'unknown', message: expect.not.stringContaining('private') });
  });
});
