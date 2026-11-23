// Run after npm run build: node --import tsx scripts/design-preview.mjs
// The native proxy boundary is replaced with an isolated JSON fixture. No OS
// proxy settings or system trust stores are read or written by this harness.
import { _electron as electron } from 'playwright';
import { chmod, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest, Agent } from 'node:https';
import { connect as tlsConnect } from 'node:tls';
import { X509Certificate } from 'node:crypto';
import assert from 'node:assert/strict';
import { createInitialData, validateData } from '../src/core/model.ts';

const output = resolve('test-results');
await mkdir(output, { recursive: true });
const profile = await mkdtemp(join(output, 'design-preview-'));
const fixture = join(profile, 'proxy-fixture.json');
const helper = resolve('scripts/fixtures/system-proxy-helper.cjs');
await chmod(helper, 0o700);

const successBody = `{
  "code": 0,
  "data": {
    "items": [
      { "id": 101, "name": "无线键盘", "stock": 24 },
      { "id": 102, "name": "桌面支架", "stock": 12 }
    ],
    "total": 2
  }
}`;
const emptyBody = JSON.stringify({ code: 0, data: { items: [], total: 0 } }, null, 2);
const errorBody = JSON.stringify({ code: 500, message: '服务暂时不可用，请稍后重试' }, null, 2);
const endpoint = (id, name, module, method, path, enabled = true, body = '{\n  "code": 0\n}') => ({
  id, name, module, method, url: 'https://api.example.test' + path, enabled,
  query: [], headers: [], activeScenarioId: id + '-success',
  scenarios: [{ id: id + '-success', name: '成功', body, status: 200, delay: 0, headers: {} }],
});
const products = endpoint('products', '商品列表', '商品', 'GET', '/api/v1/products', true, successBody);
products.scenarios.push(
  { id: 'products-empty', name: '空数据', body: emptyBody, status: 200, delay: 0, headers: {} },
  { id: 'products-error', name: '服务异常', body: errorBody, status: 500, delay: 0, headers: {} },
);
const data = createInitialData();
data.projects = [{
  id: 'store', name: '商城项目', description: '', presets: [], endpoints: [products,
    // Routing is exact today: use a concrete ID instead of implying :id matching.
    endpoint('product-detail', '商品详情', '商品', 'GET', '/api/v1/products/101'),
    endpoint('create-order', '创建订单', '订单', 'POST', '/api/v1/orders'),
    endpoint('orders', '订单列表', '订单', 'GET', '/api/v1/orders'),
    endpoint('me', '用户信息', '用户', 'GET', '/api/v1/me', false),
    endpoint('logout', '退出登录', '用户', 'POST', '/api/v1/logout', false),
  ],
}, { id: 'admin', name: '管理后台', description: '', endpoints: [], presets: [] }];
await writeFile(join(profile, 'data.json'), JSON.stringify(validateData(data), null, 2));
const original = { location: 'design-preview', services: [{
  id: 'design-wifi', name: 'Wi-Fi（隔离预览）', active: true, enabled: true,
  configuration: { HTTPEnable: 0, HTTPProxy: 'previous.example', HTTPPort: 8080,
    HTTPSEnable: 0, HTTPSProxy: 'previous.example', HTTPSPort: 8443,
    ProxyAutoConfigEnable: 1, ProxyAutoConfigURLString: 'https://pac.example.invalid/proxy.pac',
    ProxyAutoDiscoveryEnable: 1, SOCKSEnable: 1, SOCKSProxy: '127.0.0.1', SOCKSPort: 1080,
    ExceptionsList: ['localhost', '*.local'], ExcludeSimpleHostnames: 1 },
}] };
await writeFile(fixture, JSON.stringify({ snapshot: original }));
const env = { ...process.env, MOCK_MANAGER_DATA_DIR: profile,
  MOCK_MANAGER_PROXY_HELPER: helper, MOCK_MANAGER_PROXY_FIXTURE: fixture,
  WHISTLE_PATH: join(profile, 'whistle-config') };
delete env.ELECTRON_RUN_AS_NODE;
delete env.MOCK_MANAGER_DEV_URL;

let app;
let page;
const pageErrors = [];
const consoleErrors = [];
const screenshots = [];
const checks = [];
const result = { passed: false, profile, fixture, realProxyWrites: false, systemTrustWrites: false,
  screenshots, checks, pageErrors, consoleErrors, nativeViewport: null };
const readFixture = async () => JSON.parse(await readFile(fixture, 'utf8'));
const draft = async () => JSON.parse(await readFile(join(profile, 'data.json'), 'utf8'));
const toolbarToggle = () => page.locator('.topbar').getByRole('switch', { name: '系统代理', exact: true });
const apply = async () => {
  await page.getByRole('button', { name: '应用更改', exact: true }).click();
  await page.getByRole('button', { name: '已同步', exact: true }).waitFor();
};
const saved = () => page.waitForFunction(() => document.querySelector('.save-state')?.textContent?.includes('草稿已保存'));
const selectedProducts = async () => {
  assert.equal(await page.locator('.endpoint-item[data-selected="true"] strong').innerText(), '商品列表');
  await page.getByRole('heading', { name: '商品列表', exact: true }).waitFor();
};

