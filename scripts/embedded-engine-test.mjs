import electron from 'electron';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { get } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { build } from 'esbuild';

const profile = await mkdtemp(join(tmpdir(), 'embedded-whistle-test-'));
const testEntry = resolve('dist-electron/embedded-engine-test.cjs');
const env = { ...process.env, PATH: join(profile, 'empty-path') };
delete env.ELECTRON_RUN_AS_NODE;

async function assertWorkerExitsWithParent() {
  const child = spawn(electron, [testEntry, profile, 'parent-exit'], {stdio: ['ignore', 'pipe', 'inherit'], env});
  const exited = once(child, 'exit');
  const timeout = setTimeout(() => child.kill('SIGKILL'), 20_000);
  try {
    let output = '';
    const port = await Promise.race([
      exited.then(([status, signal]) => { throw new Error(`Electron exited before worker readiness (${status ?? signal}).`); }),
      new Promise(resolveReady => child.stdout.on('data', chunk => {
        output += chunk;
        const match = /^READY (\d+)$/m.exec(output);
        if (match) resolveReady(Number(match[1]));
      })),
    ]);
    const available = () => new Promise((resolveAvailable, reject) => {
      const req = get({hostname: '127.0.0.1', port, path: '/cgi-bin/status', agent: false}, response => {
        response.resume();
        resolveAvailable(response.statusCode === 200);
      });
      req.setTimeout(1000, () => req.destroy(new Error('Port probe timed out')));
      req.on('error', error => error.code === 'ECONNREFUSED' ? resolveAvailable(false) : reject(error));
    });
    assert.equal(await available(), true);
    child.kill('SIGKILL');
    await exited;
    for (let attempt = 0; attempt < 25; attempt++) {
      if (!await available()) return;
      await delay(100);
    }
    throw new Error('Bundled Whistle survived its Electron parent.');
  } finally {
    clearTimeout(timeout);
    child.kill('SIGKILL');
    await exited;
  }
}
try {
  await build({
    entryPoints: ['scripts/embedded-engine-test.ts'],
    outfile: testEntry,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
  });
  const child = spawn(electron, [testEntry, profile], {
    stdio: 'inherit',
    env,
  });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 45_000);
  try {
    const result = await new Promise((resolveExit, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolveExit(code ?? signal));
    });
    if (result !== 0) throw new Error(`Embedded engine smoke test exited with ${result}.`);
  } finally {
    clearTimeout(timeout);
  }
  await assertWorkerExitsWithParent();
  console.log('Embedded worker exited with its Electron parent');
} finally {
  await rm(testEntry, { force: true });
  await rm(profile, { recursive: true, force: true });
}
