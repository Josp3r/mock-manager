import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, mkdir, open, rename, rm, unlink } from 'node:fs/promises';
import { isIP } from 'node:net';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { SystemProxyStatus } from '../shared/types';
import type {
  ProxyChange, ProxyConfiguration, ProxyProtocolState, ProxySnapshot, SystemProxyAdapter,
} from './system-proxy-types';
import { WHISTLE_LOOPBACK, whistleAddress } from './whistle';

type ProxyTarget = { host: string; port: number };
type SavedService = ProxyProtocolState & { id: string; name: string };
type Journal = {
  version: 1;
  phase: 'pending' | 'active';
  target: ProxyTarget;
  before: SavedService[];
  installed: SavedService[];
};

const MAX_JOURNAL_BYTES = 32 * 1024 * 1024;
const PROXY_ENABLE_KEYS = [
  'HTTPEnable', 'HTTPSEnable', 'ProxyAutoConfigEnable', 'ProxyAutoDiscoveryEnable', 'SOCKSEnable',
  'FTPEnable', 'GopherEnable', 'RTSPEnable',
];

class ProxyOperationError extends Error {}

function hasCode(error: unknown, ...codes: string[]) {
  return error instanceof Error && codes.includes((error as NodeJS.ErrnoException).code ?? '');
}

function record(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input);
}

function normalizeTarget(input: unknown): ProxyTarget {
  if (!record(input)) throw new ProxyOperationError('Whistle 的代理地址无效。');
  const { host, port } = input;
  if (typeof host !== 'string' || host.length > 254 || typeof port !== 'number'
    || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ProxyOperationError('Whistle 的代理地址无效。');
  }
  const unbracketed = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  const hostName = /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i;
  const hostnameLabels = host.replace(/\.$/, '').split('.');
  if (host !== '*' && !isIP(unbracketed) && !hostnameLabels.every((label) => hostName.test(label))) {
    throw new ProxyOperationError('Whistle 的代理地址无效。');
  }
  try {
    const address = whistleAddress(host === '*' ? WHISTLE_LOOPBACK : host, port);
    const hostname = new URL('http://' + address).hostname;
    if (isIP(hostname) === 4 && !isIP(host) && host !== '*') throw new Error('Ambiguous IPv4 address');
    return { host: hostname.replace(/^\[|\]$/g, ''), port };
  } catch {
    throw new ProxyOperationError('Whistle 的代理地址无效。');
  }
}

function installedState(before: ProxyProtocolState, target: ProxyTarget): ProxyProtocolState {
  return {
    enabled: true,
    configuration: {
      ...before.configuration,
      HTTPEnable: 1, HTTPProxy: target.host, HTTPPort: target.port,
      HTTPSEnable: 1, HTTPSProxy: target.host, HTTPSPort: target.port,
      ProxyAutoConfigEnable: 0, ProxyAutoDiscoveryEnable: 0, SOCKSEnable: 0,
    },
  };
}

function hasAuthentication(configuration: ProxyConfiguration) {
  return Object.keys(configuration).some((key) =>
    /^(https?|webproxy|secureweb)/i.test(key) && /user|pass|auth|credential|keychain/i.test(key));
}

function serviceState({ enabled, configuration }: ProxyProtocolState): ProxyProtocolState {
  return { enabled, configuration };
}

function savedService(value: unknown): value is SavedService {
  return record(value) && typeof value.id === 'string' && !!value.id
    && typeof value.name === 'string' && typeof value.enabled === 'boolean' && record(value.configuration);
}

function parseJournal(bytes: Buffer): Journal {
  const value: unknown = JSON.parse(bytes.toString('utf8'));
  if (!record(value) || value.version !== 1 || !Array.isArray(value.before) || !value.before.length
    || !Array.isArray(value.installed) || value.before.length !== value.installed.length
    || !value.before.every(savedService) || !value.installed.every(savedService)
    || new Set(value.before.map(({ id }: SavedService) => id)).size !== value.before.length) {
    throw new Error('Invalid proxy journal');
  }
  const { before, installed } = value;
  const phase = value.phase === undefined ? 'pending' : value.phase;
  if (phase !== 'pending' && phase !== 'active') throw new Error('Invalid proxy journal phase');
  const target = normalizeTarget(value.target);
  if (!isDeepStrictEqual(target, value.target) || !before.every((service, index) => {
    const applied = installed[index];
    return applied.id === service.id && applied.name === service.name && !hasAuthentication(service.configuration)
      && isDeepStrictEqual(serviceState(applied), installedState(service, target));
  })) {
    throw new Error('Invalid proxy journal snapshots');
  }
  return { version: 1, phase, target, before, installed };
}

