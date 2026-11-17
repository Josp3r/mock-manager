import { _electron as electron } from 'playwright';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
import { createProxyHarness } from './proxy-harness.mjs';

await mkdir('test-results',{recursive:true});
const dataDir=await mkdtemp(resolve('test-results/desktop-'));
const env={...process.env,MOCK_MANAGER_DATA_DIR:dataDir,WHISTLE_PATH:join(dataDir,'whistle-config')};
delete env.ELECTRON_RUN_AS_NODE;
const launch=()=>electron.launch({args:['.'],cwd:process.cwd(),env});
let app=await launch();
let proxy;
const errors=[];
try {
  let page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));
  await page.getByRole('button',{name:'新建项目',exact:true}).waitFor();
  await page.getByRole('button',{name:'新建项目',exact:true}).click();
  await page.getByLabel('项目名称',{exact:true}).fill('桌面验证项目');
  await page.getByRole('button',{name:'创建项目',exact:true}).click();
  await page.getByRole('button',{name:'新建接口',exact:true}).click();
  await page.getByLabel('接口名称',{exact:true}).fill('查询用户列表');
  await page.getByLabel('请求 URL').fill('http://api.example.test/api/users');
  await page.getByRole('button',{name:'创建接口',exact:true}).click();
  await page.getByLabel('响应体 JSON',{exact:true}).fill('{\n  "code": 0,\n  "data": [{"id": 1, "name": "示例用户"}]\n}');
  await page.getByRole('switch',{name:'启用接口'}).check();
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
  await page.getByRole('button',{name:'应用到 Whistle',exact:true}).click();
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
  proxy=await createProxyHarness(dataDir);
  stored.settings.w2Path=proxy.w2;
  await writeFile(join(dataDir,'data.json'),JSON.stringify(stored,null,2));
  app=await launch();page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));
  await page.getByRole('button',{name:'桌面验证项目',exact:true}).click();
  await page.getByRole('heading',{name:'查询用户列表',exact:true}).waitFor();
  assert.ok((await page.getByLabel('响应体 JSON',{exact:true}).inputValue()).includes('没有匹配的用户'));
  await page.getByRole('button',{name:'连接设置',exact:true}).click();
  await page.getByRole('heading',{name:'连接设置',exact:true}).waitFor();
  assert.ok((await page.getByRole('dialog').innerText()).includes('w2 路径'));
  await page.getByRole('button',{name:'完成',exact:true}).click();
  await page.getByRole('button',{name:'应用到 Whistle',exact:true}).click();
  await page.getByRole('button',{name:'已同步',exact:true}).waitFor();
  assert.equal((await proxy.call()).body.message,'没有匹配的用户');
  assert.equal((await page.evaluate(()=>window.mockManager.status())).port,proxy.port,'real resolver port');
  await page.getByRole('tab',{name:'默认响应',exact:true}).click();
  await page.getByRole('button',{name:'应用到 Whistle',exact:true}).click();
  await page.getByRole('button',{name:'已同步',exact:true}).waitFor();
  assert.equal((await proxy.call()).body.data[0].name,'示例用户');
  await page.screenshot({path:'test-results/desktop-workbench.png'});
  await page.setViewportSize({width:1080,height:720});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'minimum-width layout overflows');
  await page.screenshot({path:'test-results/desktop-compact.png'});
  assert.deepEqual(errors,[]);
  await writeFile('test-results/desktop-result.json',JSON.stringify({passed:true,dataDir,checks:['native preload','project/endpoint CRUD','JSON editing','scenario selection','project presets','draft validation','close flush','persistence after restart','real Whistle Apply','real scenario switch','nondefault proxy port','settings','minimum-size layout']},null,2));
  console.log('PASS: native Electron CRUD, scenes, presets, invalid draft protection, close flush, persistence, real Whistle Apply/switch, settings and compact layout.');
} finally { await app.close().catch(()=>{});if(proxy)await proxy.close(); }
