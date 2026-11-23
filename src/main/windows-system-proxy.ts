import { spawn } from 'node:child_process';
import { isIP } from 'node:net';
import { win32 } from 'node:path';
import { t } from '../shared/i18n';
import type { ProxyChange, ProxyConfiguration, ProxyProtocolState, ProxySnapshot, SystemProxyAdapter } from './system-proxy-types';

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const KEYS = ['flags', 'proxyServer', 'proxyBypass', 'autoConfigURL', 'autoDiscoveryFlags'];
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const uint = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
const textValue = (value: unknown) => value === null || (typeof value === 'string' && value.length <= 32767 && !value.includes('\0'));

export function validWindowsConfiguration(value: unknown): value is ProxyConfiguration {
  return record(value) && Object.keys(value).length === KEYS.length && KEYS.every(key => Object.hasOwn(value, key))
    && uint(value.flags) && value.flags <= 15 && uint(value.autoDiscoveryFlags)
    && textValue(value.proxyServer) && textValue(value.proxyBypass) && textValue(value.autoConfigURL);
}

export function windowsHasCredentials(value: ProxyConfiguration): boolean {
  // WinINet stores credentials separately. Do not read them or journal embedded userinfo.
  return [value.proxyServer, value.autoConfigURL].some(entry => typeof entry === 'string' && /@|%40/i.test(entry));
}

export function windowsInstalledState(before: ProxyProtocolState, target: { host: string; port: number }): ProxyProtocolState {
  const address = `${isIP(target.host) === 6 ? '[' + target.host + ']' : target.host}:${target.port}`;
  return { enabled: true, configuration: {
    ...before.configuration,
    // DIRECT permits the existing bypass list; clear PAC and discovery activation.
    flags: 3, proxyServer: `http=${address};https=${address}`,
  } };
}

const messages: ReadonlyMap<string, () => string> = new Map([
  ['invalidRequest', () => t('Windows 系统代理请求无效或过大。', 'The Windows system proxy request is invalid or too large.')],
  ['invalidResponse', () => t('Windows 系统代理助手返回了无效响应。', 'The Windows system proxy helper returned an invalid response.')],
  ['readFailed', () => t('无法读取 Windows 系统代理设置。', 'Windows system proxy settings could not be read.')],
  ['unsupportedPolicy', () => t('Windows 代理设置由组织策略管理，无法接管。', 'Windows proxy settings are managed by organizational policy and cannot be changed by this app.')],
  ['credentials', () => t('Windows 代理地址包含认证信息，无法接管。', 'The Windows proxy address contains credentials and cannot be managed by this app.')],
  ['conflict', () => t('Windows 代理设置已变化，未更新系统代理。', 'Windows proxy settings changed. The system proxy was not updated.')],
  ['busy', () => t('Windows 系统代理正在更新，请稍后重试。', 'Windows system proxy settings are being updated. Try again shortly.')],
  ['updateFailed', () => t('无法更新 Windows 系统代理设置。', 'Windows system proxy settings could not be updated.')],
  ['applyFailed', () => t('Windows 已保存代理设置，但未能通知应用。请重试恢复。', 'Windows saved the proxy settings but could not notify applications. Retry restoration.')],
  ['unsupported', () => t('此平台不支持 Windows 系统代理管理。', 'Windows system proxy management is not supported on this platform.')],
  ['launchFailed', () => t('无法启动 Windows 系统代理助手。', 'The Windows system proxy helper could not be started.')],
  ['timeout', () => t('Windows 系统代理操作超时，请重试。', 'The Windows system proxy operation timed out. Try again.')],
]);

export class WindowsSystemProxyError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(messages.get(code)?.() ?? t('Windows 系统代理助手未能完成操作。', 'The Windows system proxy helper could not complete the operation.'));
    this.name = 'WindowsSystemProxyError';
    this.code = messages.has(code) ? code : 'unknown';
  }
}

function validState(value: unknown): value is ProxyProtocolState {
  return record(value) && value.enabled === true && validWindowsConfiguration(value.configuration) && !windowsHasCredentials(value.configuration);
}
function validSnapshot(value: unknown): value is ProxySnapshot {
  if (!record(value) || value.location !== 'wininet-current-user' || !Array.isArray(value.services) || value.services.length !== 1) return false;
  const service = value.services[0];
  return validState(service) && record(service) && service.id === 'lan' && service.name === 'Windows LAN' && service.active === true;
}

export class WindowsSystemProxy implements SystemProxyAdapter {
  readonly platform = 'win32' as const;
  readonly supported = process.platform === 'win32';
  constructor(private readonly helperPath: string) {}

  async read(): Promise<ProxySnapshot> {
    const value = await this.run('read');
    if (!validSnapshot(value)) throw new WindowsSystemProxyError('invalidResponse');
    return value;
  }

  async write(changes: ProxyChange[], expectedLocation?: string): Promise<void> {
    if (!Array.isArray(changes) || changes.length !== 1 || changes[0]?.id !== 'lan'
      || !validState(changes[0].expected) || !validState(changes[0].next)
      || (expectedLocation !== undefined && expectedLocation !== 'wininet-current-user')) throw new WindowsSystemProxyError('invalidRequest');
    let input: string;
    try { input = JSON.stringify({ changes, expectedLocation }); } catch { throw new WindowsSystemProxyError('invalidRequest'); }
    if (Buffer.byteLength(input) > MAX_REQUEST_BYTES) throw new WindowsSystemProxyError('invalidRequest');
    const value = await this.run('write', input);
    if (!record(value) || value.ok !== true) throw new WindowsSystemProxyError('invalidResponse');
  }

  private async run(command: 'read' | 'write', input?: string): Promise<unknown> {
    if (!this.supported) throw new WindowsSystemProxyError('unsupported');
    // Use the inbox Windows PowerShell 5.1 host, never PATH or a shell command.
    const systemRoot = process.env.SystemRoot;
    if (!systemRoot || !/^[A-Za-z]:\\/.test(systemRoot)) throw new WindowsSystemProxyError('launchFailed');
    const executable = win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.helperPath, command], {
          shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
        });
      } catch { reject(new WindowsSystemProxyError('launchFailed')); return; }
      const chunks: Buffer[] = [];
      let length = 0;
      let interrupted: string | undefined;
      let inputFailed = false;
      const stop = (code: string) => { interrupted ??= code; child.kill('SIGKILL'); };
      // Add-Type compilation can be slow on first use; wait for close after killing.
      const timeout = setTimeout(() => stop('timeout'), 30_000);
      child.stdin.on('error', () => { inputFailed = true; });
      child.stdout.on('error', () => stop('invalidResponse'));
      child.stdout.on('data', (chunk: Buffer) => {
        if (interrupted) return;
        length += chunk.length;
        if (length > MAX_RESPONSE_BYTES) stop('invalidResponse'); else chunks.push(chunk);
      });
      child.on('error', () => { interrupted ??= 'launchFailed'; });
      child.once('close', code => {
        clearTimeout(timeout);
        if (interrupted) return reject(new WindowsSystemProxyError(interrupted));
        let result: unknown;
        try { result = JSON.parse(Buffer.concat(chunks, length).toString('utf8')); }
        catch { return reject(new WindowsSystemProxyError('invalidResponse')); }
        if (code !== 0) return reject(new WindowsSystemProxyError(record(result) && typeof result.error === 'string' ? result.error : 'unknown'));
        if (inputFailed) return reject(new WindowsSystemProxyError('invalidRequest'));
        resolve(result);
      });
      child.stdin.end(input);
    });
  }
}
