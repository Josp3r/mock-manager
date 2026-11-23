import { execFileSync } from 'node:child_process';
import { appPath, parseTarget, verifyPackagedApp } from './package-support.mjs';
if (process.platform !== 'darwin') throw new Error('Local macOS signing requires macOS.');
const target = parseTarget();
const bundle = appPath(target);
await verifyPackagedApp(bundle, target);
execFileSync('codesign',['--force','--sign','-',`${bundle}/Contents/Resources/system-proxy`],{stdio:'inherit'});
// Local ad-hoc signing uses no Apple account or keychain identity. It repairs
// Electron's resource seal after the app and its icon have been packaged.
execFileSync('codesign',['--force','--deep','--sign','-',bundle],{stdio:'inherit'});
execFileSync('codesign',['--verify','--deep','--strict',bundle],{stdio:'inherit'});
console.log(`Local ${target.arch} ad-hoc signature verified. This is not an Apple-notarized build.`);
