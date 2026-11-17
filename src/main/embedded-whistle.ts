import { randomBytes, X509Certificate } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';
import { utilityProcess, type UtilityProcess } from 'electron';
import { WHISTLE_LOOPBACK, type RuleValue, type WhistleAccess, type WhistleApi } from './whistle';

export const BUILTIN_WHISTLE = '@builtin';

const START_TIMEOUT = 15_000;
const STOP_TIMEOUT = 2_000;
const REQUEST_TIMEOUT = 5_000;
const MAX_RESPONSE_BYTES = 24 * 1024 * 1024;

type Worker = {
  child: UtilityProcess;
  exited: Promise<void>;
};

type ReadyEngine = {
  port: number;
  api: WhistleApi;
  certificate(): Promise<Buffer>;
};

function managementClient(port: number, authKey: string, isActive: () => boolean) {
  async function call(route: string, body?: string, contentType = 'application/json'): Promise<Buffer> {
    if (!isActive()) throw new Error('内置 Whistle 未运行。');
    return new Promise((resolve, reject) => {
      const req = request({
        hostname: WHISTLE_LOOPBACK,
        port,
        path: '/cgi-bin/' + route,
        method: body === undefined ? 'GET' : 'POST',
        agent: false,
        headers: {
          'x-whistle-auth-key': authKey,
          ...(body === undefined ? {} : {
            'content-type': contentType,
            'content-length': Buffer.byteLength(body),
          }),
        },
      }, res => {
        const chunks: Buffer[] = [];
        let length = 0;
        res.on('error', reject);
        res.on('data', (chunk: Buffer) => {
          length += chunk.length;
          if (length > MAX_RESPONSE_BYTES) {
            req.destroy(new Error('内置 Whistle 返回的数据过大。'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          if (!isActive()) reject(new Error('内置 Whistle 已停止。'));
          else if (res.statusCode !== 200) reject(new Error(`内置 Whistle 管理请求失败（HTTP ${res.statusCode}）。`));
          else resolve(Buffer.concat(chunks, length));
        });
      });
      req.setTimeout(REQUEST_TIMEOUT, () => req.destroy(new Error('内置 Whistle 管理请求超时。')));
      req.on('error', reject);
      req.end(body);
    });
  }

  async function json<T>(route: string, body?: string, contentType?: string): Promise<T> {
    return JSON.parse((await call(route, body, contentType)).toString('utf8')) as T;
  }

  async function command(route: string, fields: Record<string, unknown>, form = false) {
    const data = form ? new URLSearchParams(fields as Record<string, string>).toString() : JSON.stringify(fields);
    const {ec} = await json<{ec: number}>(route, data, form ? 'application/x-www-form-urlencoded' : undefined);
    if (ec !== 0 && ec !== 2) throw new Error(`内置 Whistle 管理命令失败（${ec}）。`);
    return ec === 0;
  }

  async function update(route: string, fields: Record<string, unknown>, form = false) {
    if (!await command(route, fields, form)) throw new Error('内置 Whistle 拒绝了规则修改。');
  }

  const api: WhistleApi = {
    network: {
      async getStatus() {
        const {version} = await json<{version: string}>('status');
        if (typeof version !== 'string') throw new Error('内置 Whistle 返回了无效的版本。');
        return {version, port};
      },
    },
    async isEnabledHTTPS() {
      const {enabled} = await json<{enabled?: boolean}>('is-enabled-https');
      return enabled === true;
    },
    rules: {
      async getStatus() {
        const {list, multiSelect, disabled} = await json<{
          list: {name: string; selected?: boolean}[];
          multiSelect?: boolean;
          disabled?: boolean;
        }>('rules/status');
        return {
          list: list.map(({name, selected}) => ({name, selected: selected === true})),
          multiSelect: multiSelect === true,
          disabled: disabled === true,
        };
      },
      async get(name) {
        const {value} = await json<{value: RuleValue | null}>('rules/value?' + new URLSearchParams({name}));
        return value;
      },
      add: (name, value, selected = false) => update('rules/add', {name, value, selected}),
      select: name => command('rules/select2', {name}),
      unselect: name => command('rules/unselect2', {name}),
      setMultiSelect: enabled => update('rules/allow-multiple-choice', {allowMultipleChoice: enabled ? '1' : '0'}, true),
      turnOn: () => update('rules/disable-all-rules', {disabledAllRules: '0'}, true),
    },
  };

  return {
    api,
    async certificate() {
      const cert = new X509Certificate(await call('rootca?type=crt'));
      if (!cert.ca) throw new Error('内置 Whistle 返回了无效的根证书。');
      return Buffer.from(cert.toString());
    },
  };
}

function isPort(port: unknown): port is number {
  return typeof port === 'number' && Number.isInteger(port) && port > 0 && port <= 65535;
}

export class EmbeddedWhistle implements WhistleAccess {
  private readonly root: string;
  private worker?: Worker;
  private ready?: ReadyEngine;
  private starting?: Promise<void>;
  private stopping?: Promise<void>;
  private lastError?: Error;

  constructor(dataRoot: string, private readonly workerPath: string) {
    this.root = join(dataRoot, 'proxy-engine');
  }

  async find(_configured: string): Promise<string> {
    return BUILTIN_WHISTLE;
  }

  async resolve(_configured: string) {
    return {path: BUILTIN_WHISTLE, api: this.running().api};
  }

  async endpoint(_configured: string) {
    return {host: WHISTLE_LOOPBACK, port: this.running().port};
  }

  async certificate() {
    return this.running().certificate();
  }

  private running(): ReadyEngine {
    if (!this.ready || this.stopping) throw this.lastError ?? new Error('内置 Whistle 未运行。');
    return this.ready;
  }

  async start(configured: string): Promise<void> {
    if (this.stopping) {
      await this.stopping;
      return this.start(configured);
    }
    if (this.ready) return;
    this.starting ??= this.launch().then(() => {
      this.lastError = undefined;
    }).catch((error: unknown) => {
      this.lastError = error instanceof Error ? error : new Error(String(error));
      throw this.lastError;
    }).finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  async stop(): Promise<void> {
    this.stopping ??= this.shutdown().finally(() => { this.stopping = undefined; });
    return this.stopping;
  }

  private async shutdown() {
    try {
      await this.starting;
    } catch {
      // Failed startup already stopped its worker.
    }
    const worker = this.worker;
    this.ready = undefined;
    if (!worker) return;
    const {child, exited} = worker;
    child.postMessage({type: 'stop'});
    const timeout = setTimeout(() => child.kill(), STOP_TIMEOUT);
    try {
      await exited;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async launch() {
    await mkdir(this.root, {recursive: true, mode: 0o700});
    await chmod(this.root, 0o700);
    const portFile = join(this.root, 'port');
    let savedPort = 0;
    try {
      const value = (await readFile(portFile, 'utf8')).trim();
      const port = /^\d+$/.test(value) ? Number(value) : NaN;
      if (!isPort(port)) throw new Error('内置 Whistle 的端口记录无效。');
      savedPort = port;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    const authKey = randomBytes(32).toString('hex');
    const username = randomBytes(16).toString('hex');
    const password = randomBytes(32).toString('hex');
    const child = utilityProcess.fork(this.workerPath, [], {
      cwd: this.root,
      env: {WHISTLE_PATH: this.root},
      serviceName: 'Bundled Whistle',
      stdio: 'ignore',
    });
    const exited = new Promise<void>(resolve => child.once('exit', code => {
      if (this.worker?.child === child) {
        if (this.ready && !this.stopping) this.lastError = new Error(`内置 Whistle 意外退出（${code}）。`);
        this.ready = undefined;
        this.worker = undefined;
      }
      resolve();
    }));
    const worker: Worker = {child, exited};
    this.worker = worker;

    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const port = await new Promise<number>((resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('内置 Whistle 启动超时。')), START_TIMEOUT);
        child.once('exit', code => reject(new Error(`内置 Whistle 在启动时退出（${code}）。`)));
        child.once('error', () => reject(new Error('内置 Whistle 运行时发生错误。')));
        child.once('message', (message: {type?: string; port?: unknown; error?: string}) => {
          if (message.type === 'error') reject(new Error(message.error));
          else if (message.type === 'ready' && isPort(message.port) && (!savedPort || message.port === savedPort)) resolve(message.port);
          else reject(new Error('内置 Whistle 返回了无效的监听端口。'));
        });
        child.postMessage({type: 'start', port: savedPort, authKey, username, password});
      });
      const client = managementClient(port, authKey, () => this.worker === worker);
      await client.api.rules.getStatus();
      if (!savedPort) {
        const temp = join(this.root, `port-${randomBytes(8).toString('hex')}.tmp`);
        try {
          await writeFile(temp, `${port}\n`, {mode: 0o600, flag: 'wx'});
          await rename(temp, portFile);
        } finally {
          await rm(temp, {force: true});
        }
      }
      if (this.worker !== worker) throw new Error('内置 Whistle 在启动时退出。');
      this.ready = {port, ...client};
    } catch (error) {
      if (this.worker === worker) child.kill();
      await exited;
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
