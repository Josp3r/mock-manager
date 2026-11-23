const { createServer } = require('node:http');
const { once } = require('node:events');
const { isAbsolute } = require('node:path');

const parent = process.parentPort;
const server = createServer();

let flushStorage;
let stopRequest;

parent.on('message', ({ data }) => {
  if (data.type === 'stop') {
    const request = { id: data.id, ready: false };
    stopRequest = request;
    void flushStorage().then(() => {
      if (stopRequest !== request) return;
      request.ready = true;
      parent.postMessage({ type: 'stop-ready', id: request.id });
    }, error => {
      if (stopRequest !== request) return;
      parent.postMessage({ type: 'stop-error', id: request.id, errorCode: error.code, error: error.message });
    });
  } else if (data.type === 'exit' && stopRequest?.ready && stopRequest.id === data.id) {
    server.close();
    server.closeAllConnections();
    process.exit(0);
  }
});
parent.once('close', () => process.exit(0));

async function start({ port, authKey, username, password }) {
  if (!isAbsolute(process.env.WHISTLE_PATH || '')) {
    throw Object.assign(new Error('The bundled proxy engine is missing its isolated configuration directory.'), { code: 'MM_CONFIG_DIRECTORY' });
  }
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  flushStorage = require('./whistle-storage.cjs')();
  const whistle = require('whistle');
  await new Promise(resolve => whistle({
    server,
    storage: false,
    rcPath: 'none',
    noGlobalPlugins: true,
    disableAllPlugins: true,
    allowMultipleChoice: port ? undefined : true,
    mode: 'disableCustomCerts|disableUpdateTips' + (port ? '' : '|enableCapture|persistentCapture'),
    authKey,
    username,
    password,
  }, resolve));
  parent.postMessage({ type: 'ready', port: server.address().port });
}

parent.once('message', ({ data }) => {
  start(data).catch(error => {
    parent.postMessage({ type: 'error', errorCode: error.code, error: error.message });
  });
});
