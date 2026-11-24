// Exercise the unpackaged helper path as well as the packaged-resource path.
import { _electron as electron } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const root=await mkdtemp(join(tmpdir(),'mock-manager-development-'));
const env={...process.env,MOCK_MANAGER_DATA_DIR:root};
delete env.ELECTRON_RUN_AS_NODE;
delete env.MOCK_MANAGER_DEV_URL;
delete env.MOCK_MANAGER_PROXY_HELPER;
let app;
try {
  app=await electron.launch({args:['.'],cwd:process.cwd(),env,timeout:60000});
  const page=await app.firstWindow();
  await page.waitForFunction(async()=>(await window.mockManager.status()).running);
  assert.equal(await app.evaluate(({app})=>app.isPackaged),false);
  assert.equal(await page.evaluate(()=>window.mockManager.platform),process.platform);
  const status=await page.evaluate(()=>window.mockManager.systemProxyStatus());
  assert.equal(status.supported,true);
  assert.notEqual(status.state,'error',status.message);
  assert.equal(status.managed,false);
  console.log('PASS: unpackaged native helper resolves and reads system proxy without modifying it.');
} finally {
  await app?.close();
  await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
