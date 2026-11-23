import { constants, type Stats } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';

export class UnsafeFileError extends Error {}

function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

/** Reject links and path replacements even on Windows, which lacks O_NOFOLLOW. */
export async function openRegularFile(path: string): Promise<FileHandle> {
  const before = await lstat(path);
  if (!before.isFile()) throw new UnsafeFileError('Expected a regular file without a symbolic link');
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await file.stat();
    const after = await lstat(path);
    if (!opened.isFile() || !after.isFile() || !sameFile(before, opened) || !sameFile(opened, after)) {
      throw new UnsafeFileError('File changed while opening');
    }
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}

/** Sync directory entries where the OS supports directory handles. */
export async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') {
    // Node cannot open a directory for FlushFileBuffers on Windows. File data
    // is still fsynced before rename/link; validate the path without masking I/O.
    if (!(await lstat(path)).isDirectory()) {
      throw Object.assign(new Error('Expected a directory'), { code: 'ENOTDIR' });
    }
    return;
  }
  const directory = await open(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  try {
    await directory.sync();
  } catch (error) {
    // Only known filesystem limitations are tolerated, never permission/I/O errors.
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EINVAL' && code !== 'ENOTSUP') throw error;
  } finally {
    await directory.close();
  }
}
