import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import { readFile, writeFile, stat, mkdir } from 'node:fs/promises';
import { join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AppData } from '../shared/types';
import { DataStore, MAX_DATA_BYTES } from './store';
import { LocalWhistle } from './whistle';
import { SyncController } from './sync';

app.setName('Whistle Mock Manager');
const dataOverride = process.env.MOCK_MANAGER_DATA_DIR;
if (!app.isPackaged && dataOverride && isAbsolute(dataOverride)) app.setPath('userData', dataOverride);
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
let window: BrowserWindow | null = null;
const dataRoot = app.getPath('userData');
const controller = new SyncController(new DataStore(dataRoot), new LocalWhistle());
const devUrl = !app.isPackaged ? process.env.MOCK_MANAGER_DEV_URL : undefined;
const rendererPath = join(__dirname, '../dist/index.html');
const trustedUrl = devUrl ? new URL(devUrl).href : pathToFileURL(rendererPath).href;

function handle(channel: string, fn: (...args: any[]) => Promise<unknown>) {
  ipcMain.handle(`manager:${channel}`, async (event, ...args) => {
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url.split('#')[0] !== trustedUrl) {
      throw new Error('拒绝未知窗口的请求。');
    }
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
  handle('chooseW2', async () => {
    const {canceled, filePaths} = await dialog.showOpenDialog(window!, {title:'选择 w2 可执行文件', properties:['openFile','showHiddenFiles']});
    if (canceled || !filePaths[0]) return null;
    const path = filePaths[0]; await controller.access.resolve(path);
    await controller.updateW2Path(path); return path;
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
  handle('openWhistle', async () => {
    const status = await controller.status();
    if (!status.running) throw new Error('请先启动 Whistle。');
    if (!status.address) throw new Error('未能确认 Whistle 代理地址，请检查连接后重试。');
    await shell.openExternal(`http://${status.address}/`);
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
if (gotLock) {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
  void app.whenReady().then(() => {
    setupIpc();
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      {label:app.name, submenu:[{role:'about'},{type:'separator'},{role:'hide'},{role:'hideOthers'},{role:'unhide'},{type:'separator'},{role:'quit'}]},
      {label:'编辑', submenu:[{role:'undo'},{role:'redo'},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},
      {label:'窗口', submenu:[{role:'minimize'},{role:'zoom'},{role:'front'}]},
      {label:'帮助', submenu:[{label:'Whistle HTTPS 配置', click:() => { void shell.openExternal('https://wproxy.org/docs/gui/https.html'); }}]}
    ]));
    createWindow();
    app.on('activate', () => { if (!window) createWindow(); });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
