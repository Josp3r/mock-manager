import { execFile, fork } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { createServer, request } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { DataStore } from '../src/main/store';
import { SyncController } from '../src/main/sync';
import type { WhistleAccess, WhistleApi } from '../src/main/whistle';

const exec = promisify(execFile);
const {stdout} = await exec('w2',['root','bin/api']);
const apiPath = stdout.trim();
const whistleRoot = resolve(dirname(apiPath),'..');
await mkdir('test-results',{recursive:true});
const temp = await mkdtemp(resolve('test-results/proxy-'));
process.env.WHISTLE_PATH = join(temp,'api-config');
let upstreamHits = 0;
const upstream = createServer((req,res) => { upstreamHits++; res.setHeader('content-type','application/json');res.end(JSON.stringify({source:'upstream',path:req.url})); });
await new Promise<void>(r => upstream.listen(0,'127.0.0.1',r));
const upstreamPort = (upstream.address() as any).port;
const reserve = createServer(); await new Promise<void>(r=>reserve.listen(0,'127.0.0.1',r));
const port = (reserve.address() as any).port; await new Promise<void>(r=>reserve.close(()=>r()));
const workerPath = join(temp,'worker.cjs');
await writeFile(workerPath, `process.env.WHISTLE_PATH=process.env.TEST_WHISTLE_DATA; require(${JSON.stringify(whistleRoot)})({port:Number(process.env.TEST_WHISTLE_PORT),host:'127.0.0.1',baseDir:process.env.TEST_WHISTLE_DATA,disableAllPlugins:true,noGlobalPlugins:true,mode:'rules'},()=>process.send({ready:true}));`);
const child = fork(workerPath,[],{env:{...process.env,TEST_WHISTLE_DATA:join(temp,'whistle'),TEST_WHISTLE_PORT:String(port)},stdio:['ignore','pipe','pipe','ipc']});
let logs=''; child.stderr?.on('data',d=>logs+=String(d));
async function call(path:string, method='GET', headers:Record<string,string>={}) {
  return new Promise<{status:number;body:any;headers:any}>((res,rej) => {
    const req=request({host:'127.0.0.1',port,path:`http://api.example.test${path}`,method,headers:{host:'api.example.test',...headers}},r=>{let body='';r.on('data',d=>body+=d);r.on('end',()=>{try {res({status:r.statusCode!,body:JSON.parse(body),headers:r.headers});} catch {rej(new Error(`Non-JSON (${r.statusCode}): ${body.slice(0,500)}`));}});});
    req.setTimeout(5000,()=>req.destroy(new Error('proxy request timed out')));req.on('error',rej);req.end();
  });
}
try {
  await new Promise<void>((res,rej)=>{const t=setTimeout(()=>rej(new Error(`Whistle startup timed out: ${logs}`)),15000);child.once('message',()=>{clearTimeout(t);res();});child.once('exit',code=>{clearTimeout(t);rej(new Error(`Whistle exited ${code}: ${logs}`));});});
  // Only replace discovery for this test process. The official API still talks
  // over HTTP to a real isolated Whistle server and exercises its rule engine.
  const req = createRequire(import.meta.url);
  const use = req(join(whistleRoot,'bin/use'));
  use.getConfig = (options:any,cb:any) => (typeof options==='function'?options:cb)(null,{options:{host:'127.0.0.1',port}});
  const api = req(apiPath) as WhistleApi;
  const access:WhistleAccess={find:async()=>'/isolated/w2',resolve:async()=>({path:'/isolated/w2',api}),start:async()=>{}};
  await api.rules.setMultiSelect(true);
  await api.rules.add('existing-integration-upstream',`api.example.test host://127.0.0.1:${upstreamPort}`,true);
  const controller=new SyncController(new DataStore(join(temp,'app data with spaces')),access);
  let data=await controller.load();
  const endpoint=data.projects[0].endpoints[0];
  data.projects[0].endpoints=[endpoint];
  data.projects[0].presets=[];
  endpoint.url='http://api.example.test/api/users'; endpoint.enabled=true;endpoint.method='GET';endpoint.query=[];endpoint.headers=[];
  const scenario=endpoint.scenarios[0];endpoint.activeScenarioId=scenario.id;
  scenario.body='{"source":"mock","users":[{"id":1}]}';scenario.status=200;scenario.delay=0;scenario.headers={'x-mock-proof':'yes'};
  await controller.saveDraft(data);await controller.apply();
  const normal=await call('/api/users?ignored=1');assert.equal(normal.body.source,'mock');assert.equal(normal.headers['x-mock-proof'],'yes');assert.equal(upstreamHits,0);
  assert.equal((await call('/api/users-extra')).body.source,'upstream');
  assert.equal((await call('/api/users','POST')).body.source,'upstream');
  scenario.body='{"source":"draft"}';await controller.saveDraft(data);
  assert.equal((await call('/api/users')).body.source,'mock','draft must not leak into live fixtures');
  scenario.body='[]';await controller.saveDraft(data);await controller.apply();assert.deepEqual((await call('/api/users')).body,[]);
  scenario.body='{"error":"simulated"}';scenario.status=500;scenario.delay=90;
  await controller.saveDraft(data);await controller.apply();
  const start=Date.now();const error=await call('/api/users');assert.equal(error.status,500);assert.equal(error.body.error,'simulated');assert.ok(Date.now()-start>=75,'latency must be applied');
  scenario.status=200;scenario.delay=0;scenario.body='{"source":"conditional"}';
  endpoint.query=[{key:'scene',value:'empty'},{key:'page',value:'1'}];endpoint.headers=[{key:'x-case',value:'yes'}];
  await controller.saveDraft(data);await controller.apply();
  assert.equal((await call('/api/users?scene=empty&page=1','GET',{'x-case':'yes'})).body.source,'conditional');
  assert.equal((await call('/api/users?scene=empty','GET',{'x-case':'yes'})).body.source,'upstream');
  assert.equal((await call('/api/users?scene=empty&page=2','GET',{'x-case':'yes'})).body.source,'upstream');
  assert.equal((await call('/api/users?scene=empty&page=1')).body.source,'upstream');
  await controller.disable();
  assert.equal((await call('/api/users?scene=empty&page=1','GET',{'x-case':'yes'})).body.source,'upstream');
  assert.ok((await api.rules.getStatus()).list.find(x=>x.name==='existing-integration-upstream')?.selected);
  console.log('PASS: real Whistle success, empty, 500, latency, headers, exact path/method, AND conditions, immutable drafts, and disable passthrough.');
} finally {
  child.kill('SIGTERM');upstream.closeAllConnections();await new Promise<void>(r=>upstream.close(()=>r()));
  await new Promise<void>(r=>{if(child.exitCode!==null)r();else{child.once('exit',()=>r());setTimeout(()=>{child.kill('SIGKILL');r();},2000).unref();}});
}
