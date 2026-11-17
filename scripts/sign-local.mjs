import { execFileSync } from 'node:child_process';
if(process.platform!=='darwin')throw new Error('Local macOS signing requires macOS.');
const bundle='release/mac-arm64/Whistle Mock Manager.app';
// Local ad-hoc signing uses no Apple account or keychain identity. It repairs
// Electron's resource seal after the app and its icon have been packaged.
execFileSync('codesign',['--force','--deep','--sign','-',bundle],{stdio:'inherit'});
execFileSync('codesign',['--verify','--deep','--strict',bundle],{stdio:'inherit'});
console.log('Local ad-hoc signature verified. This is not an Apple-notarized build.');
