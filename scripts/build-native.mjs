import { mkdir, rename, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { assertBinaryArchitecture, parseTarget, projectRoot } from './package-support.mjs';

if (process.platform === 'darwin') {
  const target = parseTarget();
  const root = projectRoot;
  const output = join(root, 'dist-native');
  const cache = join(root, 'test-results', 'native-swift-module-cache');
  await Promise.all([mkdir(output, { recursive: true }), mkdir(cache, { recursive: true })]);
  const binary = join(output, 'system-proxy');
  const temporary = join(output, '.system-proxy-' + process.pid);
  try {
    const result = spawnSync('/usr/bin/xcrun', [
      'swiftc', '-target', target.swiftTarget, '-parse-as-library', '-O', '-module-cache-path', cache,
      join(root, 'src', 'native', 'system-proxy.swift'), '-o', temporary,
    ], { stdio: 'inherit' });
    if (result.error || result.status !== 0) throw new Error('Could not compile the macOS SystemConfiguration helper.');
    await assertBinaryArchitecture(temporary, target);
    await rename(temporary, binary);
    console.log(`Built macOS system proxy helper for ${target.arch}.`);
  } finally {
    await rm(temporary, { force: true });
  }
}
