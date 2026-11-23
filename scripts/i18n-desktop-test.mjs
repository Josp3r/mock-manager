import { _electron as electron } from 'playwright';
import { mkdtemp, mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { get } from 'node:http';
import assert from 'node:assert/strict';

await mkdir('test-results', {recursive:true});
const root = await mkdtemp(resolve('test-results/i18n-'));
const profile = join(root, 'fresh', 'profile');
await assert.rejects(stat(profile), {code:'ENOENT'});
const fixture = join(root, 'proxy-fixture.json');
const original = {location:'i18n-test',services:[{id:'wifi',name:'Wi-Fi',active:true,enabled:true,configuration:{HTTPEnable:0,HTTPSEnable:0}}]};
await writeFile(fixture, JSON.stringify({snapshot:original}));
const env = {...process.env, MOCK_MANAGER_DATA_DIR:profile,
  MOCK_MANAGER_PROXY_HELPER:resolve('scripts/fixtures/system-proxy-helper.cjs'), MOCK_MANAGER_PROXY_FIXTURE:fixture};
delete env.ELECTRON_RUN_AS_NODE;
delete env.MOCK_MANAGER_DEV_URL;
const launch = () => electron.launch({args:['.'],cwd:process.cwd(),env});
let app, page;
const errors = [], consoleErrors = [];
const track = target => {
  target.on('pageerror', error => errors.push(error.message));
  target.on('console', message => {if(message.type()==='error')consoleErrors.push(message.text());});
};
const saved = () => page.waitForFunction(() => /Draft saved|草稿已保存/.test(document.querySelector('.save-state')?.textContent ?? ''));
const readData = () => readFile(join(profile,'data.json'),'utf8');
const menus = () => app.evaluate(({Menu}) => Menu.getApplicationMenu().items.map(item => item.label));
const apply = async () => {
  await page.getByRole('button',{name:'Apply changes',exact:true}).click();
  await page.getByRole('button',{name:'Applied',exact:true}).waitFor();
};
async function switchLanguage(value, current='en') {
  await page.getByRole('button',{name:current==='en'?'Connection settings':'连接设置',exact:true}).click();
  await page.getByRole('combobox',{name:current==='en'?'Language':'语言',exact:true}).selectOption(value);
  await page.waitForFunction(locale => document.documentElement.lang===locale,value);
  await page.getByRole('button',{name:value==='en'?'Done':'完成',exact:true}).click();
}
async function screenshot(file,width=1440,height=940) {
  await page.setViewportSize({width,height});
  const info = await page.evaluate(() => {
    const bar=document.querySelector('.topbar');
    return {width:innerWidth,scroll:document.documentElement.scrollWidth,bar:bar.clientWidth,barScroll:bar.scrollWidth,
      controls:[...document.querySelectorAll('.topbar button,.topbar .switch')].map(el=>{
        const {x,y,width,height}=el.getBoundingClientRect();return {name:el.textContent.trim(),x,y,width,height};
      })};
  });
  assert.ok(info.scroll<=width && info.barScroll<=info.bar,'English topbar overflows');
  for(const rect of info.controls)assert.ok(rect.x>=0 && rect.x+rect.width<=width+1 && rect.y+rect.height<=height,JSON.stringify(rect));
  if (await page.locator('html').getAttribute('lang') === 'en') {
    const label = page.locator('.nav-row--module > span').filter({hasText:/^All endpoints$/});
    if (await label.count()) assert.ok(await label.evaluate(el => el.scrollWidth <= el.clientWidth), 'All endpoints label is truncated');
  }
  await page.screenshot({path:'test-results/'+file,scale:'css',animations:'disabled'});
}
let proxy;
const mock = () => new Promise((resolve,reject) => {
  const request=get({host:'127.0.0.1',port:proxy.port,path:'http://api.example.test/i18n/products',agent:false},response=>{
    let body='';response.on('data',chunk=>body+=chunk);response.on('end',()=>{try{resolve(JSON.parse(body));}catch(error){reject(error);}});
  });request.on('error',reject);
});
try {
  app=await launch();page=await app.firstWindow();track(page);
  await page.locator('.endpoint-editor').waitFor();
  assert.ok((await stat(profile)).isDirectory(),'fresh nested profile is created by the app');
  const initial=await page.evaluate(()=>window.mockManager.getLanguage());
  assert.equal(initial.preference,'system');
  await saved();
  const initialBytes=await readData();
  await switchLanguage('en',initial.locale);
  assert.equal(await readData(),initialBytes,'language changes do not mutate existing user/sample data');
  assert.ok((await menus()).includes('Edit'));
  assert.equal(await page.locator('html').getAttribute('lang'),'en');

  await page.getByRole('button',{name:'New project',exact:true}).click();
  await page.getByLabel('Project name',{exact:true}).fill('Storefront');
  await page.getByRole('button',{name:'Create project',exact:true}).click();
  await page.getByRole('button',{name:'New endpoint',exact:true}).click();
  await page.getByLabel('Endpoint name',{exact:true}).fill('Product list');
  await page.getByLabel('Request URL',{exact:true}).fill('http://api.example.test/i18n/products');
  await page.getByLabel('Module',{exact:true}).fill('Products');
  await page.getByRole('button',{name:'Create endpoint',exact:true}).click();
  const body='{"code":0,"name":"商品","items":[{"id":1,"name":"Keyboard"}]}';
  await page.getByLabel('Response JSON',{exact:true}).fill(body);
  await page.getByRole('switch',{name:'Enable endpoint',exact:true}).check();
  await page.waitForFunction(async()=>(await window.mockManager.status()).running);
  proxy=await page.evaluate(()=>window.mockManager.status());
  await apply();
  assert.deepEqual(await mock(),JSON.parse(body));
  const draft='{"code":0,"name":"未应用草稿","items":[]}';
  await page.getByLabel('Response JSON',{exact:true}).fill(draft);await saved();
  const beforeSwitch=await readData();
  await switchLanguage('zh-CN');
  assert.ok((await menus()).includes('编辑'));
  assert.equal(await page.getByLabel('响应体 JSON',{exact:true}).inputValue(),draft);
  assert.equal(await readData(),beforeSwitch,'switching language must not change saved draft or applied snapshot');
  assert.deepEqual(await mock(),JSON.parse(body),'language does not apply a pending draft');
  await page.getByRole('heading',{name:'Product list',exact:true}).waitFor();
  await screenshot('i18n-zh.png');
  await switchLanguage('en','zh-CN');
  await assert.rejects(page.evaluate(()=>window.mockManager.setLanguage('invalid')),/Invalid language/);
  assert.equal((await page.evaluate(()=>window.mockManager.getLanguage())).preference,'en');
  await page.getByLabel('Response JSON',{exact:true}).fill('{ invalid');
  await page.getByRole('button',{name:'Apply changes',exact:true}).click();
  const alert=page.getByRole('alert').filter({hasText:/JSON/}).first();await alert.waitFor();
  assert.ok(!/[\u3400-\u9fff]/u.test(await alert.innerText()),'new backend validation is localized in English');
  assert.deepEqual(await mock(),JSON.parse(body));
  await page.getByLabel('Response JSON',{exact:true}).fill(draft);await apply();
  await screenshot('i18n-en.png');
  await screenshot('i18n-en-compact.png',1080,720);
  await page.setViewportSize({width:1440,height:940});
  await page.getByRole('button',{name:'Connection settings',exact:true}).click();
  await screenshot('i18n-settings-en.png');
  await app.evaluate(({dialog})=>{dialog.showSaveDialog=async (...args)=>{globalThis.lastSaveTitle=args.at(-1).title;return {canceled:true};};});
  await page.getByRole('button',{name:'Export certificate',exact:true}).click();
  await page.getByText('Certificate export cancelled.',{exact:true}).waitFor();
  assert.equal(await app.evaluate(()=>globalThis.lastSaveTitle),'Export HTTPS root certificate');
  await page.getByRole('combobox',{name:'Language',exact:true}).selectOption('zh-CN');
  await page.getByText('已取消导出根证书。',{exact:true}).waitFor();
  await page.getByRole('button',{name:'测试连接',exact:true}).click();
  await page.locator('.connection-test:not(.connection-test--error)').waitFor();
  await page.getByRole('combobox',{name:'语言',exact:true}).selectOption('en');
  await page.waitForFunction(() => document.documentElement.lang==='en');
  assert.ok(!/[\u3400-\u9fff]/u.test(await page.locator('.connection-test').innerText()),'successful connection result follows the current language');
  await page.getByRole('button',{name:'Done',exact:true}).click();
  await saved();
  const finalBytes=await readData();
  await app.close();app=await launch();page=await app.firstWindow();track(page);
  await page.getByRole('button',{name:'New project',exact:true}).waitFor();
  assert.equal((await page.evaluate(()=>window.mockManager.getLanguage())).preference,'en');
  assert.ok((await menus()).includes('Edit'));
  assert.equal(await readData(),finalBytes,'reopening preserves locale and mock data');
  await page.getByRole('button',{name:'Storefront',exact:true}).click();
  assert.equal(await page.getByLabel('Response JSON',{exact:true}).inputValue(),draft);
  assert.deepEqual(errors,[]);assert.deepEqual(consoleErrors,[]);
  await app.close();app=undefined;
  assert.deepEqual(JSON.parse(await readFile(fixture,'utf8')).snapshot,original);
  await writeFile('test-results/i18n-result.json',JSON.stringify({passed:true,version:'0.1.4',pageErrors:errors,consoleErrors,
    realProxyWrites:false,checks:['fresh nested profile','system default bootstrap','live Chinese/English switch','localized native menus/dialogs','invalid preference rejected','draft/user content/applied snapshot unchanged','real HTTP mock unchanged by language switch','English backend validation','notice rerenders in selected language','1080px English layout','preference survives restart']},null,2));
  console.log('PASS: bilingual desktop, native menus/dialogs, preserved drafts/real mock, restart and English layout.');
} catch(error) {
  await page?.screenshot({path:'test-results/i18n-failure.png',scale:'css',timeout:3000}).catch(()=>{});
  throw error;
} finally {await app?.close().catch(()=>{});}
