import { createRequire } from 'node:module';
import { appPath, parseTarget, run, verifyPackagedApp } from './package-support.mjs';

const target = parseTarget();
const require = createRequire(import.meta.url);
// electron-builder downloads the selected Electron architecture. Never set
// electronDist to node_modules/electron/dist: that is the host's runtime.
if (target.platform === 'darwin') run(process.execPath, ['scripts/build-native.mjs', '--arch', target.arch]);
run(process.execPath, [
  require.resolve('electron-builder/cli.js'),
  target.platform === 'darwin' ? '--mac' : '--win', 'dir', `--${target.arch}`, '--publish', 'never',
], { env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' } });
const bundle = appPath(target);
await verifyPackagedApp(bundle, target);
if (target.platform === 'darwin') run(process.execPath, ['scripts/sign-local.mjs', '--arch', target.arch]);
console.log(`Verified ${target.label} package: ${bundle}`);
