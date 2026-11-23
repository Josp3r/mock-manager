import { t } from '../shared/i18n';
import { spawn } from 'node:child_process';
import type { ProxyChange, ProxySnapshot, SystemProxyAdapter } from './system-proxy-types';

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
// Keep failure identity separate from the currently selected UI language.
const messages: ReadonlyMap<string, () => string> = new Map([
  ['invalidResponse', () => t('系统代理助手返回了无效响应。', 'The system proxy helper returned an invalid response.')],
  ['invalidRequest', () => t('系统代理请求无效或过大。', 'The system proxy request is invalid or too large.')],
  ['readFailed', () => t('无法读取 macOS 系统代理设置。', 'macOS system proxy settings could not be read.')],
  ['authorization', () => t('已取消系统代理授权。', 'System proxy authorization was cancelled.')],
  ['authorizationUnavailable', () => t('无法请求 macOS 系统代理授权。', 'macOS system proxy authorization could not be requested.')],
  ['conflict', () => t('网络位置或代理设置已变化，未更新系统代理。', 'The network location or proxy settings changed. The system proxy was not updated.')],
  ['busy', () => t('macOS 正在更新网络设置，请稍后重试。', 'macOS is updating network settings. Try again shortly.')],
  ['updateFailed', () => t('无法更新 macOS 系统代理设置。', 'macOS system proxy settings could not be updated.')],
  ['commitFailed', () => t('无法保存 macOS 系统代理设置。', 'macOS system proxy settings could not be saved.')],
  ['applyFailed', () => t('macOS 已保存代理设置，但未能应用，请重试。', 'macOS saved the proxy settings but could not apply them. Try again.')],
  ['responseTooLarge', () => t('macOS 系统代理设置过大，无法安全读取。', 'macOS system proxy settings are too large to read safely.')],
  ['unsupported', () => t('此平台不支持 macOS 系统代理管理。', 'macOS system proxy management is not supported on this platform.')],
  ['launchFailed', () => t('无法启动系统代理助手。', 'The system proxy helper could not be started.')],
  ['timeout', () => t('系统代理操作超时，请检查 macOS 授权窗口后重试。', 'The system proxy operation timed out. Check the macOS authorization dialog and try again.')],
]);

export class NativeSystemProxyError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(messages.get(code)?.() ?? t('系统代理助手未能完成操作。', 'The system proxy helper could not complete the operation.'));
    this.name = 'NativeSystemProxyError';
    // Never retain an unknown helper response, which could contain private data.
    this.code = messages.has(code) ? code : 'unknown';
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const validID = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);

function validSnapshot(value: unknown): value is ProxySnapshot {
  if (!record(value) || !validID(value.location) || !Array.isArray(value.services) || value.services.length > 128) return false;
  const ids = new Set();
  return value.services.every(service => {
    if (!record(service) || !validID(service.id) || ids.has(service.id) || typeof service.name !== 'string'
        || typeof service.active !== 'boolean' || typeof service.enabled !== 'boolean' || !record(service.configuration)) return false;
    ids.add(service.id);
    return true;
  });
}

export class NativeSystemProxy implements SystemProxyAdapter {
  readonly supported = process.platform === 'darwin';

  constructor(private readonly helperPath: string) {}

  async read(): Promise<ProxySnapshot> {
    const value = await this.run('read');
    if (!validSnapshot(value)) throw new NativeSystemProxyError('invalidResponse');
    return value;
  }

  async write(changes: ProxyChange[], expectedLocation?: string): Promise<void> {
    let input: string;
    try {
      input = JSON.stringify({ changes, expectedLocation });
    } catch {
      throw new NativeSystemProxyError('invalidRequest');
    }
    if (Buffer.byteLength(input) > MAX_REQUEST_BYTES) throw new NativeSystemProxyError('invalidRequest');
    const value = await this.run('write', input);
    if (!record(value) || value.ok !== true) throw new NativeSystemProxyError('invalidResponse');
  }

  private async run(command: 'read' | 'write', input?: string): Promise<unknown> {
    if (!this.supported) throw new NativeSystemProxyError('unsupported');
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(this.helperPath, [command], { stdio: ['pipe', 'pipe', 'ignore'], shell: false });
      } catch {
        reject(new NativeSystemProxyError('launchFailed'));
        return;
      }
      const chunks: Buffer[] = [];
      let length = 0;
      let interrupted: string | undefined;
      let inputFailed = false;
      const stop = (code: string) => {
        interrupted ??= code;
        child.kill('SIGKILL');
      };
      const timeout = setTimeout(() => stop('timeout'),
        command === 'write' ? 120_000 : 10_000);

      child.stdin.on('error', () => { inputFailed = true; });
      child.stdout.on('error', () => stop('invalidResponse'));
      child.stdout.on('data', (chunk: Buffer) => {
        if (interrupted) return;
        length += chunk.length;
        if (length > MAX_RESPONSE_BYTES) stop('invalidResponse');
        else chunks.push(chunk);
      });
      child.on('error', () => { interrupted ??= 'launchFailed'; });
      // Wait for the child to exit even after timeout, so the next transaction
      // cannot start while the helper process itself is still running.
      child.once('close', code => {
        clearTimeout(timeout);
        if (interrupted) return reject(new NativeSystemProxyError(interrupted));
        let result: unknown;
        try {
          result = JSON.parse(Buffer.concat(chunks, length).toString('utf8'));
        } catch {
          return reject(new NativeSystemProxyError('invalidResponse'));
        }
        if (code !== 0) {
          const failure = record(result) && typeof result.error === 'string' ? result.error : 'unknown';
          return reject(new NativeSystemProxyError(failure));
        }
        if (inputFailed) return reject(new NativeSystemProxyError('invalidRequest'));
        resolve(result);
      });
      child.stdin.end(input);
    });
  }
}
