// This wrapper runs only in an isolated integration-test utility process.
const fs = require('node:fs');
const { basename, dirname, join } = require('node:path');
const { createRequire } = require('node:module');
const requireStorageDependency = createRequire(require.resolve('whistle/lib/rules/storage'));
const fse = requireStorageDependency('fs-extra2');

function inject(method, kind) {
  return function (path, ...args) {
    const isRulesProperties = basename(path) === 'properties' && basename(dirname(path)) === 'rules';
    const marker = join(process.env.WHISTLE_PATH, kind + '-fault');
    if (!isRulesProperties || !fs.existsSync(marker)) return method(path, ...args);
    const fault = JSON.parse(fs.readFileSync(marker, 'utf8'));
    fs.unlinkSync(marker);
    setTimeout(() => {
      if (fault.fail) args.at(-1)(new Error('fixture ' + kind + ' failure'));
      else method(path, ...args);
    }, fault.delay);
  };
}

fse.outputJson = inject(fse.outputJson, 'primary');
fs.copyFile = inject(fs.copyFile, 'backup');
require('./whistle-worker.cjs');
