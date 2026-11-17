import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { SystemProxyController } from '../src/main/system-proxy';
import type { ProxyChange, ProxyService, ProxySnapshot, SystemProxyAdapter } from '../src/main/system-proxy-types';

class TestAdapter implements SystemProxyAdapter {
  supported = true;
  snapshot: ProxySnapshot = { location: 'home', services: [] };
  attempts: { changes: ProxyChange[]; location?: string }[] = [];
  nextWrite?: () => Promise<void>;
  failRead = false;

  async read() {
    if (this.failRead) throw new Error('unreadable proxy preferences');
    return structuredClone(this.snapshot);
  }

  async write(changes: ProxyChange[], location?: string) {
    this.attempts.push({ changes: structuredClone(changes), location });
    const hook = this.nextWrite;
    this.nextWrite = undefined;
    await hook?.();
    if (location !== undefined && location !== this.snapshot.location) throw new Error('network location changed');
    for (const { id, expected } of changes) {
      const service = this.snapshot.services.find((entry) => entry.id === id);
      if (!service || !isDeepStrictEqual(expected, { enabled: service.enabled, configuration: service.configuration })) {
        throw new Error('proxy compare failed');
      }
    }
    changes.forEach((change) => this.apply(change));
  }

  apply({ id, next }: ProxyChange) {
    const service = this.snapshot.services.find((entry) => entry.id === id)!;
    Object.assign(service, structuredClone(next));
  }
}

const service: ProxyService = {
  id: 'wifi',
  name: 'Wi-Fi',
  active: true,
  enabled: false,
  configuration: {
    HTTPEnable: 0, HTTPProxy: 'original.example', HTTPPort: 443,
    HTTPSEnable: 1, HTTPSProxy: 'secure.example', HTTPSPort: 3128,
    ProxyAutoConfigEnable: 1, ProxyAutoConfigURLString: 'https://private.example/config.pac',
    ProxyAutoDiscoveryEnable: 1, SOCKSEnable: 1, SOCKSProxy: 'socks.example',
    ExceptionsList: ['localhost', '*.dev'], ExcludeSimpleHostnames: 1,
    OtherPlistValues: { Nested: ['sample', 4, false] },
  },
};
const ethernet: ProxyService = {
  id: 'ethernet', name: 'Ethernet', active: true, enabled: true,
  configuration: { HTTPEnable: 1, HTTPProxy: 'ethernet.example', HTTPPort: 80 },
};
const target = { host: '0.0.0.0', port: 8899 };
const directories: string[] = [];

