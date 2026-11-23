import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openRegularFile, syncDirectory, UnsafeFileError } from '../src/main/filesystem';

vi.mock('node:fs/promises', async (original) => ({ ...await original<typeof fs>() }));
const roots: string[] = [];
const hostPlatform = process.platform;

async function temporary() {
  const root = await fs.mkdtemp(join(tmpdir(), 'mock-files-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('portable durable files', () => {
  it('reads regular files and rejects directories without blocking', async () => {
    const root = await temporary();
    const path = join(root, 'content.json');
    await fs.writeFile(path, 'original');
    const file = await openRegularFile(path);
    try { expect(await file.readFile('utf8')).toBe('original'); }
    finally { await file.close(); }
    await expect(openRegularFile(root)).rejects.toBeInstanceOf(UnsafeFileError);
  });

  it.skipIf(hostPlatform === 'win32')('does not follow a symbolic link to a valid file', async () => {
    const root = await temporary();
    await fs.writeFile(join(root, 'target'), 'must not be read');
    const path = join(root, 'link');
    await fs.symlink(join(root, 'target'), path);
    await expect(openRegularFile(path)).rejects.toBeInstanceOf(UnsafeFileError);
  });

  it('rejects directory junctions or symlinks on every supported OS', async () => {
    const root = await temporary();
    const target = join(root, 'target');
    await fs.mkdir(target);
    const path = join(root, 'junction');
    await fs.symlink(target, path, 'junction');
    await expect(openRegularFile(path)).rejects.toBeInstanceOf(UnsafeFileError);
  });

  it('keeps missing and invalid Windows directory errors visible', async () => {
    const root = await temporary();
    const file = join(root, 'file');
    await fs.writeFile(file, 'content');
    vi.stubGlobal('process', Object.create(process, { platform: { value: 'win32' } }));
    await expect(syncDirectory(root)).resolves.toBeUndefined();
    await expect(syncDirectory(join(root, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(syncDirectory(file)).rejects.toMatchObject({ code: 'ENOTDIR' });
  });

  it.each(['EIO', 'EACCES'])('does not hide a Windows directory %s error', async (code) => {
    vi.stubGlobal('process', Object.create(process, { platform: { value: 'win32' } }));
    const error = Object.assign(new Error('filesystem failure'), { code });
    vi.spyOn(fs, 'lstat').mockRejectedValue(error);
    await expect(syncDirectory('unreadable')).rejects.toBe(error);
  });

  it.skipIf(hostPlatform === 'win32').each(['EINVAL', 'ENOTSUP', 'EIO', 'EACCES'])('only tolerates unsupported POSIX directory fsync, including %s', async (code) => {
    const root = await temporary();
    const realOpen = fs.open;
    const error = Object.assign(new Error('directory sync failure'), { code });
    let descriptor: fs.FileHandle | undefined;
    vi.spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
      const file = await realOpen(path, flags, mode);
      descriptor = file;
      vi.spyOn(file, 'sync').mockRejectedValue(error);
      return file;
    });
    if (code === 'EINVAL' || code === 'ENOTSUP') await expect(syncDirectory(root)).resolves.toBeUndefined();
    else await expect(syncDirectory(root)).rejects.toBe(error);
    expect(descriptor?.fd).toBe(-1);
  });
});