async function screenshot(file, width = 1584, height = 992, workbench = true) {
  await page.setViewportSize({ width, height });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  const layout = await page.evaluate(() => {
    const topbar = document.querySelector('.topbar');
    const rect = element => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    };
    return { viewport: { width: innerWidth, height: innerHeight },
      documentWidth: document.documentElement.scrollWidth,
      topbarWidth: topbar.clientWidth, topbarScrollWidth: topbar.scrollWidth,
      controls: [...topbar.querySelectorAll('button, .switch')].map(element => ({
        name: element.getAttribute('aria-label') || element.textContent.trim(), ...rect(element),
      })),
      requests: rect(document.querySelector('.requests')),
      editor: document.querySelector('.endpoint-editor') ? rect(document.querySelector('.endpoint-editor')) : null,
    };
  });
  assert.ok(layout.documentWidth <= width, `${file}: page has horizontal overflow`);
  assert.ok(layout.topbarScrollWidth <= layout.topbarWidth, `${file}: toolbar has horizontal overflow`);
  for (const control of layout.controls) {
    assert.ok(control.width > 0 && control.height > 0 && control.x >= -1 && control.y >= -1
      && control.x + control.width <= width + 1 && control.y + control.height <= height + 1,
    `${file}: toolbar control outside viewport: ${JSON.stringify(control)}`);
  }
  if (workbench) {
    assert.ok(layout.editor, `${file}: interface editor must be present`);
    assert.ok(layout.requests.x + layout.requests.width <= layout.editor.x + 1,
      `${file}: interface list overlaps editor`);
  }
  await page.screenshot({ path: join(output, file), scale: 'css', animations: 'disabled' });
  screenshots.push({ file, ...layout });
}

function httpsMock(port, ca) {
  return new Promise((resolve, reject) => {
    const tunnel = httpRequest({ host: '127.0.0.1', port, method: 'CONNECT',
      path: 'api.example.test:443', agent: false });
    tunnel.setTimeout(8000, () => tunnel.destroy(new Error('CONNECT timeout')));
    tunnel.on('error', reject);
    tunnel.on('connect', (response, socket, head) => {
      if (response.statusCode !== 200) {
        socket.destroy(); reject(new Error('CONNECT failed: ' + response.statusCode)); return;
      }
      if (head.length) socket.unshift(head);
      const agent = new Agent({ keepAlive: false });
      agent.createConnection = () => tlsConnect({ socket, servername: 'api.example.test', ca, rejectUnauthorized: true });
      const request = httpsRequest({ hostname: 'api.example.test', path: '/api/v1/products', agent }, response => {
        let body = '';
        response.on('data', chunk => { body += chunk; });
        response.on('error', error => { agent.destroy(); reject(error); });
        response.on('end', () => {
          agent.destroy();
          try { resolve({ status: response.statusCode, body: JSON.parse(body) }); } catch (error) { reject(error); }
        });
      });
      request.setTimeout(8000, () => request.destroy(new Error('HTTPS mock timeout')));
      request.on('error', error => { agent.destroy(); reject(error); });
      request.end();
    });
    tunnel.end();
  });
}

