import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { createServer, get } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app } from 'electron';
import { EmbeddedWhistle } from '../src/main/embedded-whistle';

const profile = process.argv[2];
app.setPath('userData', profile);
const worker = join(__dirname, process.argv[3] === 'parent-exit' ? 'whistle-worker.cjs' : 'whistle-persistence-worker.cjs');
const builtin = '@builtin';
const loopback = '127.0.0.1';
const engine = new EmbeddedWhistle(profile, worker);

function request(port: number, path: string) {
  return new Promise<{status?: number; body: string}>((res, rej) => {
    const req = get({host: loopback, port, path, agent: false}, response => {
      response.setEncoding('utf8');
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('error', rej);
      response.on('end', () => res({status: response.statusCode, body}));
    });
    req.setTimeout(5000, () => req.destroy(new Error('Local request timed out')));
    req.on('error', rej);
  });
}

async function run() {
  await assert.rejects(engine.endpoint(builtin));
  await Promise.all([engine.start(builtin), engine.start(builtin)]);
  const {port, host} = await engine.endpoint(builtin);
  assert.equal(host, loopback);
  assert.ok(port > 0);

  const {api} = await engine.resolve(builtin);
  assert.deepEqual(await api.network.getStatus(), {version: '2.10.15', port});
  assert.equal(await api.isEnabledHTTPS(), true);
  const rules = await api.rules.getStatus();
  assert.equal(rules.multiSelect, true);
  assert.equal(rules.disabled, false);
  await api.rules.setMultiSelect(false);
  assert.equal((await api.rules.getStatus()).multiSelect, false);
  await api.rules.setMultiSelect(true);
  await api.rules.turnOn();
  assert.equal((await request(port, '/cgi-bin/rules/status')).status, 401);

  const name = 'embedded-smoke';
  const value = 'http://embedded-smoke.invalid/ping statusCode://200 resBody://(embedded-smoke-ok)';
  await api.rules.add(name, value, false);
  assert.deepEqual(await api.rules.get(name), {value, selected: false});
  assert.equal(await api.rules.select(name), true);
  assert.equal(await api.rules.unselect(name), true);
  assert.deepEqual(await api.rules.get(name), {value, selected: false});
  assert.equal(await api.rules.select(name), true);
  assert.deepEqual(await request(port, 'http://embedded-smoke.invalid/ping'), {
    status: 200, body: 'embedded-smoke-ok',
  });

  const pem = await engine.certificate();
  const ca = new X509Certificate(pem);
  assert.equal(ca.ca, true);
  assert.equal(pem.toString().includes('PRIVATE KEY'), false);

  await engine.stop();
  await assert.rejects(request(port, '/cgi-bin/status'), {code: 'ECONNREFUSED'});
  await assert.rejects(api.network.getStatus());
  const thief = createServer((_, res) => res.end('different service'));
  await new Promise<void>((done, reject) => {
    thief.once('error', reject);
    thief.listen(port, loopback, done);
  });
  try {
    await assert.rejects(engine.start(builtin), /EADDRINUSE/);
    await assert.rejects(engine.endpoint(builtin), /EADDRINUSE/);
    assert.equal((await request(port, '/')).body, 'different service');
  } finally {
    await new Promise<void>((done, reject) => thief.close(error => error ? reject(error) : done()));
  }

  await engine.start(builtin);
  assert.deepEqual(await engine.endpoint(builtin), {host, port});
  assert.deepEqual(await (await engine.resolve(builtin)).api.rules.get(name), {value, selected: true});
  assert.equal(new X509Certificate(await engine.certificate()).fingerprint256, ca.fingerprint256);

  // The rule is selected on disk. Delay the next unselect's primary and backup
  // writes beyond the old worker and parent shutdown timers.
  const storage = join(profile, 'proxy-engine');
  const properties = join(storage, '.whistle', 'rules');
  const diskSelection = async (directory: string) =>
    (JSON.parse(await readFile(join(directory, 'properties'), 'utf8')) as {selectedList: string[]}).selectedList;
  assert.ok((await diskSelection(properties)).includes(name));
  const fault = (kind: string, delay: number, fail = false) =>
    writeFile(join(storage, kind + '-fault'), JSON.stringify({delay, fail}));
  await fault('primary', 2200);
  await fault('backup', 350);
  const current = (await engine.resolve(builtin)).api;
  assert.equal(await current.rules.unselect(name), true);
  assert.deepEqual(await current.rules.get(name), {value, selected: false});
  await engine.stop();
  assert.ok(!(await diskSelection(properties)).includes(name), 'stop must wait for the primary selection write');
  assert.ok(!(await diskSelection(join(properties, '.backup'))).includes(name), 'stop must wait for the backup selection write');
  await engine.start(builtin);
  assert.deepEqual(await (await engine.resolve(builtin)).api.rules.get(name), {value, selected: false});

  for (const kind of ['primary', 'backup']) {
    const current = (await engine.resolve(builtin)).api;
    await fault(kind, 400, true);
    assert.equal(await current.rules.select(name), true);
    await assert.rejects(engine.stop(), new RegExp('fixture ' + kind + ' failure'));
    assert.deepEqual(await engine.endpoint(builtin), {host, port}, 'stop failure must leave the listener available');
    assert.deepEqual(await current.rules.get(name), {value, selected: true});
    assert.equal(await current.rules.unselect(name), true);
    await engine.stop();
    await engine.start(builtin);
    assert.deepEqual(await (await engine.resolve(builtin)).api.rules.get(name), {value, selected: false});
  }

  // A flush that exceeds the worker's limit must reject without force-killing
  // the listener. The pending write can complete, and a queued unselect must
  // supersede the older selection before a second stop succeeds.
  const latest = (await engine.resolve(builtin)).api;
  await fault('primary', 10_500);
  assert.equal(await latest.rules.select(name), true);
  assert.equal(await latest.rules.unselect(name), true);
  await assert.rejects(engine.stop(), /超时/);
  assert.deepEqual(await engine.endpoint(builtin), {host, port});
  assert.deepEqual(await latest.rules.get(name), {value, selected: false});
  await engine.stop();
  assert.ok(!(await diskSelection(properties)).includes(name));
  assert.ok(!(await diskSelection(join(properties, '.backup'))).includes(name));
  await engine.start(builtin);
  assert.deepEqual(await (await engine.resolve(builtin)).api.rules.get(name), {value, selected: false});

}

app.whenReady().then(async () => {
  let code = 0;
  try {
    if (process.argv[3] === 'parent-exit') {
      await engine.start(builtin);
      const {port} = await engine.endpoint(builtin);
      console.log(`READY ${port}`);
      await new Promise(() => {});
    } else {
      await run();
      console.log('Embedded engine smoke test passed');
    }
  } catch (error) {
    console.error(error);
    code = 1;
  } finally {
    await engine.stop();
    app.exit(code);
  }
});
