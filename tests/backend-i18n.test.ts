import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createInitialData, configurationHash, validateForApply } from '../src/core/model';
import { setLocale } from '../src/shared/i18n';
import { DataStore } from '../src/main/store';
import { NativeSystemProxy } from '../src/main/native-system-proxy';
import { SystemProxyController } from '../src/main/system-proxy';

const directories: string[] = [];
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'mock-manager-locale-'));
  directories.push(path);
  return path;
}
afterEach(async () => {
  setLocale('zh-CN');
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('backend language boundaries', () => {
  it('creates understandable English samples for a fresh profile without enabling any endpoint', () => {
    setLocale('en');
    const data = createInitialData();
    expect(data.projects[0].name).toBe('Example project');
    expect(data.projects[0].endpoints[0].scenarios.map(item => item.name)).toEqual(['Success', 'Empty data', 'Server error']);
    expect(data.projects[0].endpoints.every(item => !item.enabled)).toBe(true);
    expect(data.projects[0].endpoints.every(item => !/[\p{Script=Han}]/u.test(JSON.stringify(item)))).toBe(true);
  });

  it('switching language leaves stored project names, JSON and the rule hash unchanged', async () => {
    setLocale('zh-CN');
    const root = await directory();
    const store = new DataStore(root);
    const original = await store.load();
    original.projects[0].name = '客户自定义项目';
    original.projects[0].endpoints[0].scenarios[0].body = '{"名字":"保持原文"}';
    const saved = await store.save(original);
    const hash = configurationHash(saved.projects);
    setLocale('en');
    const reloaded = await new DataStore(root).load();
    expect(reloaded).toEqual(saved);
    expect(configurationHash(reloaded.projects)).toBe(hash);
  });

  it('reports an invalid response in English while retaining the user scenario name', () => {
    setLocale('en');
    const data = createInitialData();
    const endpoint = data.projects[0].endpoints[0];
    endpoint.enabled = true;
    endpoint.scenarios[0].name = '用户场景';
    endpoint.scenarios[0].body = '{ invalid';
    expect(() => validateForApply(data)).toThrow(/Invalid JSON.*用户场景/);
  });

  it.skipIf(process.platform !== 'darwin')('recognizes authorization cancellation in English without exposing helper details or taking ownership', async () => {
    const root = await directory();
    const helper = join(root, 'helper.cjs');
    const snapshot = { location: 'home', services: [{ id: 'wifi', name: 'Wi-Fi', active: true, enabled: true, configuration: { HTTPEnable: 0, HTTPSEnable: 0 } }] };
    await writeFile(helper, '#!' + process.execPath + '\n' + `
      if (process.argv[2] === 'read') process.stdout.write(JSON.stringify(${JSON.stringify(snapshot)}));
      else {
        process.stdout.write(JSON.stringify({error:'authorization',secret:'confidential-proxy'}));
        process.exitCode=1;
      }
    `);
    await chmod(helper, 0o700);
    const native = new NativeSystemProxy(helper);
    const controller = new SystemProxyController(root, native);
    setLocale('en');
    const result = await controller.enable({ host: '127.0.0.1', port: 8899 });
    expect(result).toMatchObject({ state: 'error', managed: false });
    expect(result.message).toMatch(/authori[sz]ation.*cancelled|cancelled.*authori[sz]ation/i);
    expect(result.message).not.toMatch(/[\p{Script=Han}]/u);
    expect(result.message).not.toContain('confidential');
    expect(await native.read()).toEqual(snapshot);
  });
});