try {
  app = await electron.launch({ args: ['.'], cwd: process.cwd(), env });
  page = await app.firstWindow();
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.setDefaultTimeout(15000);
  result.nativeViewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, devicePixelRatio }));
  assert.equal(await app.evaluate(({ app }) => app.getPath('userData')), profile);
  await selectedProducts();
  await page.waitForFunction(async () => (await window.mockManager.status()).running);
  // Refresh updates the renderer immediately rather than waiting for polling.
  await page.getByRole('button', { name: '连接设置', exact: true }).click();
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await page.getByRole('button', { name: '完成', exact: true }).click();
  await toolbarToggle().click();
  await page.waitForFunction(async () => (await window.mockManager.systemProxyStatus()).state === 'on');
  await page.waitForFunction(() => document.querySelector('.topbar__proxy input')?.checked);
  assert.equal(await toolbarToggle().isChecked(), true);
  const engine = await page.evaluate(() => window.mockManager.status());
  const installed = (await readFixture()).snapshot.services[0].configuration;
  assert.equal(installed.HTTPPort, engine.port);
  assert.equal(installed.HTTPSPort, engine.port);
  assert.equal(installed.ProxyAutoConfigEnable, 0);
  assert.equal(installed.SOCKSEnable, 0);
  checks.push('toolbar system proxy uses isolated fixture helper for both protocols');

  assert.equal((await page.evaluate(() => window.mockManager.testConnection())).ok, true);
  const certificate = join(profile, 'public-ca.crt');
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, certificate);
  assert.equal(await page.evaluate(() => window.mockManager.exportCertificate()), true);
  const ca = await readFile(certificate);
  assert.equal(new X509Certificate(ca).ca, true);
  assert.ok(!ca.toString().includes('PRIVATE KEY'));
  await apply();
  assert.deepEqual(await httpsMock(engine.port, ca), { status: 200, body: JSON.parse(successBody) });
  checks.push('real local HTTP self-test and HTTPS CONNECT with exported CA verification');

  const list = page.getByRole('region', { name: '接口列表', exact: true });
  const orderSwitch = list.getByRole('switch', { name: '启用接口 订单列表', exact: true });
  await orderSwitch.uncheck();
  await selectedProducts();
  await saved();
  let stored = await draft();
  assert.equal(stored.projects[0].endpoints.find(endpoint => endpoint.id === 'orders').enabled, false);
  assert.equal(stored.lastApplied.projects[0].endpoints.find(endpoint => endpoint.id === 'orders').enabled, true);
  await orderSwitch.check();
  const productSwitch = list.getByRole('switch', { name: '启用接口 商品列表', exact: true });
  await productSwitch.uncheck();
  await selectedProducts();
  await saved();
  stored = await draft();
  assert.equal(stored.projects[0].endpoints[0].enabled, false);
  assert.equal(stored.lastApplied.projects[0].endpoints[0].enabled, true);
  assert.deepEqual(await httpsMock(engine.port, ca), { status: 200, body: JSON.parse(successBody) });
  await productSwitch.check();
  checks.push('row switches preserve selected endpoint and change only saved draft until Apply');

  await page.getByRole('tab', { name: '空数据', exact: true }).click();
  await saved();
  assert.deepEqual(await httpsMock(engine.port, ca), { status: 200, body: JSON.parse(successBody) });
  await apply();
  assert.deepEqual(await httpsMock(engine.port, ca), { status: 200, body: JSON.parse(emptyBody) });
  await page.getByRole('tab', { name: '服务异常', exact: true }).click();
  await apply();
  assert.deepEqual(await httpsMock(engine.port, ca), { status: 500, body: JSON.parse(errorBody) });
  await page.getByRole('tab', { name: '成功', exact: true }).click();
  await saved();
  await page.getByRole('button', { name: '待应用', exact: true }).waitFor();
  assert.equal(await page.getByLabel('响应体 JSON', { exact: true }).inputValue(), successBody);
  checks.push('success, empty and error scenarios use explicit Apply boundary with real HTTPS responses');

  await screenshot('design-workbench.png');
  await screenshot('design-default.png', 1440, 940);
  await screenshot('design-compact.png', 1080, 720);
  await page.setViewportSize({ width: 1584, height: 992 });
  await page.getByRole('button', { name: '连接设置', exact: true }).click();
  await page.getByRole('dialog').getByRole('switch', { name: '系统代理', exact: true }).waitFor();
  await screenshot('design-settings.png');
  await page.getByRole('button', { name: '完成', exact: true }).click();

  await page.getByRole('button', { name: '管理后台', exact: true }).click();
  await page.getByRole('heading', { name: '接口编辑器', exact: true }).waitFor();
  await screenshot('design-empty.png', 1584, 992, false);
  await page.getByRole('button', { name: '商城项目', exact: true }).click();
  await selectedProducts();
  await page.getByLabel('响应体 JSON', { exact: true }).fill('{ invalid JSON');
  await page.getByRole('button', { name: '应用更改', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: /JSON/ }).first().waitFor();
  assert.deepEqual(await httpsMock(engine.port, ca), { status: 500, body: JSON.parse(errorBody) });
  await screenshot('design-validation-error.png');
  await page.getByLabel('响应体 JSON', { exact: true }).fill(successBody);
  await apply();
  assert.deepEqual(await httpsMock(engine.port, ca), { status: 200, body: JSON.parse(successBody) });
  checks.push('invalid JSON blocks Apply and retains previous working response');
  checks.push('CSS-pixel screenshots and viewport/toolbar containment at 1584, 1440 and 1080');

  assert.deepEqual(pageErrors, []);
  assert.deepEqual(consoleErrors, []);
  await app.close();
  app = undefined;
  assert.deepEqual((await readFixture()).snapshot, original, 'quit must restore the entire fixture snapshot');
  checks.push('graceful quit restores original fixture proxy/PAC/SOCKS/bypass configuration');
  result.passed = true;
  result.version = '0.1.3';
  result.engineVersion = engine.version;
  console.log('PASS: design preview, three viewports, draft/apply interactions, HTTPS scenarios, fixture proxy restoration.');
} catch (error) {
  result.error = error instanceof Error ? error.stack : String(error);
  await page?.screenshot({ path: join(output, 'design-failure.png'), scale: 'css', timeout: 3000 }).catch(() => {});
  throw error;
} finally {
  await app?.close().catch(error => { result.cleanupError = error instanceof Error ? error.message : String(error); });
  result.fixtureRestored = JSON.stringify((await readFixture()).snapshot) === JSON.stringify(original);
  await writeFile(join(output, 'design-preview-result.json'), JSON.stringify(result, null, 2));
}
