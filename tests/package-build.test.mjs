import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertBinaryArchitecture, parseTarget, verifyPackagedApp } from '../scripts/package-support.mjs';

const directories = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

function macho(cpu) {
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(cpu, 4);
  return bytes;
}
function pe(machine) {
  const bytes = Buffer.alloc(256);
  bytes.write('MZ', 0);
  bytes.writeUInt32LE(128, 60);
  bytes.write('PE\0\0', 128);
  bytes.writeUInt16LE(machine, 132);
  return bytes;
}
async function temporary() {
  const path = await mkdtemp(join(tmpdir(), 'mock-manager-package-'));
  directories.push(path);
  return path;
}

describe('packaging architecture safeguards', () => {
  it('selects Intel Swift architecture when an arm64 host targets Intel', () => {
    expect(parseTarget(['--platform', 'darwin', '--arch', 'x64'], { platform: 'darwin', arch: 'arm64' }))
      .toMatchObject({ platform: 'darwin', arch: 'x64', swiftTarget: 'x86_64-apple-macosx13.0' });
  });
  it('refuses unsupported Windows architecture and cross-OS packaging', () => {
    expect(() => parseTarget(['--platform', 'win32', '--arch', 'arm64'], { platform: 'win32', arch: 'arm64' })).toThrow(/Unsupported/);
    expect(() => parseTarget(['--platform', 'win32', '--arch', 'x64'], { platform: 'darwin', arch: 'arm64' })).toThrow(/native/);
  });
  it('refuses unknown arguments rather than silently packaging the host architecture', () => {
    expect(() => parseTarget(['--arch', 'x86_64'], { platform: 'darwin', arch: 'arm64' })).toThrow(/Unsupported/);
    expect(() => parseTarget(['--arhc', 'x64'], { platform: 'darwin', arch: 'arm64' })).toThrow(/Unknown/);
  });
  it.each([
    ['darwin', 'arm64', macho(0x0100000c)],
    ['darwin', 'x64', macho(0x01000007)],
    ['win32', 'x64', pe(0x8664)],
  ])('accepts matching %s %s binary headers', async (platform, arch, bytes) => {
    const path = join(await temporary(), 'binary');
    await writeFile(path, bytes);
    await expect(assertBinaryArchitecture(path, { platform, arch })).resolves.toBeUndefined();
  });
  it.each([
    ['darwin', 'x64', macho(0x0100000c)],
    ['win32', 'x64', pe(0xaa64)],
    ['win32', 'x64', Buffer.from('not an executable')],
  ])('rejects a mismatched or invalid %s %s executable before distribution', async (platform, arch, bytes) => {
    const path = join(await temporary(), 'wrong-binary');
    await writeFile(path, bytes);
    await expect(assertBinaryArchitecture(path, { platform, arch })).rejects.toThrow(/architecture|executable/);
  });
  it('rejects an arm64 proxy helper inside an Intel app even when Electron is Intel', async () => {
    const bundle = join(await temporary(), 'Mock Manager.app');
    await mkdir(join(bundle, 'Contents', 'MacOS'), { recursive: true });
    await mkdir(join(bundle, 'Contents', 'Resources'), { recursive: true });
    await writeFile(join(bundle, 'Contents', 'MacOS', 'Mock Manager'), macho(0x01000007));
    await writeFile(join(bundle, 'Contents', 'Resources', 'system-proxy'), macho(0x0100000c));
    await expect(verifyPackagedApp(bundle, { platform: 'darwin', arch: 'x64' })).rejects.toThrow(/architecture/);
  });
});
