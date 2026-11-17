const fs = require('node:fs');
const { createRequire } = require('node:module');
const { promisify } = require('node:util');

const RETRY_INTERVAL = 16_000;
const FLUSH_TIMEOUT = 10_000;

module.exports = function trackStorage() {
  if (require('whistle/package.json').version !== '2.10.15') {
    throw new Error('内置 Whistle 版本与规则保存适配器不兼容。');
  }
  const storageModule = require.resolve('whistle/lib/rules/storage');
  const Storage = require(storageModule);
  const fse = createRequire(storageModule)('fs-extra2');
  const writeJson = promisify(fse.outputJson);
  const writeFile = promisify(fs.writeFile);
  const copyFile = promisify(fs.copyFile);
  const writes = new Map();

  function start(file, job) {
    clearTimeout(job.retry);
    job.error = undefined;
    const write = job.next;
    job.next = undefined;
    job.pending = write().then(() => {
      if (job.next) start(file, job);
      else writes.delete(file);
    }, error => {
      job.next ??= write;
      job.pending = undefined;
      job.error = error;
      job.retry = setTimeout(() => start(file, job), RETRY_INTERVAL);
      job.retry.unref();
    });
  }

  function queue(file, write) {
    let job = writes.get(file);
    if (!job) {
      job = {};
      writes.set(file, job);
    }
    job.next = write;
    if (!job.pending) start(file, job);
  }

  // Whistle 2.10.15's cache-driven property and file writers acknowledge the
  // management mutation first. Serialize the entire primary+backup pair for
  // each path so a newer primary cannot race an older backup.
  Storage.prototype._writeProperties = function () {
    if (this._disabled) return;
    queue(this._properties, async () => {
      const properties = JSON.parse(JSON.stringify(this._cache.properties));
      await writeJson(this._properties, properties);
      await copyFile(this._properties, this._backupProps);
    });
  };
  Storage.prototype._writeFile = function (name) {
    const file = this._cache.files[name];
    if (this._disabled || !file) return;
    const path = this._getFilePath(file);
    const backup = this._getFilePath(file, true);
    queue(path, async () => {
      if (this._cache.files[name] !== file) return;
      await writeFile(path, file.data);
      await copyFile(path, backup);
    });
  };

  async function drain() {
    while (writes.size) {
      const pending = [];
      for (const job of writes.values()) {
        if (job.error) throw job.error;
        pending.push(job.pending);
      }
      await Promise.all(pending);
    }
  }

  return async function flushStorage() {
    // A subsequent quit attempt can retry immediately after a failed save.
    for (const [file, job] of writes) {
      if (job.error) start(file, job);
    }
    let timeout;
    try {
      await Promise.race([
        drain(),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error('等待内置 Whistle 保存规则超时，请稍后重试退出。')), FLUSH_TIMEOUT);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  };
};
