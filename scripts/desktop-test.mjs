import { waitForPageCondition } from './async-page-wait.mjs';
import { _electron as electron } from 'playwright';
import { mkdtemp, mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
import { get } from 'node:http';
import { X509Certificate } from 'node:crypto';

await mkdir('test-results',{recursive:true});
const testRoot=await mkdtemp(resolve('test-results/desktop-'));
const dataDir=join(testRoot,'fresh','profile');
await mkdir(dataDir, {recursive:true});
await writeFile(join(dataDir,'preferences.json'), JSON.stringify({language:'zh-CN'}));
const env={...process.env,MOCK_MANAGER_DATA_DIR:dataDir,WHISTLE_PATH:join(dataDir,'whistle-config')};
delete env.ELECTRON_RUN_AS_NODE;
const launch=()=>electron.launch({args:['.'],cwd:process.cwd(),env});
let app=await launch();
let proxy;
const proxyCall = () => new Promise((resolve, reject) => {
  const req = get({host:'127.0.0.1',port:proxy.port,path:'http://api.example.test/api/users',agent:false}, res => {
    let text=''; res.on('data', chunk => text+=chunk); res.on('end',()=>{try { resolve({body:JSON.parse(text)}); } catch(error) { reject(error); }});
  });
  req.on('error',reject);
});
const errors=[];
try {
  let page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));
  assert.equal(await app.evaluate(({app})=>app.getPath('userData')),dataDir);
  assert.ok((await stat(dataDir)).isDirectory(),'isolated profile remains available');
  await page.getByRole('button',{name:'新建项目',exact:true}).waitFor();
  await page.locator('.project-description').filter({hasText:'仅用于演示。示例域名 api.example.test'}).waitFor();
  for (const [width,height] of [[1440,940],[1080,720]]) {
    await page.setViewportSize({width,height});
    const requests=await page.getByRole('region',{name:'接口列表',exact:true}).boundingBox();
    const editor=await page.locator('.endpoint-editor').boundingBox();
    assert.ok(requests && editor,`both workbench columns must be visible at ${width}px`);
    for (const control of [
      page.locator('.project-description'), page.locator('.search'),
      page.getByRole('searchbox',{name:'搜索接口',exact:true}),
      page.getByRole('button',{name:'编辑项目',exact:true}), page.getByRole('button',{name:'删除项目',exact:true}),
    ]) {
      const bounds=await control.boundingBox();
      assert.ok(bounds && bounds.x>=requests.x && bounds.x+bounds.width<=Math.min(requests.x+requests.width,editor.x),
        `${control} overlaps the adjacent editor at ${width}px: ${JSON.stringify({bounds,requests,editor})}`);
    }
    await page.screenshot({path:`test-results/desktop-default-${width}.png`});
  }
  await page.setViewportSize({width:1440,height:940});
  await page.getByRole('button',{name:'新建项目',exact:true}).click();
  await page.getByLabel('项目名称',{exact:true}).fill('桌面验证项目');
  await page.getByRole('button',{name:'创建项目',exact:true}).click();
  await page.getByRole('button',{name:'新建接口',exact:true}).click();
  await page.getByLabel('接口名称',{exact:true}).fill('查询用户列表');
  await page.getByLabel('请求 URL').fill('http://api.example.test/api/users');
  await page.getByRole('button',{name:'创建接口',exact:true}).click();
  await page.getByLabel('响应体 JSON',{exact:true}).fill('{\n  "code": 0,\n  "data": [{"id": 1, "name": "示例用户"}]\n}');
  await page.getByRole('switch',{name:'启用接口',exact:true}).check();
  await page.getByRole('button',{name:'新增场景',exact:true}).click();
  await page.getByLabel('场景名称',{exact:true}).fill('空数据');
  await page.getByRole('button',{name:'创建场景',exact:true}).click();
  await page.getByLabel('响应体 JSON',{exact:true}).fill('{\n  "code": 0,\n  "data": []\n}');
  await page.getByRole('button',{name:'项目预设',exact:true}).click();
  await page.getByRole('button',{name:'保存为预设',exact:true}).click();
  await page.getByLabel('预设名称',{exact:true}).fill('空列表场景');
  await page.getByRole('button',{name:'保存预设',exact:true}).click();
  await page.getByRole('button',{name:'关闭',exact:true}).click();
  // Flush through the real preload / main process API, then read the actual file.
  await page.waitForFunction(()=>document.querySelector('.save-state')?.textContent?.includes('草稿已保存'));
  let stored=JSON.parse(await readFile(join(dataDir,'data.json'),'utf8'));
  const project=stored.projects.find(x=>x.name==='桌面验证项目');
  assert.equal(project.endpoints[0].scenarios.length,2);assert.equal(project.presets.length,1);assert.equal(project.endpoints[0].enabled,true);
  // Invalid JSON is preserved as a draft, visibly rejected before proxy changes.
  await page.getByLabel('响应体 JSON',{exact:true}).fill('{invalid');
  await page.getByRole('button',{name:'应用更改',exact:true}).click();
  await page.getByRole('alert').filter({hasText:/JSON/}).waitFor();
  await page.getByLabel('响应体 JSON',{exact:true}).fill('{\n  "code": 0,\n  "data": [],\n  "message": "没有匹配的用户"\n}');
  // Close immediately, inside the debounce interval: the renderer must flush.
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());
  for(let count=0;count<60;count++) {
    stored=JSON.parse(await readFile(join(dataDir,'data.json'),'utf8'));
    if(JSON.stringify(stored).includes('没有匹配的用户'))break;
    await new Promise(r=>setTimeout(r,50));
  }
  assert.ok(JSON.stringify(stored).includes('没有匹配的用户'),'closing must flush pending draft');
  await app.close();
  app=await launch();page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));
  await page.getByRole('button',{name:'桌面验证项目',exact:true}).click();
  await page.getByRole('heading',{name:'查询用户列表',exact:true}).waitFor();
  assert.ok((await page.getByLabel('响应体 JSON',{exact:true}).inputValue()).includes('没有匹配的用户'));
  await page.getByRole('button',{name:'连接设置',exact:true}).click();
  await page.getByRole('heading',{name:'连接设置',exact:true}).waitFor();
  const settings=page.getByRole('dialog');
  await waitForPageCondition(page, async()=> (await window.mockManager.status()).running, { description: 'bundled engine startup' });
  proxy=await page.evaluate(()=>window.mockManager.status());
  const address=proxy.address;
  await settings.getByText(address,{exact:false}).waitFor();
  await page.locator('.statusbar').getByText(address,{exact:true}).waitFor();
  assert.ok((await settings.innerText()).includes('本地代理引擎'));
  assert.ok(!(await settings.innerText()).includes('选择 w2'));
  assert.equal((await page.evaluate(()=>window.mockManager.testConnection())).ok,true);
  const certPath=join(dataDir,'exported.crt');
  await app.evaluate(({dialog}, filePath) => {dialog.showSaveDialog=async()=>({canceled:false,filePath});}, certPath);
  assert.equal(await page.evaluate(()=>window.mockManager.exportCertificate()),true);
  assert.equal(new X509Certificate(await readFile(certPath)).ca,true);
  assert.ok(!(await readFile(certPath,'utf8')).includes('PRIVATE KEY'));
  await page.screenshot({path:'test-results/builtin-settings.png'});
  await page.getByRole('button',{name:'完成',exact:true}).click();
  await page.getByRole('button',{name:'应用更改',exact:true}).click();
  await page.getByRole('button',{name:'已同步',exact:true}).waitFor();
  assert.equal((await proxyCall()).body.message,'没有匹配的用户');
  const status=await page.evaluate(()=>window.mockManager.status());
  assert.equal(status.host,'127.0.0.1','builtin loopback host');
  assert.equal(status.port,proxy.port,'real resolver port');
  await page.getByRole('tab',{name:'默认响应',exact:true}).click();
  await page.getByRole('button',{name:'应用更改',exact:true}).click();
  await page.getByRole('button',{name:'已同步',exact:true}).waitFor();
  assert.equal((await proxyCall()).body.data[0].name,'示例用户');
  await page.screenshot({path:'test-results/desktop-workbench.png'});
  await page.setViewportSize({width:1080,height:720});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'minimum-width layout overflows');
  await page.screenshot({path:'test-results/desktop-compact.png'});
  await page.getByLabel('响应体 JSON',{exact:true}).fill('{\"quitFlush\":true}');
  await app.close();
  assert.ok((await readFile(join(dataDir,'data.json'),'utf8')).includes('quitFlush'),'quit must await draft save');
  assert.deepEqual(errors,[]);
  await writeFile('test-results/desktop-result.json',JSON.stringify({passed:true,dataDir,checks:['native preload','project/endpoint CRUD','JSON editing','scenario selection','project presets','draft validation','close flush','persistence after restart','real Whistle Apply','real scenario switch','builtin proxy without global w2','certificate export','proxy self-test','default project layout at 1440 and 1080']},null,2));
  console.log('PASS: native Electron CRUD, scenes, presets, invalid draft protection, close flush, persistence, real Whistle Apply/switch, settings and compact layout.');
} finally { await app.close().catch(()=>{}); }
