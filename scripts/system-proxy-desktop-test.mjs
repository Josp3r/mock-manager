import { _electron as electron } from 'playwright';
import { mkdtemp, mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
import { createInitialData } from '../src/core/model.ts';

await mkdir('test-results', { recursive: true });
const root = await mkdtemp(resolve('test-results/system-proxy-desktop-'));
let proxy;
const data = createInitialData();
await writeFile(join(root, 'data.json'), JSON.stringify(data));
const original = { location: 'test-location', services: [{
  id: 'test-wifi', name: 'Wi-Fi（隔离测试）', active: true, enabled: true,
  configuration: { HTTPEnable: 0, HTTPProxy: 'previous.example', HTTPPort: 8080,
    HTTPSEnable: 0, HTTPSProxy: 'previous.example', HTTPSPort: 8443,
    ProxyAutoConfigEnable: 1, ProxyAutoConfigURLString: 'https://pac.example.invalid/proxy.pac',
    ProxyAutoDiscoveryEnable: 1, SOCKSEnable: 1, SOCKSProxy: '127.0.0.1', SOCKSPort: 1080,
    ExceptionsList: ['localhost', '*.local'], ExcludeSimpleHostnames: 1 },
}] };
const fixture = join(root, 'proxy-fixture.json');
await writeFile(fixture, JSON.stringify({ snapshot: original, cancelNext: true }));
const helper = resolve('scripts/fixtures/system-proxy-helper.cjs'); await chmod(helper, 0o700);
const env = { ...process.env, MOCK_MANAGER_DATA_DIR: root,
  MOCK_MANAGER_PROXY_HELPER: helper, MOCK_MANAGER_PROXY_FIXTURE: fixture };
delete env.ELECTRON_RUN_AS_NODE;
const launch = () => electron.launch({ args: ['.'], cwd: process.cwd(), env });
let app; const errors = [];
const read = async () => JSON.parse(await readFile(fixture, 'utf8'));
async function settings() {
  const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('button', { name: '连接设置', exact: true }).click();
  await page.getByRole('switch', { name: '系统代理', exact: true }).waitFor();
  await page.getByText('运行中', { exact: false }).waitFor();
  return page;
}
try {
  app = await launch(); let page = await settings();
  proxy=await page.evaluate(()=>window.mockManager.status());
  await assert.rejects(page.evaluate(() => window.mockManager.setSystemProxy('on')), /参数/);
  const toggle = () => page.getByRole('switch', { name: '系统代理', exact: true });
  await toggle().click();
  await page.getByRole('alert').filter({ hasText: '已取消系统代理授权' }).waitFor();
  assert.equal(await toggle().isChecked(), false);
  assert.deepEqual((await read()).snapshot, original);
  await toggle().click();
  await page.waitForFunction(async () => (await window.mockManager.systemProxyStatus()).state === 'on');
  const installed = (await read()).snapshot.services[0].configuration;
  assert.equal(installed.HTTPPort, proxy.port); assert.equal(installed.HTTPSPort, proxy.port);
  assert.equal(installed.ProxyAutoConfigEnable, 0); assert.equal(installed.SOCKSEnable, 0);
  assert.deepEqual(installed.ExceptionsList, original.services[0].configuration.ExceptionsList);
  await page.screenshot({ path: 'test-results/system-proxy-on.png' });
  // Cancellation of quit restoration must leave the engine and app alive.
  const cancelQuit = await read(); cancelQuit.cancelNext = true; await writeFile(fixture, JSON.stringify(cancelQuit));
  await app.evaluate(({app, dialog}) => {
    globalThis.quitDialogSeen=false;
    dialog.showMessageBox=async()=>{globalThis.quitDialogSeen=true;return {response:0};};
    app.quit();
  });
  for(let i=0;i<80;i++) { if(await app.evaluate(()=>globalThis.quitDialogSeen))break; await new Promise(r=>setTimeout(r,50)); }
  assert.equal(await app.evaluate(()=>globalThis.quitDialogSeen),true);
  assert.equal((await page.evaluate(()=>window.mockManager.status())).running,true);
  assert.equal((await page.evaluate(()=>window.mockManager.systemProxyStatus())).managed,true);
  await app.close(); app = await launch(); page = await settings();
  await page.waitForFunction(async () => !(await window.mockManager.systemProxyStatus()).managed);
  assert.equal(await toggle().isChecked(), false);
  assert.deepEqual((await read()).snapshot, original);

  await toggle().click();
  await page.waitForFunction(async () => (await window.mockManager.systemProxyStatus()).state === 'on');
  const changed = await read(); changed.snapshot.services[0].configuration.HTTPProxy = 'external.example';
  await writeFile(fixture, JSON.stringify(changed));
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await toggle().click();
  await page.getByRole('alert').filter({ hasText: /更改|修改|变更|冲突/ }).first().waitFor();
  assert.deepEqual((await read()).snapshot, changed.snapshot);
  await page.getByRole('button', { name: '保留当前设置', exact: true }).click();
  await page.getByRole('button', { name: '确认保留', exact: true }).click();
  await page.waitForFunction(async () => !(await window.mockManager.systemProxyStatus()).managed);
  assert.deepEqual((await read()).snapshot, changed.snapshot);

  await toggle().click();
  await page.waitForFunction(async () => (await window.mockManager.systemProxyStatus()).state === 'on');
  await app.evaluate(({app})=>{const engine=app.getAppMetrics().find(x=>x.name==='Bundled Whistle'); if(!engine)throw Error('engine missing'); process.kill(engine.pid,'SIGKILL');});
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await page.waitForFunction(async () => !(await window.mockManager.status()).running);
  assert.equal(await toggle().isEnabled(), true, 'restoration works even without Whistle');
  await toggle().click();
  await page.waitForFunction(async () => !(await window.mockManager.systemProxyStatus()).managed);
  assert.deepEqual((await read()).snapshot, changed.snapshot);
  assert.deepEqual(errors, []);
  await writeFile('test-results/system-proxy-desktop-result.json', JSON.stringify({ passed: true, realNetworkChanges: false,
    checks: ['narrow IPC', 'authorization cancellation', 'quit cancelled keeps engine alive', 'enable both protocols', 'PAC/SOCKS/bypass preservation',
      'quit restoration and restart', 'external-change conflict', 'explicit keep-current release', 'restore without Whistle'] }, null, 2));
  console.log('PASS: system-proxy desktop enable/restore/restart/cancel/conflict flow via isolated helper, no real network changes.');
} catch (error) {
  const page = await app?.firstWindow().catch(() => null);
  await page?.screenshot({ path: 'test-results/system-proxy-failure.png' }).catch(() => {});
  throw error;
} finally { await app?.close().catch(() => {}); }