function matches(snapshot: ProxySnapshot, journal: Journal) {
  const byId = new Map(snapshot.services.map((service) => [service.id, service]));
  return journal.before.map((original, index) => {
    const service = byId.get(original.id);
    const current = service && serviceState(service);
    return {
      original,
      current,
      name: service?.name ?? original.name,
      before: isDeepStrictEqual(current, serviceState(original)),
      installed: isDeepStrictEqual(current, serviceState(journal.installed[index])),
    };
  });
}

function managedDetails(journal: Journal) {
  const { host, port } = journal.target;
  return {
    supported: true,
    managed: true,
    address: (isIP(host) === 6 ? '[' + host + ']' : host) + ':' + port,
    services: journal.before.map(({ name }) => name),
  };
}

function summarize(snapshot: ProxySnapshot, journal?: Journal): SystemProxyStatus {
  if (!journal) {
    const services = snapshot.services.filter(({ active, enabled, configuration }) =>
      active && enabled && PROXY_ENABLE_KEYS.some((key) => {
        const flag = configuration[key];
        return flag === true || (typeof flag === 'number' && flag !== 0);
      })).map(({ name }) => name);
    return { supported: true, managed: false, state: services.length ? 'external' : 'off', services };
  }

  const states = matches(snapshot, journal);
  const base = { ...managedDetails(journal), services: states.map(({ name }) => name) };
  if (journal.phase === 'active' && states.every((state) => state.installed)) return { ...base, state: 'on' };
  let message = '系统代理设置尚未全部应用或恢复。关闭系统代理可恢复之前的配置。';
  if (states.some((state) => !state.current)) message = '部分网络服务已找不到。恢复备份仍保留。';
  else if (states.some((state) => !state.before && !state.installed)) {
    message = '检测到系统代理设置已在应用外更改。恢复备份仍保留。';
  }
  return { ...base, state: 'changed', message };
}

export class SystemProxyController {
  private readonly root: string;
  private readonly journalPath: string;
  private tail = Promise.resolve();

  constructor(root: string, private readonly adapter: SystemProxyAdapter) {
    this.root = resolve(root);
    this.journalPath = join(this.root, 'system-proxy.json');
  }

  status(): Promise<SystemProxyStatus> {
    return this.run(async (journal) => summarize(await this.read(), journal));
  }

  enable(target: ProxyTarget): Promise<SystemProxyStatus> {
    return this.run(async (journal) => {
      if (journal) return summarize(await this.read(), journal);
      const normalized = normalizeTarget(target);
      const snapshot = await this.read();
      const active = snapshot.services.filter(({ active }) => active);
      if (!active.length) throw new ProxyOperationError('当前网络位置没有可设置代理的服务。');
      if (active.some(({ configuration }) => hasAuthentication(configuration))) {
        throw new ProxyOperationError('现有 HTTP 或 HTTPS 代理包含认证设置，无法接管。');
      }
      const before = active.map(({ id, name, enabled, configuration }) => ({ id, name, enabled, configuration }));
      const installed = before.map(({ id, name, ...state }) => ({ id, name, ...installedState(state, normalized) }));
      const entry: Journal = { version: 1, phase: 'pending', target: normalized, before, installed };
      await this.saveJournal(entry);
      const changes = before.map((service, index) => ({
        id: service.id, expected: serviceState(service), next: serviceState(installed[index]),
      }));

      try {
        await this.write(changes, snapshot.location);
      } catch (error) {
        const current = await this.read().catch(() => undefined);
        if (current && matches(current, entry).every((state) => state.before)) await this.removeJournal();
        throw error;
      }

      const current = await this.read();
      const states = matches(current, entry);
      if (!states.every((state) => state.installed)) {
        if (states.every((state) => state.before)) await this.removeJournal();
        throw new ProxyOperationError('无法确认系统代理已开启。');
      }
      const confirmed: Journal = { ...entry, phase: 'active' };
      await this.saveJournal(confirmed);
      return summarize(current, confirmed);
    });
  }

