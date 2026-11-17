import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NativeSystemProxy } from '../src/main/native-system-proxy';
import type { ProxyChange, ProxySnapshot } from '../src/main/system-proxy-types';

const snapshot: ProxySnapshot = {
  location: 'Location-1',
  services: [
    { id: 'Service-A', name: 'Wi-Fi', active: true, enabled: false, configuration: { ExceptionsList: ['*.local'], HTTPPort: 8888 } },
    { id: 'Service-B', name: 'Other', active: false, enabled: true, configuration: {} },
  ],
};
const changes: ProxyChange[] = [{
  id: 'Service-A',
  expected: { enabled: false, configuration: { ExceptionsList: ['*.local'], HTTPPort: 8888 } },
  next: { enabled: true, configuration: { ExceptionsList: ['*.local'], HTTPPort: 8899 } },
}];

describe.skipIf(process.platform !== 'darwin')('native system proxy process boundary', () => {
  let directory: string;

  beforeAll(async () => { directory = await mkdtemp(join(tmpdir(), 'native-system-proxy-')); });
  afterAll(async () => { if (directory) await rm(directory, { force: true, recursive: true }); });

  async function helper(name: string, body: string) {
    const path = join(directory, name);
    await writeFile(path, '#!' + process.execPath + '\n' + body);
    await chmod(path, 0o700);
    return new NativeSystemProxy(path);
  }

  it('launches the exact executable path, passes one fixed argument and sends changes on stdin', async () => {
    const adapter = await helper('proxy helper ; literal', `
      const fs = require('node:fs');
      const argv = process.argv.slice(2);
      if (JSON.stringify(argv) === '["read"]')
        process.stdout.write(JSON.stringify(${JSON.stringify(snapshot)}));
      else if (JSON.stringify(argv) === '["write"]' &&
               fs.readFileSync(0, 'utf8') === JSON.stringify(${JSON.stringify({ changes, expectedLocation: snapshot.location })}))
        process.stdout.write(JSON.stringify({ ok: true }));
      else process.exitCode = 7;
    `);
    expect(await adapter.read()).toEqual(snapshot);
    await expect(adapter.write(changes, snapshot.location)).resolves.toBeUndefined();
  });

  it('recognizes declined authorization without echoing helper output', async () => {
    const adapter = await helper('authorization', `
      process.stdout.write(JSON.stringify({ error: 'authorization', proxy: 'confidential-PAC' }));
      process.stderr.write('confidential-password');
      process.exitCode = 1;
    `);
    await expect(adapter.write(changes)).rejects.toThrow(/^已取消系统代理授权。$/);
  });

  it('does not accept an invalid snapshot', async () => {
    const adapter = await helper('invalid', `
      process.stdout.write(JSON.stringify({ services: [{ configuration: { PAC: 'confidential-PAC' } }] }));
      process.stderr.write('confidential-password');
    `);
    await expect(adapter.read()).rejects.toThrow(/^系统代理助手返回了无效响应。$/);
  });

  it('does not surface an unknown failure code even when it contains sensitive data', async () => {
    const adapter = await helper('unknown-failure', `
      process.stdout.write(JSON.stringify({ error: 'confidential-PAC' }));
      process.stderr.write('confidential-password');
      process.exitCode = 1;
    `);
    await expect(adapter.write(changes)).rejects.toThrow(/^系统代理助手未能完成操作。$/);
  });
});
