// Run the real worker in an isolated Node child without launching Electron.
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const { basename, dirname, join } = require('node:path');
const fs = require('node:fs');
const childProcess = require('node:child_process');
const workerPath = process.argv[2];
const workerRequire = createRequire(workerPath);

// Make the real background service available on every OS. Without this,
// POSIX's empty PATH can hide the detached-process leak that Windows exposes.
process.env.PFORK_EXEC_PATH = process.execPath;
const servicePath = workerRequire.resolve('whistle/lib/service/service');
const spawn = childProcess.spawn;
childProcess.spawn = function (file, args, options) {
  const child = spawn.call(this, file, args, options);
  let script;
  try { script = JSON.parse(decodeURIComponent(args.at(-1))).script; } catch {}
  if (script === servicePath && child.pid) {
    // Record only the PID; arguments include private engine credentials.
    fs.appendFileSync(join(process.env.WHISTLE_PATH, 'test-service-pids'), child.pid + '\n');
  }
  return child;
};

process.parentPort = new EventEmitter();
process.parentPort.postMessage = message => process.send(message);
process.on('message', data => {
  if (data.type === 'test-parent-close') process.parentPort.emit('close');
  else process.parentPort.emit('message', { data });
});
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
