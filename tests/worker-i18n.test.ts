import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { utilityProcess } from 'electron';
import { EmbeddedWhistle, BUILTIN_WHISTLE } from '../src/main/embedded-whistle';
import { setLocale } from '../src/shared/i18n';

vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }));

let profile: string;
let startFault = '';
const children: { child: ChildProcess; closed: Promise<void> }[] = [];

async function servicePids(): Promise<number[]> {
  try {
    return (await readFile(join(profile, 'proxy-engine', 'test-service-pids'), 'utf8')).trim().split('\n').map(Number);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

beforeEach(async () => {
  setLocale('en');
  startFault = '';
  profile = await mkdtemp(join(tmpdir(), 'mock-manager-worker-i18n-'));
  vi.mocked(utilityProcess.fork).mockImplementation((modulePath, _args, options) => {
    const child = spawn(process.execPath, [resolve('tests/fixtures/node-whistle-worker.cjs'), modulePath], {
      cwd: options?.cwd,
      env: { ...options?.env, MM_TEST_START_FAULT: startFault },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    // Register immediately: stop() waits for exit, but Node's process/IPC
    // handles can close afterward, particularly on Windows.
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
    children.push({ child, closed });
    return Object.assign(child, { postMessage: (message: unknown) => child.send(message as object) }) as unknown as ReturnType<typeof utilityProcess.fork>;
  });
});

afterEach(async () => {
  setLocale('zh-CN');
  // Failed assertions must not leave the real detached service behind. The
  // lifecycle regression below checks its exit before this fallback runs.
  for (const pid of await servicePids()) {
    try { process.kill(pid); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  }
  await Promise.all(children.splice(0).map(async ({ child, closed }) => {
    const killed = child.exitCode === null && child.signalCode === null ? child.kill() : undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([closed, new Promise<void>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Worker handles did not close: ' + JSON.stringify({
          exitCode: child.exitCode, signalCode: child.signalCode, connected: child.connected, killed,
        }))), 3000);
      })]);
    } finally { clearTimeout(timeout); }
  }));
  // Windows may release the child's working-directory handle just after close.
  // Retry transient filesystem locks briefly; persistent failures still fail.
  await rm(profile, {
    recursive: true,
    force: true,
    maxRetries: process.platform === 'win32' ? 5 : 0,
    retryDelay: 100,
  });
});

const engine = () => new EmbeddedWhistle(profile, resolve('src/main/whistle-worker.cjs'));

describe('worker errors in the selected language', () => {
  it.each(['stop', 'parent-close'])('stops the real detached Whistle service on %s', async (method) => {
    const proxy = engine();
    await proxy.start(BUILTIN_WHISTLE);
    await expect.poll(async () => (await servicePids()).length).toBe(1);
    const [pid] = await servicePids();
    expect(processExists(pid)).toBe(true);
    if (method === 'stop') await proxy.stop();
    else children.at(-1)!.child.send({ type: 'test-parent-close' });
    await expect.poll(() => processExists(pid), { timeout: 2000 }).toBe(false);
  });

  it.each([
    ['missing-root', /isolated configuration directory/i],
    ['storage-version', /incompatible/i],
  ])('localizes app-owned startup error: %s', async (fault, expected) => {
    startFault = fault as string;
    const proxy = engine();
    await expect(proxy.start(BUILTIN_WHISTLE)).rejects.toThrow(expected);
    await expect(proxy.endpoint(BUILTIN_WHISTLE)).rejects.not.toThrow(/[\u3400-\u9fff]/);
  });

  it('localizes a real save timeout while keeping the engine alive for retry', async () => {
    const proxy = engine();
    await proxy.start(BUILTIN_WHISTLE);
    const endpoint = await proxy.endpoint(BUILTIN_WHISTLE);
    const { api } = await proxy.resolve(BUILTIN_WHISTLE);
    await api.rules.add('timeout-test', 'example.invalid statusCode://200', false);
    await writeFile(join(profile, 'proxy-engine', 'test-write-fault.json'), JSON.stringify({ delay: 10_500 }));
    await api.rules.select('timeout-test');
    await api.rules.unselect('timeout-test');
    await expect(proxy.stop()).rejects.toThrow(/timed out/i);
    expect(await proxy.endpoint(BUILTIN_WHISTLE)).toEqual(endpoint);
    await proxy.stop();
    const storage = join(profile, 'proxy-engine', '.whistle', 'rules');
    for (const directory of [storage, join(storage, '.backup')]) {
      expect(JSON.parse(await readFile(join(directory, 'properties'), 'utf8')).selectedList).not.toContain('timeout-test');
    }
  }, 20_000);

  it('preserves external save errors and allows another shutdown attempt', async () => {
    const proxy = engine();
    await proxy.start(BUILTIN_WHISTLE);
    const { api } = await proxy.resolve(BUILTIN_WHISTLE);
    await api.rules.add('failed-save', 'example.invalid statusCode://200', false);
    const detail = 'EACCES: 用户目录/响应.json';
    await writeFile(join(profile, 'proxy-engine', 'test-write-fault.json'), JSON.stringify({ delay: 100, error: detail }));
    await api.rules.select('failed-save');
    await expect(proxy.stop()).rejects.toThrow('The bundled proxy engine could not save rules: ' + detail);
    await proxy.stop();
  });
});
