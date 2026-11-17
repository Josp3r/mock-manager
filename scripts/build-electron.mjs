import { copyFile } from 'node:fs/promises';
import { build } from 'esbuild';

await build({entryPoints:['src/main/main.ts','src/main/preload.ts'], outdir:'dist-electron', outExtension:{'.js':'.cjs'}, bundle:true, platform:'node', format:'cjs', target:'node22', external:['electron'], sourcemap:true});
// Keep Whistle's module paths and dynamically loaded UI/CGI assets intact.
await copyFile('src/main/whistle-worker.cjs', 'dist-electron/whistle-worker.cjs');
