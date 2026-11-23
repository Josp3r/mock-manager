// Run the real worker in an isolated Node child without launching Electron.
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const { basename, dirname, join } = require('node:path');
const fs = require('node:fs');
const workerPath = process.argv[2];
const workerRequire = createRequire(workerPath);

process.parentPort = new EventEmitter();
process.parentPort.postMessage = message => process.send(message);
process.on('message', data => process.parentPort.emit('message', { data }));
process.on('disconnect', () => process.parentPort.emit('close'));

if (process.env.MM_TEST_START_FAULT === 'missing-root') delete process.env.WHISTLE_PATH;
if (process.env.MM_TEST_START_FAULT === 'storage-version') workerRequire('whistle/package.json').version = 'incompatible';

const storageRequire = createRequire(workerRequire.resolve('whistle/lib/rules/storage'));
const fse = storageRequire('fs-extra2');
const outputJson = fse.outputJson;
fse.outputJson = function (path, ...args) {
  const marker = join(process.env.WHISTLE_PATH || '', 'test-write-fault.json');
  if (basename(path) !== 'properties' || basename(dirname(path)) !== 'rules' || !fs.existsSync(marker)) {
    return outputJson(path, ...args);
  }
  const fault = JSON.parse(fs.readFileSync(marker, 'utf8'));
  fs.unlinkSync(marker);
  setTimeout(() => {
    if (fault.error) args.at(-1)(new Error(fault.error));
    else outputJson(path, ...args);
  }, fault.delay);
};

require(workerPath);
