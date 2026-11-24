import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, join } from 'node:path';
import { appPath, parseTarget, projectRoot, run, verifyPackagedApp } from './package-support.mjs';

const target = parseTarget();
const bundle = appPath(target);
await verifyPackagedApp(bundle, target);
const metadata = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'));
const output = join(projectRoot, 'release');
const stem = `Mock-Manager-${metadata.version}-${target.label}`;
const zip = join(output, `${stem}.zip`);
await mkdir(output, { recursive: true });
await rm(zip, { force: true });
const artifacts = [];

if (target.platform === 'darwin') {
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
  // ditto retains the signed bundle's symlinks, modes and resource metadata.
  run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', bundle, zip]);
} else {
  const require = createRequire(import.meta.url);
  // Use precisely the unpacked app that passed the smoke test; do not rebuild it.
  run(process.execPath, [
    require.resolve('electron-builder/cli.js'), '--win', 'nsis', '--x64',
    '--prepackaged', bundle, '--publish', 'never',
  ], { env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' } });
  artifacts.push(join(output, `${stem}-setup.exe`));
  // Use Windows' bsdtar explicitly: Git Bash also ships tar.exe, whose GNU
  // implementation treats an absolute D: output path as a remote destination.
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (!systemRoot) throw new Error('SystemRoot is required to locate the Windows archive tool.');
  run(join(systemRoot, 'System32', 'tar.exe'), ['-a', '-c', '-f', zip, '-C', bundle, '.']);
}
artifacts.push(zip);

const sums = [];
for (const artifact of artifacts) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(artifact)) hash.update(chunk);
  sums.push(`${hash.digest('hex')}  ${basename(artifact)}`);
}
await writeFile(join(output, `SHA256SUMS-${target.label}.txt`), `${sums.join('\n')}\n`);
console.log(sums.join('\n'));