  disable(): Promise<SystemProxyStatus> {
    return this.run(async (journal) => {
      const snapshot = await this.read();
      if (!journal) return summarize(snapshot);
      const states = matches(snapshot, journal);
      const changes: ProxyChange[] = [];
      for (const { original, current, before, installed } of states) {
        if (!current || (!before && !installed)) return summarize(snapshot, journal);
        changes.push({ id: original.id, expected: current, next: serviceState(original) });
      }

      // Compare every service under the lock and reapply settings even when a prior
      // restore committed them. An interrupted helper may have skipped Apply.
      try {
        await this.write(changes);
      } catch (error) {
        const current = await this.read().catch(() => undefined);
        if (current && matches(current, journal).some((state) => !state.before && !state.installed)) {
          return summarize(current, journal);
        }
        throw error;
      }
      const current = await this.read();
      if (matches(current, journal).some((state) => !state.before)) {
        throw new ProxyOperationError('无法确认系统代理已恢复。恢复备份仍保留。');
      }
      await this.removeJournal();
      return summarize(current);
    });
  }

  release(): Promise<SystemProxyStatus> {
    return this.run(async (journal) => {
      const snapshot = await this.read();
      const current = summarize(snapshot, journal);
      if (current.state !== 'changed') return current;
      await rename(this.journalPath, join(this.root, 'system-proxy.recovery-' + randomUUID() + '.json'));
      await this.syncRoot();
      return summarize(snapshot);
    });
  }

  private run(action: (journal?: Journal) => Promise<SystemProxyStatus>): Promise<SystemProxyStatus> {
    const result = this.tail.then(async (): Promise<SystemProxyStatus> => {
      if (!this.adapter.supported) {
        return { supported: false, state: 'off', managed: false, services: [], message: '此平台不支持系统代理管理。' };
      }
      try {
        return await action(await this.readJournal());
      } catch (error) {
        let saved: Journal | undefined;
        try {
          saved = await this.readJournal();
        } catch {
          return {
            supported: true, state: 'error', managed: true, services: [],
            message: '无法读取系统代理恢复备份。请检查应用数据目录。',
          };
        }
        return {
          ...(saved ? managedDetails(saved) : { supported: true, managed: false, services: [] }),
          state: 'error',
          message: error instanceof ProxyOperationError ? error.message : '无法更新系统代理恢复备份。',
        };
      }
    });
    this.tail = result.then(() => {}, () => {});
    return result;
  }

  private async read(): Promise<ProxySnapshot> {
    try {
      return await this.adapter.read();
    } catch {
      throw new ProxyOperationError('无法读取系统代理设置。');
    }
  }

  private async write(changes: ProxyChange[], location?: string): Promise<void> {
    try {
      await this.adapter.write(changes, location);
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (message.startsWith('已取消系统代理授权')) {
        throw new ProxyOperationError('已取消系统代理授权或未获得权限。');
      }
      if (message.startsWith('系统代理操作超时')) {
        throw new ProxyOperationError('系统代理操作超时，请检查 macOS 授权窗口后重试。');
      }
      if (message.startsWith('macOS 已保存代理设置，但未能应用')) {
        throw new ProxyOperationError('macOS 已保存代理设置，但未能应用。');
      }
      throw new ProxyOperationError('无法写入系统代理设置。');
    }
  }

  private async readJournal(): Promise<Journal | undefined> {
    try {
      const file = await open(this.journalPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > MAX_JOURNAL_BYTES || (stat.mode & 0o077)) {
          throw new Error('Invalid proxy journal file');
        }
        return parseJournal(await file.readFile());
      } finally {
        await file.close();
      }
    } catch (error) {
      if (!hasCode(error, 'ENOENT')) throw error;
    }
  }

  private async saveJournal(journal: Journal): Promise<void> {
    const bytes = Buffer.from(JSON.stringify(journal));
    if (bytes.length > MAX_JOURNAL_BYTES) throw new Error('Proxy journal too large');
    // Do not change preferences unless the journal can recover them after a restart.
    if (!isDeepStrictEqual(parseJournal(bytes), journal)) throw new Error('Non-serializable proxy journal');
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const temp = this.journalPath + '.' + randomUUID() + '.tmp';
    const file = await open(temp, 'wx', 0o600);
    try {
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      if (journal.phase === 'pending') await link(temp, this.journalPath);
      else await rename(temp, this.journalPath);
    } finally {
      await rm(temp, { force: true });
    }
    await this.syncRoot();
  }

  private async removeJournal(): Promise<void> {
    await unlink(this.journalPath);
    await this.syncRoot();
  }

  private async syncRoot(): Promise<void> {
    const directory = await open(this.root, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      await directory.sync();
    } catch (error) {
      if (!hasCode(error, 'EINVAL', 'ENOTSUP')) throw error;
    } finally {
      await directory.close();
    }
  }
}
