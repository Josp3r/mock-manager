import { copyFile } from 'node:fs/promises';
import { build } from 'esbuild';

await build({entryPoints:['src/main/main.ts','src/main/preload.ts'], outdir:'dist-electron', outExtension:{'.js':'.cjs'}, bundle:true, platform:'node', format:'cjs', target:'node22', external:['electron'], sourcemap:true});
// Keep Whistle's module paths and dynamically loaded UI/CGI assets intact.
for (const file of ['whistle-worker.cjs', 'whistle-storage.cjs']) {
  await copyFile('src/main/' + file, 'dist-electron/' + file);
}
