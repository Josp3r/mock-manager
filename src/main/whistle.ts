import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { createRequire } from 'node:module';

const exec = promisify(execFile);
export interface RuleValue { value: string; selected: boolean }
export interface WhistleApi {
  network: { getStatus(): Promise<{version: string; port?: number}> };
  isEnabledHTTPS(): Promise<boolean>;
  rules: {
    getStatus(): Promise<{multiSelect: boolean; disabled: boolean; list: {name: string; selected: boolean}[]}>;
    get(name: string): Promise<RuleValue | string | null>;
    add(name: string, value: string, selected?: boolean): Promise<void>;
    select(name: string): Promise<boolean>;
    unselect(name: string): Promise<boolean>;
    setMultiSelect(enabled: boolean): Promise<void>;
    turnOn(): Promise<void>;
  };
}
export interface WhistleAccess {
  find(configured: string): Promise<string>;
  resolve(configured: string): Promise<{path: string; api: WhistleApi}>;
  start(path: string): Promise<void>;
  endpoint?(configured: string): Promise<{port: number}>;
}
export function compatibleVersion(version: string): boolean {
  const [major, minor, patch] = version.split('.').map(Number);
  return major > 2 || (major === 2 && (minor > 10 || (minor === 10 && patch >= 7)));
}
export function ruleValue(value: RuleValue | string | null): RuleValue | null {
  if (typeof value === 'string') return {value, selected: false};
  return value;
}
function commandEnvironment(binary: string) {
  const env: NodeJS.ProcessEnv = {...process.env, PATH: [dirname(binary), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', process.env.PATH || ''].join(':')};
  // A parent Electron process must not make external node commands inherit its mode.
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}
export class LocalWhistle implements WhistleAccess {
  private cached?: {path: string; api: WhistleApi};
  private configLoader?: (options: unknown, callback?: (error: Error | null, config?: {options: {port: number}}) => void) => void;
  async find(configured: string): Promise<string> {
    const candidates = configured ? [configured] : (process.env.PATH || '').split(':').filter(Boolean).map(p => join(p, 'w2'));
    if (!configured) {
      candidates.push('/opt/homebrew/bin/w2', '/usr/local/bin/w2');
      const nvm = join(homedir(), '.nvm/versions/node');
      try { const versions = (await readdir(nvm)).sort((a,b) => b.localeCompare(a, undefined, {numeric:true})); candidates.push(...versions.map(v => join(nvm, v, 'bin/w2'))); } catch { /* nvm optional */ }
      candidates.push(join(homedir(), '.volta/bin/w2'), join(homedir(), '.local/bin/w2'));
    }
    for (const candidate of [...new Set(candidates)]) {
      if (!isAbsolute(candidate)) continue;
      try { await access(candidate, constants.X_OK); return candidate; } catch { /* try next */ }
    }
    throw new Error(configured ? '保存的 w2 路径不可用，请重新选择。' : '未找到 w2。安装 Whistle 后，在连接设置中选择 w2 文件。');
  }
  async resolve(configured: string) {
    const path = await this.find(configured);
    if (this.cached?.path === path) return this.cached;
    const {stdout} = await exec(path, ['root', 'bin/api'], {env: commandEnvironment(path), timeout: 10000, maxBuffer: 1024 * 1024});
    const modulePath = stdout.trim();
    if (!isAbsolute(modulePath) || /[\r\n]/.test(modulePath)) throw new Error('无法定位 Whistle API，请检查所选文件是否为 w2。');
    const requireAtWhistle = createRequire(join(dirname(modulePath), 'mock-manager-loader.cjs'));
    const api = requireAtWhistle(modulePath) as WhistleApi;
    if (!api.network?.getStatus || !api.rules?.get || !api.rules?.add) throw new Error('Whistle API 不兼容，请升级至 2.10.7 或更新版本。');
    this.cached = {path, api};
    this.configLoader = requireAtWhistle(join(dirname(modulePath), 'use')).getConfig;
    return this.cached;
  }
  async endpoint(configured: string): Promise<{port: number}> {
    await this.resolve(configured);
    const read = (client: boolean) => new Promise<{port:number}>((res,rej) => {
      const callback = (error:Error|null, config?:{options:{port:number}}) => {
        const port = Number(config?.options.port);
        if (error) rej(error);
        else if (!Number.isInteger(port) || port<1 || port>65535) rej(new Error('无法获取 Whistle 监听端口。'));
        else res({port});
      };
      if (client) this.configLoader!(true, callback);
      else this.configLoader!(callback);
    });
    // Match the official API's CLI-first, desktop-client-fallback discovery.
    return read(false).catch(() => read(true));
  }
  async start(configured: string) {
    const path = await this.find(configured);
    await exec(path, ['start'], {env: commandEnvironment(path), timeout: 20000, maxBuffer: 1024 * 1024});
  }
}
