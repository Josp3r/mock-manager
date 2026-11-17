import { spawn } from 'node:child_process';
import type { ProxyChange, ProxySnapshot, SystemProxyAdapter } from './system-proxy-types';

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const INVALID_RESPONSE = '系统代理助手返回了无效响应。';
const INVALID_REQUEST = '系统代理请求无效或过大。';

const messages: ReadonlyMap<string, string> = new Map([
  ['invalidRequest', INVALID_REQUEST],
  ['readFailed', '无法读取 macOS 系统代理设置。'],
  ['authorization', '已取消系统代理授权。'],
  ['authorizationUnavailable', '无法请求 macOS 系统代理授权。'],
  ['conflict', '网络位置或代理设置已变化，未更新系统代理。'],
  ['busy', 'macOS 正在更新网络设置，请稍后重试。'],
  ['updateFailed', '无法更新 macOS 系统代理设置。'],
  ['commitFailed', '无法保存 macOS 系统代理设置。'],
  ['applyFailed', 'macOS 已保存代理设置，但未能应用，请重试。'],
  ['responseTooLarge', 'macOS 系统代理设置过大，无法安全读取。'],
]);

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
    if (!validSnapshot(value)) throw new Error(INVALID_RESPONSE);
    return value;
  }

  async write(changes: ProxyChange[], expectedLocation?: string): Promise<void> {
    let input: string;
    try {
      input = JSON.stringify({ changes, expectedLocation });
    } catch {
      throw new Error(INVALID_REQUEST);
    }
    if (Buffer.byteLength(input) > MAX_REQUEST_BYTES) throw new Error(INVALID_REQUEST);
    const value = await this.run('write', input);
    if (!record(value) || value.ok !== true) throw new Error(INVALID_RESPONSE);
  }

  private async run(command: 'read' | 'write', input?: string): Promise<unknown> {
    if (!this.supported) throw new Error('此平台不支持 macOS 系统代理管理。');
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(this.helperPath, [command], { stdio: ['pipe', 'pipe', 'ignore'], shell: false });
      } catch {
        reject(new Error('无法启动系统代理助手。'));
        return;
      }
      const chunks: Buffer[] = [];
      let length = 0;
      let interrupted: string | undefined;
      let inputFailed = false;
      const stop = (message: string) => {
        interrupted ??= message;
        child.kill('SIGKILL');
      };
      const timeout = setTimeout(() => stop('系统代理操作超时，请检查 macOS 授权窗口后重试。'),
        command === 'write' ? 120_000 : 10_000);

      child.stdin.on('error', () => { inputFailed = true; });
      child.stdout.on('error', () => stop(INVALID_RESPONSE));
      child.stdout.on('data', (chunk: Buffer) => {
        if (interrupted) return;
        length += chunk.length;
        if (length > MAX_RESPONSE_BYTES) stop(INVALID_RESPONSE);
        else chunks.push(chunk);
      });
      child.on('error', () => { interrupted ??= '无法启动系统代理助手。'; });
      // Wait for the child to exit even after timeout, so the next transaction
      // cannot start while the helper process itself is still running.
      child.once('close', code => {
        clearTimeout(timeout);
        if (interrupted) return reject(new Error(interrupted));
        let result: unknown;
        try {
          result = JSON.parse(Buffer.concat(chunks, length).toString('utf8'));
        } catch {
          return reject(new Error(INVALID_RESPONSE));
        }
        if (code !== 0) {
          const message = record(result) && typeof result.error === 'string' ? messages.get(result.error) : undefined;
          return reject(new Error(message ?? '系统代理助手未能完成操作。'));
        }
        if (inputFailed) return reject(new Error(INVALID_REQUEST));
        resolve(result);
      });
      child.stdin.end(input);
    });
  }
}
