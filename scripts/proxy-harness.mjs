import { execFile, fork } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { createServer, request } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';

export async function createProxyHarness(temp,host='127.0.0.1') {
  const {stdout}=await promisify(execFile)('w2',['root','bin/api']);
  const actualApi=stdout.trim(), root=resolve(dirname(actualApi),'..');
  const upstream=createServer((_req,res)=>{res.setHeader('content-type','application/json');res.end('{"source":"upstream"}');});
  await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
  const reserve=createServer();await new Promise((r,rej)=>reserve.once('error',rej).listen(0,host,r));
  const port=reserve.address().port;await new Promise(r=>reserve.close(r));
  const worker=join(temp,'whistle-worker.cjs');
  await writeFile(worker,`process.env.WHISTLE_PATH=process.env.TEST_WHISTLE_DATA;require(${JSON.stringify(root)})({port:${port},host:${JSON.stringify(host)},baseDir:process.env.TEST_WHISTLE_DATA,disableAllPlugins:true,noGlobalPlugins:true,mode:'rules'},()=>process.send({ready:true}));`);
  const child=fork(worker,[],{env:{...process.env,TEST_WHISTLE_DATA:join(temp,'proxy-data')},stdio:['ignore','ignore','pipe','ipc']});
  let errors='';child.stderr.on('data',d=>errors+=d);
  try { await new Promise((res,rej)=>{const t=setTimeout(()=>rej(new Error(errors||'isolated Whistle startup timeout')),15000);child.once('message',()=>{clearTimeout(t);res();});child.once('exit',()=>{clearTimeout(t);rej(new Error(errors||'isolated Whistle exited'));});}); }
  catch(error) {child.kill();upstream.close();throw error;}
  const sdk=join(temp,'isolated-sdk');await mkdir(sdk);
  await writeFile(join(sdk,'package.json'),'{"type":"commonjs"}');
  const shimApi=join(sdk,'api.cjs');
  await writeFile(join(sdk,'use.js'),`const use=require(${JSON.stringify(join(root,'bin/use'))});use.getConfig=(options,cb)=>(typeof options==='function'?options:cb)(null,{options:{host:${JSON.stringify(host)},port:${port}}});module.exports=use;`);
  await writeFile(shimApi,`require('./use');module.exports=require(${JSON.stringify(actualApi)});`);
  const w2=join(temp,'isolated-w2');
  await writeFile(w2,`#!${process.execPath}\nif(process.argv.slice(2).join(' ')==='root bin/api')console.log(${JSON.stringify(shimApi)});else process.exit(1);`,{mode:0o700});
  process.env.WHISTLE_PATH=join(temp,'harness-api');
  const api=createRequire(import.meta.url)(shimApi);
  await api.rules.setMultiSelect(true);
  await api.rules.add('existing-desktop-upstream',`api.example.test host://127.0.0.1:${upstream.address().port}`,true);
  const call=()=>new Promise((res,rej)=>{
    const req=request({host,port,path:'http://api.example.test/api/users',headers:{host:'api.example.test'}},r=>{let body='';r.on('data',d=>body+=d);r.on('end',()=>{try{res({status:r.statusCode,body:JSON.parse(body)});}catch(e){rej(new Error(body));}});});
    req.on('error',rej);req.setTimeout(5000,()=>req.destroy(new Error('request timeout')));req.end();
  });
  return {w2,port,call,close:async()=>{child.kill('SIGTERM');upstream.closeAllConnections();await new Promise(r=>upstream.close(r));await new Promise(r=>{if(child.exitCode!==null)r();else{child.once('exit',r);setTimeout(()=>{child.kill('SIGKILL');r();},2000).unref();}});}};
}
