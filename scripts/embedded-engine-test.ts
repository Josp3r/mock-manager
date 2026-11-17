import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { createServer, get } from 'node:http';
import { join } from 'node:path';
import { app } from 'electron';
import { EmbeddedWhistle } from '../src/main/embedded-whistle';

const profile = process.argv[2];
app.setPath('userData', profile);
const worker = join(__dirname, 'whistle-worker.cjs');
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
