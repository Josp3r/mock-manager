import { access, open } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = fileURLToPath(new URL('..', import.meta.url));

export function parseTarget(args = process.argv.slice(2), host = process) {
  let platform = host.platform;
  let arch = process.env.TARGET_ARCH || host.arch;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--platform') platform = args[++index];
    else if (argument === '--arch') arch = args[++index];
    else if (argument !== '--dir') throw new Error(`Unknown packaging argument: ${argument}`);
  }
  if (!((platform === 'darwin' && ['arm64', 'x64'].includes(arch)) || (platform === 'win32' && arch === 'x64'))) {
    throw new Error(`Unsupported package target: ${platform}/${arch}`);
  }
  if (platform !== host.platform) throw new Error('Package on a native runner for the selected operating system.');
  return {
    platform,
    arch,
    swiftTarget: platform === 'darwin' ? `${arch === 'x64' ? 'x86_64' : 'arm64'}-apple-macosx13.0` : undefined,
    label: `${platform === 'darwin' ? 'mac' : 'win'}-${arch}`,
  };
}

export function appPath({ platform, arch }) {
  return platform === 'darwin'
    ? join(projectRoot, 'release', arch === 'arm64' ? 'mac-arm64' : 'mac', 'Mock Manager.app')
    : join(projectRoot, 'release', 'win-unpacked');
}

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: projectRoot, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status ?? result.signal}.`);
}

export async function assertBinaryArchitecture(path, { platform, arch }) {
  const file = await open(path, 'r');
  let bytes;
  try {
    const buffer = Buffer.alloc(4096);
    const result = await file.read(buffer, 0, buffer.length, 0);
    bytes = buffer.subarray(0, result.bytesRead);
  } finally {
    await file.close();
  }
  let actual;
  if (platform === 'darwin' && bytes.length >= 8 && bytes.readUInt32LE(0) === 0xfeedfacf) {
    const cpu = bytes.readUInt32LE(4);
    actual = cpu === 0x0100000c ? 'arm64' : cpu === 0x01000007 ? 'x64' : undefined;
  } else if (platform === 'win32' && bytes.length >= 64 && bytes.toString('ascii', 0, 2) === 'MZ') {
    const peOffset = bytes.readUInt32LE(60);
    if (peOffset + 6 <= bytes.length && bytes.toString('ascii', peOffset, peOffset + 4) === 'PE\0\0') {
      const machine = bytes.readUInt16LE(peOffset + 4);
      actual = machine === 0x8664 ? 'x64' : machine === 0xaa64 ? 'arm64' : machine === 0x014c ? 'ia32' : undefined;
    }
  }
  if (!actual) throw new Error(`Unrecognized ${platform} executable: ${path}`);
  if (actual !== arch) throw new Error(`Wrong binary architecture: expected ${arch}, found ${actual}: ${path}`);
}

export async function verifyPackagedApp(bundle, target) {
  const resources = target.platform === 'darwin' ? join(bundle, 'Contents', 'Resources') : join(bundle, 'resources');
  const executable = target.platform === 'darwin' ? join(bundle, 'Contents', 'MacOS', 'Mock Manager') : join(bundle, 'Mock Manager.exe');
  await assertBinaryArchitecture(executable, target);
  if (target.platform === 'darwin') {
    await assertBinaryArchitecture(join(resources, 'system-proxy'), target);
    await assertBinaryArchitecture(join(bundle, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Electron Framework'), target);
  } else {
    await access(join(resources, 'windows-system-proxy.ps1'));
  }
  for (const file of ['app.asar', 'THIRD-PARTY-NOTICES.txt', 'LICENSE.txt']) await access(join(resources, file));
  const unexpected = join(resources, target.platform === 'darwin' ? 'windows-system-proxy.ps1' : 'system-proxy');
  try { await access(unexpected); } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`Unexpected helper for another platform: ${unexpected}`);
}
