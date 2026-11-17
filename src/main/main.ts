import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import { readFile, writeFile, stat, mkdir } from 'node:fs/promises';
import { join, resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { AppData } from '../shared/types';
import { DataStore, MAX_DATA_BYTES } from './store';
import { EmbeddedWhistle } from './embedded-whistle';
import { shutdownEngine } from './engine-shutdown';
import { testProxyConnection } from './proxy-self-test';
import { SyncController } from './sync';
import { SystemProxyController } from './system-proxy';
import { NativeSystemProxy } from './native-system-proxy';

app.setName('Whistle Mock Manager');
const dataOverride = process.env.MOCK_MANAGER_DATA_DIR;
if (!app.isPackaged && dataOverride && isAbsolute(dataOverride)) app.setPath('userData', dataOverride);
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
let window: BrowserWindow | null = null;
const dataRoot = app.getPath('userData');
const engine = new EmbeddedWhistle(dataRoot, join(__dirname, 'whistle-worker.cjs'));
const controller = new SyncController(new DataStore(dataRoot), engine);
let shutdownInProgress = false;
const proxyHelperOverride = !app.isPackaged ? process.env.MOCK_MANAGER_PROXY_HELPER : undefined;
const proxyHelper = proxyHelperOverride && isAbsolute(proxyHelperOverride) ? proxyHelperOverride
  : app.isPackaged ? join(process.resourcesPath, 'system-proxy') : join(__dirname, '../dist-native/system-proxy');
const systemProxy = new SystemProxyController(dataRoot, new NativeSystemProxy(proxyHelper));
const devUrl = !app.isPackaged ? process.env.MOCK_MANAGER_DEV_URL : undefined;
const rendererPath = join(__dirname, '../dist/index.html');
const trustedUrl = devUrl ? new URL(devUrl).href : pathToFileURL(rendererPath).href;

function handle(channel: string, fn: (...args: any[]) => Promise<unknown>) {
  ipcMain.handle(`manager:${channel}`, async (event, ...args) => {
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url.split('#')[0] !== trustedUrl) {
      throw new Error('拒绝未知窗口的请求。');
    }
    if (shutdownInProgress) throw new Error('正在恢复系统代理并退出，请稍候。');
    return fn(...args);
  });
}
async function readSelectedJson(): Promise<string | null> {
  const {canceled, filePaths} = await dialog.showOpenDialog(window!, {properties:['openFile'], filters:[{name:'JSON 文件',extensions:['json']}]});
  if (canceled || !filePaths[0]) return null;
  if ((await stat(filePaths[0])).size > MAX_DATA_BYTES) throw new Error('文件超过 32 MiB，请先精简响应或拆分备份。');
  const text = await readFile(filePaths[0], 'utf8'); JSON.parse(text); return text;
}
function setupIpc() {
  handle('load', () => controller.load());
  handle('save', (data: AppData) => controller.saveDraft(data));
  handle('status', () => controller.status());
  handle('apply', () => controller.apply());
  handle('disable', () => controller.disable());
  handle('restore', () => controller.restore());
  handle('startWhistle', () => controller.startWhistle());
  handle('enableMultiSelect', () => controller.enableMultiSelect());
  handle('enableRules', () => controller.enableRules());
  handle('systemProxyStatus', () => systemProxy.status());
  handle('setSystemProxy', async (enabled: unknown) => {
    if (typeof enabled !== 'boolean') throw new Error('系统代理参数无效。');
    if (!enabled) return systemProxy.disable();
    const status = await controller.status();
    if (!status.running || !status.address || !status.port) throw new Error('请先启动并连接 Whistle，再开启系统代理。');
    const host = new URL(`http://${status.address}/`).hostname.replace(/^\[|\]$/g, '');
    return systemProxy.enable({ host, port: status.port });
  });
  handle('releaseSystemProxy', () => systemProxy.release());
  handle('testConnection', async () => {
    const status = await controller.status();
    if (!status.running || !status.host || !status.port) throw new Error('请先启动内置 Whistle。');
    return testProxyConnection(status.host, status.port);
  });
  handle('exportCertificate', async () => {
    const certificate = await engine.certificate();
    const {canceled, filePath} = await dialog.showSaveDialog(window!, {
      title: '导出内置 Whistle 根证书', defaultPath: 'Mock-Manager-Root-CA.crt',
      filters: [{name: '公开证书', extensions: ['crt']}],
    });
    if (canceled || !filePath) return false;
    await writeFile(filePath, certificate, {mode: 0o600});
    return true;
  });
  handle('importResponse', () => readSelectedJson());
  handle('importBackup', async () => {
    const text = await readSelectedJson(); return text === null ? null : controller.importBackup(JSON.parse(text));
  });
  handle('exportBackup', async () => {
    const {canceled,filePath} = await dialog.showSaveDialog(window!, {defaultPath:`mock-backup-${new Date().toISOString().slice(0,10)}.json`,filters:[{name:'JSON',extensions:['json']}]});
    if (canceled || !filePath) return false;
    const backup = await controller.exportBackup();
    let content = JSON.stringify(backup,null,2);
    if (Buffer.byteLength(content)>MAX_DATA_BYTES) content=JSON.stringify(backup);
    if (Buffer.byteLength(content)>MAX_DATA_BYTES) throw new Error('备份超过 32 MiB，请先拆分项目。');
    await writeFile(filePath, content, {encoding:'utf8',mode:0o600}); return true;
  });
  handle('openDataFolder', async () => { await mkdir(dataRoot,{recursive:true}); const error = await shell.openPath(dataRoot); if (error) throw new Error(error); });
}
function createWindow() {
  window = new BrowserWindow({
    width:1440, height:940, minWidth:1080, minHeight:720,
    title:'Whistle Mock Manager', titleBarStyle:'hiddenInset', trafficLightPosition:{x:20,y:20},
    backgroundColor:'#f6f5f1', show:false,
    webPreferences:{preload:join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true}
  });
  window.webContents.setWindowOpenHandler(() => ({action:'deny'}));
  window.webContents.on('will-navigate', (event, url) => { if (url !== trustedUrl) event.preventDefault(); });
  window.webContents.session.setPermissionRequestHandler((_wc,_permission,callback) => callback(false));
  window.once('ready-to-show', () => window?.show());
  window.on('closed', () => { window = null; });
  if (devUrl) void window.loadURL(devUrl); else void window.loadFile(rendererPath);
}
function prepareRendererQuit(): Promise<void> {
  const target = window;
  if (!target || target.isDestroyed()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      ipcMain.removeListener('manager:preparedQuit', receive);
      target.removeListener('closed', closed);
      error ? reject(error) : resolve();
    };
    const closed = () => finish();
    const receive = (event: Electron.IpcMainEvent, result: unknown) => {
      if (event.sender !== target.webContents || event.senderFrame !== target.webContents.mainFrame
          || event.senderFrame.url.split('#')[0] !== trustedUrl || !result || typeof result !== 'object') return;
      const reply = result as {id?: unknown; ok?: unknown; error?: unknown};
      if (reply.id !== id) return;
      finish(reply.ok === true ? undefined : new Error(typeof reply.error === 'string' ? reply.error.slice(0, 2000) : '草稿保存未完成。'));
    };
    const timeout = setTimeout(() => finish(new Error('等待草稿保存超时，请稍后重试退出。')), 15_000);
    ipcMain.on('manager:preparedQuit', receive);
    target.once('closed', closed);
    target.webContents.send('manager:prepareQuit', id);
  });
}
if (gotLock) {
  let quitPermitted = false;
  let preparingQuit = false;
  app.on('before-quit', event => {
    if (quitPermitted) return;
    event.preventDefault();
    if (preparingQuit) return;
    preparingQuit = true;
    void (async () => {
      try {
        await prepareRendererQuit();
        shutdownInProgress = true;
        await controller.load(); // Drain pending rule writes before stopping their engine.
        await shutdownEngine(systemProxy, engine);
        quitPermitted = true;
        app.quit();
      } catch (error) {
        shutdownInProgress = false;
        preparingQuit = false;
        if (!window) createWindow();
        window?.show();
        await dialog.showMessageBox(window!, {type: 'error', title: '暂时无法退出',
          message: '应用与内置代理将保持运行',
          detail: (error instanceof Error ? error.message : String(error)) + '\n请在连接设置中处理后再退出。', buttons: ['返回应用']});
      }
    })();
  });
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
  void app.whenReady().then(() => {
    setupIpc();
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      {label:app.name, submenu:[{role:'about'},{type:'separator'},{role:'hide'},{role:'hideOthers'},{role:'unhide'},{type:'separator'},{role:'quit'}]},
      {label:'编辑', submenu:[{role:'undo'},{role:'redo'},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},
      {label:'窗口', submenu:[{role:'minimize'},{role:'zoom'},{role:'front'}]},
      {label:'帮助', submenu:[{label:'Whistle HTTPS 配置', click:() => { void shell.openExternal('https://wproxy.org/docs/gui/https.html'); }}]}
    ]));
    void controller.startWhistle().catch(() => { /* Connection status exposes startup errors with retry. */ });
    createWindow();
    app.on('activate', () => { if (!window) createWindow(); });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
