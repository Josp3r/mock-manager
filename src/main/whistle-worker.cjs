const { createServer } = require('node:http');
const { once } = require('node:events');
const { isAbsolute } = require('node:path');

const parent = process.parentPort;
const server = createServer();

parent.on('message', ({ data }) => {
  if (data.type !== 'stop') return;
  server.close();
  server.closeAllConnections();
  // Whistle persists rule changes asynchronously after returning HTTP responses.
  setTimeout(() => process.exit(0), 250);
});
parent.once('close', () => process.exit(0));

async function start({ port, authKey, username, password }) {
  if (!isAbsolute(process.env.WHISTLE_PATH || '')) throw new Error('内置 Whistle 缺少独立配置目录。');
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
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
    parent.postMessage({ type: 'error', error: error.message });
  });
});
