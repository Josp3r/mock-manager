import { _electron as electron } from 'playwright';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { request as httpRequest, get } from 'node:http';
import { request as httpsRequest, Agent } from 'node:https';
import { connect as tlsConnect } from 'node:tls';
import { X509Certificate } from 'node:crypto';
import assert from 'node:assert/strict';

await mkdir('test-results', {recursive:true});
const root=await mkdtemp(resolve('test-results/packaged-builtin-'));
const bundle=resolve(process.argv[2] || 'release/mac-arm64/Whistle Mock Manager.app');
const env={...process.env,PATH:join(root,'empty-path'),MOCK_MANAGER_DATA_DIR:'/invalid/unpackaged/profile',MOCK_MANAGER_PROXY_HELPER:'/invalid/unpackaged/helper'};
delete env.ELECTRON_RUN_AS_NODE;
const launch=()=>electron.launch({executablePath:join(bundle,'Contents/MacOS/Whistle Mock Manager'),args:['--user-data-dir='+root],env});
const unreachable=port=>new Promise((res,rej)=>{
  const req=get({host:'127.0.0.1',port,path:'/',agent:false},r=>{r.resume();rej(new Error('Engine still listening after quit'));});
  req.once('error',err=>err.code==='ECONNREFUSED'?res():rej(err));
});
async function httpsMock(port,ca) {
  return new Promise((resolve,reject)=>{
    const tunnel=httpRequest({host:'127.0.0.1',port,method:'CONNECT',path:'api.example.test:443',agent:false});
    tunnel.setTimeout(8000,()=>tunnel.destroy(new Error('CONNECT timeout')));
    tunnel.on('error',reject);
    tunnel.on('connect',(res,socket,head)=>{
      if(res.statusCode!==200){socket.destroy();reject(new Error('CONNECT failed '+res.statusCode));return;}
      if(head.length)socket.unshift(head);
      const agent=new Agent({keepAlive:false});
      agent.createConnection=()=>tlsConnect({socket,servername:'api.example.test',ca,rejectUnauthorized:true});
      const req=httpsRequest({hostname:'api.example.test',path:'/packaged-health',agent},response=>{
        let body='';response.on('data',chunk=>body+=chunk);response.on('error',reject);
        response.on('end',()=>{agent.destroy();try{resolve({status:response.statusCode,body:JSON.parse(body)});}catch(error){reject(error);}});
      });
      req.setTimeout(8000,()=>req.destroy(new Error('HTTPS mock timeout')));
      req.on('error',error=>{agent.destroy();reject(error);});req.end();
    });tunnel.end();
  });
}
let app;
try {
  app=await launch();let page=await app.firstWindow();
  await page.waitForFunction(async()=> (await window.mockManager.status()).running);
  const info=await app.evaluate(({app})=>({packaged:app.isPackaged,version:app.getVersion(),root:app.getPath('userData')}));
  assert.deepEqual(info,{packaged:true,version:'0.1.2',root});
  let status=await page.evaluate(()=>window.mockManager.status());
  assert.equal(status.version,'2.10.15');assert.equal(status.host,'127.0.0.1');
  const proxy=await page.evaluate(()=>window.mockManager.systemProxyStatus());
  assert.equal(proxy.managed,false);assert.notEqual(proxy.state,'error');
  assert.equal((await page.evaluate(()=>window.mockManager.testConnection())).ok,true);
  const certificate=join(root,'public-ca.crt');
  await app.evaluate(({dialog},filePath)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath});},certificate);
  assert.equal(await page.evaluate(()=>window.mockManager.exportCertificate()),true);
  const ca=await readFile(certificate);assert.equal(new X509Certificate(ca).ca,true);assert.ok(!ca.toString().includes('PRIVATE KEY'));
  await page.evaluate(async()=>{
    const data=await window.mockManager.load();const endpoint=data.projects[0].endpoints[0];
    endpoint.url='https://api.example.test/packaged-health';endpoint.enabled=true;
    endpoint.scenarios[0].body='{"packaged":true,"data":[1,2,3]}';
    await window.mockManager.save(data);await window.mockManager.apply();
  });
  assert.deepEqual(await httpsMock(status.port,ca),{status:200,body:{packaged:true,data:[1,2,3]}});
  await page.getByRole('button',{name:'连接设置',exact:true}).click();
  await page.screenshot({path:'test-results/packaged-builtin-settings.png'});
  const port=status.port;
  await app.close();app=undefined;await unreachable(port);
  app=await launch();page=await app.firstWindow();
  await page.waitForFunction(async()=> (await window.mockManager.status()).running);
  status=await page.evaluate(()=>window.mockManager.status());assert.equal(status.port,port);assert.equal(status.syncState,'synced');
  assert.deepEqual(await httpsMock(port,ca),{status:200,body:{packaged:true,data:[1,2,3]}});
  await writeFile('test-results/packaged-builtin-result.json',JSON.stringify({passed:true,version:info.version,whistle:status.version,isolatedProfile:true,noNodeOrW2InPath:true,ignoredDevOverrides:true,realProxyWrites:false,systemTrustWrites:false,checks:['fresh automatic startup','real packaged native helper read','local HTTP self-test','public CA export','HTTPS CONNECT+CA verification+mock','quit releases port','restart same port/CA/rule']},null,2));
  console.log('PASS: packaged builtin engine without Node/w2, real HTTPS mock with exported CA, restart persistence, quit cleanup. No OS proxy/trust writes.');
} finally {await app?.close();}