async function setup(services = [service]) {
  const root = await mkdtemp(join(tmpdir(), 'mock-manager-proxy-'));
  directories.push(root);
  const adapter = new TestAdapter();
  adapter.snapshot.services = structuredClone(services);
  const controller = new SystemProxyController(root, adapter);
  return { root, adapter, controller, journal: join(root, 'system-proxy.json') };
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('SystemProxyController', () => {
  it('journals privately before writing, changes active services, and restores complete original states', async () => {
    const inactive = { ...ethernet, active: false };
    const { adapter, controller, journal } = await setup([service, inactive]);
    adapter.nextWrite = async () => {
      expect((await stat(journal)).mode & 0o777).toBe(0o600);
      expect(await readFile(journal, 'utf8')).toContain('original.example');
    };
    const status = await controller.enable(target);
    expect(status).toEqual({ supported: true, state: 'on', managed: true, address: '127.0.0.1:8899', services: ['Wi-Fi'] });
    expect(adapter.attempts[0].location).toBe('home');
    expect(adapter.snapshot.services).toEqual([{
      ...service,
      enabled: true,
      configuration: {
        ...service.configuration,
        HTTPEnable: 1, HTTPProxy: '127.0.0.1', HTTPPort: 8899,
        HTTPSEnable: 1, HTTPSProxy: '127.0.0.1', HTTPSPort: 8899,
        ProxyAutoConfigEnable: 0, ProxyAutoDiscoveryEnable: 0, SOCKSEnable: 0,
      },
    }, inactive]);

    expect(await controller.disable()).toMatchObject({ state: 'off', managed: false });
    expect(adapter.attempts[1].location).toBeUndefined();
    expect(adapter.snapshot.services).toEqual([service, inactive]);
    await expect(stat(journal)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['HTTPProxyAuthenticated', 'HTTPSEncryptedPassword', 'http-user', 'HTTPSCredential'])(
    'refuses takeover with %s metadata without exposing it',
    async (key) => {
      const value = 'sensitive-value';
      const { controller, adapter, journal } = await setup([service, {
        ...ethernet, configuration: { ...ethernet.configuration, [key]: value },
      }]);
      const status = await controller.enable(target);
      expect(status).toMatchObject({ state: 'error', managed: false });
      expect(status.message).toMatch(/认证/);
      expect(JSON.stringify(status)).not.toContain(value);
      expect(adapter.attempts).toHaveLength(0);
      await expect(stat(journal)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('surfaces cancelled enable and removes the unused backup after confirming original values', async () => {
    const { controller, adapter, journal } = await setup();
    adapter.nextWrite = async () => { throw new Error('已取消系统代理授权'); };
    expect(await controller.enable(target)).toMatchObject({ state: 'error', managed: false, message: expect.stringMatching(/取消/) });
    expect(adapter.snapshot.services).toEqual([service]);
    await expect(stat(journal)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports native write timeouts without passing through configuration details', async () => {
    const { controller, adapter } = await setup();
    adapter.nextWrite = async () => {
      throw new Error('系统代理操作超时，请检查 macOS 授权窗口。 https://private.example/config.pac');
    };
    const status = await controller.enable(target);
    expect(status).toMatchObject({ state: 'error', managed: false, message: expect.stringMatching(/超时/) });
    expect(status.message).not.toContain('private.example');
  });

  it('keeps a recoverable backup after cancelled disable', async () => {
    const { controller, adapter, journal } = await setup();
    await controller.enable(target);
    adapter.nextWrite = async () => { throw new Error('已取消系统代理授权'); };
    expect(await controller.disable()).toMatchObject({ state: 'error', managed: true, message: expect.stringMatching(/取消/) });
    expect(await controller.status()).toMatchObject({ state: 'on', managed: true });
    expect(await stat(journal)).toBeDefined();
    expect(await controller.disable()).toMatchObject({ state: 'off', managed: false });
  });

  it('recovers a complete per-service mixture after a partially committed enable', async () => {
    const { root, controller, adapter, journal } = await setup([service, ethernet]);
    adapter.nextWrite = async () => {
      adapter.apply(adapter.attempts[0].changes[0]);
      throw new Error('partial apply');
    };
    expect(await controller.enable(target)).toMatchObject({ state: 'error', managed: true });
    expect(await stat(journal)).toBeDefined();
    const restarted = new SystemProxyController(root, adapter);
    expect(await restarted.status()).toMatchObject({ state: 'changed', managed: true, message: expect.stringMatching(/恢复/) });
    expect(await restarted.disable()).toMatchObject({ state: 'external', managed: false });
    expect(adapter.snapshot.services).toEqual([service, ethernet]);
  });

  it('retains pending status when enable commits but cannot apply settings', async () => {
    const { root, controller, adapter, journal } = await setup();
    adapter.nextWrite = async () => {
      adapter.apply(adapter.attempts[0].changes[0]);
      throw new Error('macOS 已保存代理设置，但未能应用，请重试。');
    };
    expect(await controller.enable(target)).toMatchObject({ state: 'error', managed: true });
    expect(await stat(journal)).toBeDefined();
    const restarted = new SystemProxyController(root, adapter);
    expect(await restarted.status()).toMatchObject({ state: 'changed', managed: true, message: expect.stringMatching(/恢复/) });
    expect(await restarted.disable()).toMatchObject({ state: 'off', managed: false });
    expect(adapter.snapshot.services).toEqual([service]);
  });

  it('keeps a backup while installation readback is unavailable', async () => {
    const { root, controller, adapter, journal } = await setup();
    adapter.nextWrite = async () => { adapter.failRead = true; };
    expect(await controller.enable(target)).toMatchObject({ state: 'error', managed: true });
    expect(await controller.status()).toMatchObject({ state: 'error', managed: true });
    expect(await stat(journal)).toBeDefined();
    adapter.failRead = false;
    const restarted = new SystemProxyController(root, adapter);
    expect(await restarted.status()).toMatchObject({ state: 'changed', managed: true });
    expect(await restarted.disable()).toMatchObject({ state: 'off', managed: false });
  });

  it('keeps a backup until it can confirm an interrupted restore', async () => {
    const { controller, adapter, journal } = await setup();
    await controller.enable(target);
    adapter.nextWrite = async () => { adapter.failRead = true; };
    expect(await controller.disable()).toMatchObject({ state: 'error', managed: true });
    expect(await stat(journal)).toBeDefined();
    adapter.failRead = false;
    expect(await controller.status()).toMatchObject({ state: 'changed', managed: true });
    expect(await controller.disable()).toMatchObject({ state: 'off', managed: false });
    expect(adapter.attempts).toHaveLength(3);
    await expect(stat(journal)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reapplies original preferences when a previous restore committed but could not apply', async () => {
    const { root, controller, adapter, journal } = await setup();
    await controller.enable(target);
    adapter.nextWrite = async () => {
      adapter.apply(adapter.attempts[1].changes[0]);
      throw new Error('macOS 已保存代理设置，但未能应用，请重试。');
    };
    expect(await controller.disable()).toMatchObject({ state: 'error', managed: true, message: expect.stringMatching(/应用/) });
    expect(adapter.snapshot.services).toEqual([service]);
    expect(await stat(journal)).toBeDefined();

    const restarted = new SystemProxyController(root, adapter);
    expect(await restarted.disable()).toMatchObject({ state: 'off', managed: false });
    expect(adapter.attempts[2]?.changes).toEqual([{
      id: 'wifi',
      expected: { enabled: service.enabled, configuration: service.configuration },
      next: { enabled: service.enabled, configuration: service.configuration },
    }]);
    await expect(stat(journal)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses all restore writes when a managed service has external drift', async () => {
    const { controller, adapter, journal } = await setup([service, ethernet]);
    await controller.enable(target);
    adapter.snapshot.services[1].configuration.ProxyAutoConfigURLString = 'https://secret.example/other.pac';
    const current = await adapter.read();
    const status = await controller.disable();
    expect(status).toMatchObject({ state: 'changed', managed: true });
    expect(JSON.stringify(status)).not.toContain('secret.example');
    expect(adapter.attempts).toHaveLength(1);
    expect(await adapter.read()).toEqual(current);
    expect(await stat(journal)).toBeDefined();
  });

  it('checks full snapshots under the adapter compare-and-set when a service changes during authorization', async () => {
    const { controller, adapter, journal } = await setup([service, ethernet]);
    await controller.enable(target);
    adapter.nextWrite = async () => { adapter.snapshot.services[1].enabled = false; };
    expect(await controller.disable()).toMatchObject({ state: 'changed', managed: true });
    expect(adapter.snapshot.services[0].enabled).toBe(true);
    expect(await stat(journal)).toBeDefined();
  });

  it('reports missing services without restoring others or dropping the backup', async () => {
    const { controller, adapter, journal } = await setup([service, ethernet]);
    await controller.enable(target);
    adapter.snapshot.services.pop();
    expect(await controller.disable()).toMatchObject({ state: 'changed', managed: true, services: ['Wi-Fi', 'Ethernet'] });
    expect(adapter.attempts).toHaveLength(1);
    expect(await stat(journal)).toBeDefined();
  });

  it('restores renamed services by ID across network locations', async () => {
    const { root, controller, adapter } = await setup();
    await controller.enable(target);
    adapter.snapshot = {
      location: 'office',
      services: [{ ...adapter.snapshot.services[0], active: false, name: 'Renamed Wi-Fi' }, ethernet],
    };
    const restarted = new SystemProxyController(root, adapter);
    expect(await restarted.status()).toMatchObject({ state: 'on', managed: true, services: ['Renamed Wi-Fi'] });
    expect(await restarted.disable()).toMatchObject({ state: 'external', managed: false, services: ['Ethernet'] });
    expect(adapter.snapshot.services[0]).toEqual({ ...service, active: false, name: 'Renamed Wi-Fi' });
  });

  it('handles location changes during enable without claiming success', async () => {
    const { controller, adapter, journal } = await setup();
    adapter.nextWrite = async () => { adapter.snapshot.location = 'office'; };
    expect(await controller.enable(target)).toMatchObject({ state: 'error', managed: false });
    expect(adapter.snapshot.services).toEqual([service]);
    await expect(stat(journal)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('archives a changed journal privately and releases without writing proxy preferences', async () => {
    const { root, controller, adapter, journal } = await setup();
    await controller.enable(target);
    expect(await controller.release()).toMatchObject({ state: 'on', managed: true });
    const backup = await readFile(journal);
    adapter.snapshot.services[0].configuration.HTTPProxy = 'elsewhere.example';
    const current = await adapter.read();
    expect(await controller.release()).toMatchObject({ state: 'external', managed: false });
    await expect(stat(journal)).rejects.toMatchObject({ code: 'ENOENT' });
    const archives = await readdir(root);
    expect(archives).toHaveLength(1);
    const archive = join(root, archives[0]);
    expect(await readFile(archive)).toEqual(backup);
    expect((await stat(archive)).mode & 0o777).toBe(0o600);
    expect(adapter.attempts).toHaveLength(1);
    expect(await adapter.read()).toEqual(current);
  });

  it('serializes enable calls and keeps the original backup when active services or target change', async () => {
    const { controller, adapter, journal } = await setup();
    const results = await Promise.all([controller.enable(target), controller.enable(target)]);
    expect(results.map((entry) => entry.state)).toEqual(['on', 'on']);
    expect(adapter.attempts).toHaveLength(1);
    const backup = await readFile(journal);
    adapter.snapshot.services.push(ethernet);
    expect(await controller.enable({ host: 'localhost', port: 8000 })).toMatchObject({
      state: 'on', managed: true, address: '127.0.0.1:8899', services: ['Wi-Fi'],
    });
    expect(adapter.attempts).toHaveLength(1);
    expect(await readFile(journal)).toEqual(backup);
    await controller.disable();
    expect(adapter.snapshot.services).toEqual([service, ethernet]);
  });

  it('does not overwrite a malformed existing journal', async () => {
    const { controller, adapter, journal } = await setup();
    await writeFile(journal, '{bad');
    expect(await controller.enable(target)).toMatchObject({ state: 'error', managed: true });
    expect(await controller.disable()).toMatchObject({ state: 'error', managed: true });
    expect(adapter.attempts).toHaveLength(0);
    expect(await readFile(journal, 'utf8')).toBe('{bad');
  });

  it.each([
    { host: 'http://localhost', port: 8899 },
    { host: 'localhost:8899', port: 8899 },
    { host: ' user@localhost', port: 8899 },
    { host: 'localhost', port: 0 },
    { host: 'localhost', port: 65536 },
    { host: 'localhost', port: 8.5 },
  ])('rejects invalid target %j before touching the journal or adapter', async (invalid) => {
    const { controller, adapter, journal } = await setup();
    expect(await controller.enable(invalid)).toMatchObject({ state: 'error', managed: false });
    expect(adapter.attempts).toHaveLength(0);
    await expect(stat(journal)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uses IPv6 loopback for an IPv6 wildcard', async () => {
    const { controller, adapter } = await setup();
    expect(await controller.enable({ host: '[0:0:0:0:0:0:0:0]', port: 8899 })).toMatchObject({
      state: 'on', address: '[::1]:8899',
    });
    expect(adapter.snapshot.services[0].configuration.HTTPProxy).toBe('::1');
  });

  it('reports active existing PAC and legacy proxies without exposing their configurations', async () => {
    const { controller, adapter } = await setup([
      { ...service, enabled: true, configuration: { ProxyAutoConfigEnable: 1, ProxyAutoConfigURLString: 'https://secret.example/pac' } },
      { ...ethernet, configuration: { FTPEnable: 1 } },
    ]);
    expect(await controller.disable()).toEqual({
      supported: true, state: 'external', managed: false, services: ['Wi-Fi', 'Ethernet'],
    });
    expect(adapter.attempts).toHaveLength(0);
  });

  it('returns unsupported without reading or changing proxy preferences', async () => {
    const { controller, adapter, journal } = await setup();
    adapter.supported = false;
    adapter.failRead = true;
    for (const status of await Promise.all([
      controller.status(), controller.enable(target), controller.disable(), controller.release(),
    ])) {
      expect(status).toMatchObject({ supported: false, managed: false, services: [] });
    }
    expect(adapter.attempts).toHaveLength(0);
    await expect(stat(journal)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
