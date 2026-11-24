import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { utilityProcess } from 'electron';
import { BUILTIN_WHISTLE, EmbeddedWhistle } from '../src/main/embedded-whistle';

vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }));

let root: string;
const spawnBoundary = new Error('Stopped at the real utility-process launch boundary');

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mock-manager-worker-env-'));
  vi.mocked(utilityProcess.fork).mockReset().mockImplementation(() => { throw spawnBoundary; });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});

async function launchEnvironment(platform: NodeJS.Platform, env: NodeJS.ProcessEnv) {
  vi.stubGlobal('process', Object.create(process, {
    platform: { value: platform },
    env: { value: env },
  }));
  const engine = new EmbeddedWhistle(root, 'worker.cjs');
  await expect(engine.start(BUILTIN_WHISTLE)).rejects.toBe(spawnBoundary);
  return vi.mocked(utilityProcess.fork).mock.calls[0][2]?.env;
}

describe('bundled worker environment', () => {
  it.each(['SystemRoot', 'SYSTEMROOT', 'systemroot'])('preserves Windows %s for socket initialization without inheriting runtime settings', async (key) => {
    const env = await launchEnvironment('win32', {
      [key]: 'D:\\Windows Test',
      PATH: 'untrusted-executables',
      NODE_OPTIONS: '--require=external-hook.cjs',
      ELECTRON_RUN_AS_NODE: '1',
      WHISTLE_PATH: 'external-whistle-profile',
      PFORK_EXEC_PATH: 'external-node',
      USERPROFILE: 'external-profile',
    });
    expect(env).toEqual({ WHISTLE_PATH: join(root, 'proxy-engine'), SystemRoot: 'D:\\Windows Test' });
  });

  it.each(['darwin', 'linux'] as const)('keeps the %s worker environment isolated', async (platform) => {
    expect(await launchEnvironment(platform, { SystemRoot: 'D:\\Windows', HOME: '/external-profile' }))
      .toEqual({ WHISTLE_PATH: join(root, 'proxy-engine') });
  });

  it('does not invent a Windows installation path if SystemRoot is absent', async () => {
    expect(await launchEnvironment('win32', { PATH: 'external-path' }))
      .toEqual({ WHISTLE_PATH: join(root, 'proxy-engine') });
  });
});
