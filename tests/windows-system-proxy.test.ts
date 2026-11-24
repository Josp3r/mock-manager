import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { SystemProxyController } from '../src/main/system-proxy';
import { WindowsSystemProxyError } from '../src/main/windows-system-proxy';
import type { ProxyChange, ProxySnapshot, SystemProxyAdapter } from '../src/main/system-proxy-types';

// Only the OS boundary is simulated: the production controller writes real journals.
class WindowsPreferences implements SystemProxyAdapter {
  supported = true;
  readonly platform = 'win32' as const;
  writes = 0;
  readError?: Error;
  beforeWrite?: () => void;
  snapshot: ProxySnapshot = {
    location: 'wininet-current-user',
    services: [{ id: 'lan', name: 'Windows LAN', active: true, enabled: true, configuration: {
      flags: 13, proxyServer: 'http=old.example:8000;socks=socks.example:1080',
      proxyBypass: '<local>;*.内部.example', autoConfigURL: 'https://pac.example/settings.pac', autoDiscoveryFlags: 33,
    } }],
  };
  async read() { if (this.readError) throw this.readError; return structuredClone(this.snapshot); }
  async write(changes: ProxyChange[], location?: string) {
    this.writes++;
    this.beforeWrite?.();
    this.beforeWrite = undefined;
    if (location !== undefined && location !== this.snapshot.location) throw new Error('conflict');
    for (const change of changes) {
      const service = this.snapshot.services.find(item => item.id === change.id);
      if (!service || !isDeepStrictEqual(change.expected, { enabled: service.enabled, configuration: service.configuration })) throw new Error('conflict');
    }
    for (const change of changes) Object.assign(this.snapshot.services.find(item => item.id === change.id)!, structuredClone(change.next));
  }
}
const dirs: string[] = [];
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'windows-proxy-controller-'));
  dirs.push(root);
  const adapter = new WindowsPreferences();
  return { root, adapter, controller: new SystemProxyController(root, adapter), journal: join(root, 'system-proxy.json') };
}
afterEach(async () => { await Promise.all(dirs.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('Windows system proxy journal/controller', () => {
  it('detects active PAC and automatic detection as external Windows proxy settings', async () => {
    const { controller } = await setup();
    expect(await controller.status()).toMatchObject({ state: 'external', managed: false, services: ['Windows LAN'] });
  });

  it('installs only HTTP/HTTPS, persists the Windows format, and restores every original WinINet field after restart', async () => {
    const { controller, adapter, journal, root } = await setup();
    const before = structuredClone(adapter.snapshot);
    expect(await controller.enable({ host: '0.0.0.0', port: 8899 })).toMatchObject({ state: 'on', managed: true });
    expect(adapter.snapshot.services[0].configuration).toEqual({
      flags: 3, proxyServer: 'http=127.0.0.1:8899;https=127.0.0.1:8899',
      proxyBypass: '<local>;*.内部.example', autoConfigURL: 'https://pac.example/settings.pac', autoDiscoveryFlags: 33,
    });
    expect(JSON.parse(await readFile(journal, 'utf8'))).toMatchObject({ platform: 'win32', phase: 'active' });
    expect(await new SystemProxyController(root, adapter).disable()).toMatchObject({ state: 'external', managed: false });
    expect(adapter.snapshot).toEqual(before);
    await expect(stat(journal)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('restores Windows journals without relying on POSIX permission bits', async () => {
    const { controller, adapter, journal, root } = await setup();
    await controller.enable({ host: '127.0.0.1', port: 8899 });
    await chmod(journal, 0o666);
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      expect(await new SystemProxyController(root, adapter).disable()).toMatchObject({ state: 'external', managed: false });
    } finally { Object.defineProperty(process, 'platform', descriptor); }
  });

  it('brackets IPv6 proxy destinations for WinINet protocol mappings', async () => {
    const { controller, adapter } = await setup();
    expect(await controller.enable({ host: '::1', port: 9000 })).toMatchObject({ state: 'on' });
    expect(adapter.snapshot.services[0].configuration.proxyServer).toBe('http=[::1]:9000;https=[::1]:9000');
  });

  it('preserves an external PAC edit and leaves recovery data available', async () => {
    const { controller, adapter, journal } = await setup();
    await controller.enable({ host: '127.0.0.1', port: 8899 });
    adapter.snapshot.services[0].configuration.autoConfigURL = 'https://changed.example/proxy.pac';
    expect(await controller.disable()).toMatchObject({ state: 'changed', managed: true });
    expect(adapter.writes).toBe(1);
    expect(adapter.snapshot.services[0].configuration.autoConfigURL).toBe('https://changed.example/proxy.pac');
    expect(await stat(journal)).toBeDefined();
  });

  it.each(['unsupportedPolicy', 'credentials'])('allows explicit archive after %s prevents restoration, without changing OS preferences', async code => {
    const { controller, adapter, journal, root } = await setup();
    await controller.enable({ host: '127.0.0.1', port: 8899 });
    const backup = await readFile(journal, 'utf8');
    adapter.readError = new WindowsSystemProxyError(code);
    const restarted = new SystemProxyController(root, adapter);
    expect(await restarted.status()).toMatchObject({ state: 'changed', managed: true, message: expect.stringMatching(/备份/) });
    expect(await restarted.disable()).toMatchObject({ state: 'changed', managed: true });
    expect(await readFile(journal, 'utf8')).toBe(backup);
    expect(adapter.writes).toBe(1);
    expect(await restarted.release()).toMatchObject({ state: 'error', managed: false });
    expect(adapter.writes).toBe(1);
    await expect(stat(journal)).rejects.toMatchObject({ code: 'ENOENT' });
    const archives = (await readdir(root)).filter(name => name.startsWith('system-proxy.recovery-'));
    expect(archives).toHaveLength(1);
    expect(await readFile(join(root, archives[0]), 'utf8')).toBe(backup);
    expect(await restarted.status()).toMatchObject({ state: 'error', managed: false });
  });

  it.each(['readFailed', 'timeout', 'invalidResponse', 'unknown'])('retains the journal when a transient or untrusted %s error prevents reading', async code => {
    const { controller, adapter, journal, root } = await setup();
    await controller.enable({ host: '127.0.0.1', port: 8899 });
    const backup = await readFile(journal, 'utf8');
    adapter.readError = new WindowsSystemProxyError(code);
    expect(await controller.status()).toMatchObject({ state: 'error', managed: true });
    expect(await controller.release()).toMatchObject({ state: 'error', managed: true });
    expect(await readFile(journal, 'utf8')).toBe(backup);
    expect((await readdir(root)).filter(name => name.includes('.recovery-'))).toEqual([]);
    expect(adapter.writes).toBe(1);
  });

  it.each(['unsupportedPolicy', 'credentials'])('never archives a malformed journal even with a %s refusal', async code => {
    const { controller, adapter, journal, root } = await setup();
    await controller.enable({ host: '127.0.0.1', port: 8899 });
    await writeFile(journal, '{}');
    adapter.readError = new WindowsSystemProxyError(code);
    expect(await controller.release()).toMatchObject({ state: 'error', managed: true });
    expect(await readFile(journal, 'utf8')).toBe('{}');
    expect((await readdir(root)).filter(name => name.includes('.recovery-'))).toEqual([]);
    expect(adapter.writes).toBe(1);
  });

  it('rejects legacy macOS journals on Windows before any write', async () => {
    const { controller, adapter, journal } = await setup();
    const before = [{ id: 'lan', name: 'LAN', enabled: true, configuration: {} }];
    await writeFile(journal, JSON.stringify({ version: 1, phase: 'active', target: { host: '127.0.0.1', port: 8899 }, before, installed: [{
      ...before[0], configuration: { HTTPEnable: 1, HTTPProxy: '127.0.0.1', HTTPPort: 8899, HTTPSEnable: 1, HTTPSProxy: '127.0.0.1', HTTPSPort: 8899, ProxyAutoConfigEnable: 0, ProxyAutoDiscoveryEnable: 0, SOCKSEnable: 0 },
    }] }), { mode: 0o600 });
    expect(await controller.disable()).toMatchObject({ state: 'error', managed: true });
    expect(adapter.writes).toBe(0);
    expect(await stat(journal)).toBeDefined();
  });

  it('rejects Windows journals on macOS before any write', async () => {
    const { controller, adapter, journal, root } = await setup();
    await controller.enable({ host: '127.0.0.1', port: 8899 });
    const macAdapter = { supported: true, read: () => adapter.read(), write: (changes: ProxyChange[]) => adapter.write(changes) };
    expect(await new SystemProxyController(root, macAdapter).disable()).toMatchObject({ state: 'error', managed: true });
    expect(adapter.writes).toBe(1);
    expect(await stat(journal)).toBeDefined();
  });

  it.each(['http=user:secret@proxy.example:80', 'user%3Asecret%40proxy.example:80'])(
    'refuses proxy credential syntax before persisting %s', async proxyServer => {
      const { controller, adapter, journal } = await setup();
      adapter.snapshot.services[0].configuration.proxyServer = proxyServer;
      expect(await controller.enable({ host: '127.0.0.1', port: 8899 })).toMatchObject({ state: 'error', managed: false });
      expect(adapter.writes).toBe(0);
      await expect(stat(journal)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );
});
