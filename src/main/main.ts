import { app, BrowserWindow, dialog, ipcMain, Menu, shell, type MenuItemConstructorOptions } from 'electron';
import { mkdirSync } from 'node:fs';
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
import { WindowsSystemProxy } from './windows-system-proxy';
import { resolveDataPath } from './data-path';
import { PreferenceStore } from './preferences';
import { setLocale, t, type LanguageSettings } from '../shared/i18n';

// Keep the established storage/single-instance identity across the display rename.
// Read Electron's explicit profile before changing the name so isolated launches stay isolated.
const dataRoot = resolveDataPath({
  appData: app.getPath('appData'),
  packaged: app.isPackaged,
  commandLineProfile: app.commandLine.hasSwitch('user-data-dir') ? app.getPath('userData') : undefined,
  developmentProfile: process.env.MOCK_MANAGER_DATA_DIR,
});
app.setName('Mock Manager');
mkdirSync(dataRoot, { recursive: true });
app.setPath('userData', dataRoot);
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
let window: BrowserWindow | null = null;
const preferences = new PreferenceStore(dataRoot);
let languageSettings: LanguageSettings = { preference: 'system', locale: 'zh-CN' };
const engine = new EmbeddedWhistle(dataRoot, join(__dirname, 'whistle-worker.cjs'));
const controller = new SyncController(new DataStore(dataRoot), engine);
let shutdownInProgress = false;
const proxyHelperOverride = !app.isPackaged ? process.env.MOCK_MANAGER_PROXY_HELPER : undefined;
const helperName = process.platform === 'win32' ? 'windows-system-proxy.ps1' : 'system-proxy';
const proxyHelper = proxyHelperOverride && isAbsolute(proxyHelperOverride) ? proxyHelperOverride
  : app.isPackaged ? join(process.resourcesPath, helperName) : join(__dirname, '../dist-native', helperName);
const systemProxy = new SystemProxyController(dataRoot, process.platform === 'win32'
  ? new WindowsSystemProxy(proxyHelper) : new NativeSystemProxy(proxyHelper));
const devUrl = !app.isPackaged ? process.env.MOCK_MANAGER_DEV_URL : undefined;
const rendererPath = join(__dirname, '../dist/index.html');
const trustedUrl = devUrl ? new URL(devUrl).href : pathToFileURL(rendererPath).href;

function handle(channel: string, fn: (...args: any[]) => Promise<unknown>) {
  ipcMain.handle(`manager:${channel}`, async (event, ...args) => {
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url.split('#')[0] !== trustedUrl) {
      throw new Error(t("拒绝未知窗口的请求。", "Request from an unknown window was rejected."));
    }
    if (shutdownInProgress) throw new Error(t("正在恢复系统代理并退出，请稍候。", "Restoring the system proxy and quitting. Please wait."));
    return fn(...args);
  });
}
async function readSelectedJson(): Promise<string | null> {
  const {canceled, filePaths} = await dialog.showOpenDialog(window!, {properties:['openFile'], filters:[{name:t("JSON 文件", "JSON files"),extensions:['json']}]});
  if (canceled || !filePaths[0]) return null;
  if ((await stat(filePaths[0])).size > MAX_DATA_BYTES) throw new Error(t("文件超过 32 MiB，请先精简响应或拆分备份。", "The file exceeds 32 MiB. Reduce the response size or split the backup."));
  const text = await readFile(filePaths[0], 'utf8'); JSON.parse(text); return text;
}
function setupIpc() {
  handle('getLanguage', async () => languageSettings);
  handle('setLanguage', async (value: unknown) => {
    const next = await preferences.setLanguage(value, app.getPreferredSystemLanguages());
    languageSettings = next;
    setLocale(next.locale);
    updateMenu();
    return next;
  });
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
    if (typeof enabled !== 'boolean') throw new Error(t("系统代理参数无效。", "Invalid system proxy parameter."));
    if (!enabled) return systemProxy.disable();
    const status = await controller.status();
    if (!status.running || !status.address || !status.port) throw new Error(t("请先启动本地代理引擎，再开启系统代理。", "Start the local proxy engine before enabling the system proxy."));
    const host = new URL(`http://${status.address}/`).hostname.replace(/^\[|\]$/g, '');
    return systemProxy.enable({ host, port: status.port });
  });
  handle('releaseSystemProxy', () => systemProxy.release());
  handle('testConnection', async () => {
    const status = await controller.status();
    if (!status.running || !status.host || !status.port) throw new Error(t("请先启动本地代理引擎。", "Start the local proxy engine first."));
    return testProxyConnection(status.host, status.port);
  });
  handle('exportCertificate', async () => {
    const certificate = await engine.certificate();
    const {canceled, filePath} = await dialog.showSaveDialog(window!, {
      title: t("导出 HTTPS 根证书", "Export HTTPS root certificate"), defaultPath: 'Mock-Manager-Root-CA.crt',
      filters: [{name: t("公开证书", "Public certificate"), extensions: ['crt']}],
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
    if (Buffer.byteLength(content)>MAX_DATA_BYTES) throw new Error(t("备份超过 32 MiB，请先拆分项目。", "The backup exceeds 32 MiB. Split the projects first."));
    await writeFile(filePath, content, {encoding:'utf8',mode:0o600}); return true;
  });
  handle('openDataFolder', async () => { await mkdir(dataRoot,{recursive:true}); const error = await shell.openPath(dataRoot); if (error) throw new Error(error); });
}
function createWindow() {
  window = new BrowserWindow({
    width:1440, height:940, minWidth:1080, minHeight:720,
    title:'Mock Manager',
    ...(process.platform === 'darwin' ? { titleBarStyle:'hiddenInset' as const, trafficLightPosition:{x:20,y:20} } : {}),
    backgroundColor:'#ffffff', show:false,
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
      finish(reply.ok === true ? undefined : new Error(typeof reply.error === 'string' ? reply.error.slice(0, 2000) : t("草稿保存未完成。", "The draft has not finished saving.")));
    };
    const timeout = setTimeout(() => finish(new Error(t("等待草稿保存超时，请稍后重试退出。", "Saving the draft timed out. Try quitting again."))), 15_000);
    ipcMain.on('manager:preparedQuit', receive);
    target.once('closed', closed);
    target.webContents.send('manager:prepareQuit', id);
  });
}
async function openThirdPartyNotices() {
  const path = join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'THIRD-PARTY-NOTICES.txt');
  const error = await shell.openPath(path);
  if (error) await dialog.showMessageBox({
    type: 'error', title: t("无法打开开源许可证", "Unable to open open-source licenses"), message: t("许可证文件暂时无法打开", "The license file could not be opened"), detail: error,
  });
}
function updateMenu() {
  const mac = process.platform === 'darwin';
  const macItems: MenuItemConstructorOptions[] = mac ? [
    { role: 'about', label: t('关于 Mock Manager', 'About Mock Manager') },
    { label: t('开源许可证', 'Open-source licenses'), click: () => { void openThirdPartyNotices(); } },
    { type: 'separator' },
    { role: 'hide', label: t('隐藏 Mock Manager', 'Hide Mock Manager') },
    { role: 'hideOthers', label: t('隐藏其他应用', 'Hide Others') },
    { role: 'unhide', label: t('显示全部', 'Show All') },
    { type: 'separator' },
  ] : [];
  const template: MenuItemConstructorOptions[] = [
    { label: mac ? app.name : t('文件', 'File'), submenu: [
      ...macItems,
      { role: 'quit', label: t('退出 Mock Manager', 'Quit Mock Manager') },
    ] },
    { label: t('编辑', 'Edit'), submenu: [
      { role: 'undo', label: t('撤销', 'Undo') }, { role: 'redo', label: t('重做', 'Redo') },
      { type: 'separator' }, { role: 'cut', label: t('剪切', 'Cut') },
      { role: 'copy', label: t('复制', 'Copy') }, { role: 'paste', label: t('粘贴', 'Paste') },
      { role: 'selectAll', label: t('全选', 'Select All') },
    ] },
    { label: t('窗口', 'Window'), submenu: [
      { role: 'minimize', label: t('最小化', 'Minimize') }, { role: 'zoom', label: t('缩放', 'Zoom') },
      mac ? { role: 'front', label: t('前置全部窗口', 'Bring All to Front') }
        : { role: 'close', label: t('关闭窗口', 'Close Window') },
    ] },
    { label: t('帮助', 'Help'), submenu: [
      { label: t('HTTPS 配置文档', 'HTTPS setup guide'), click: () => { void shell.openExternal('https://wproxy.org/docs/gui/https.html'); } },
      { label: t('开源许可证', 'Open-source licenses'), click: () => { void openThirdPartyNotices(); } },
      ...(!mac ? [{ role: 'about' as const, label: t('关于 Mock Manager', 'About Mock Manager') }] : []),
    ] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
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
        window?.webContents.send('manager:quitCancelled');
        window?.show();
        await dialog.showMessageBox(window!, {type: 'error', title: t("暂时无法退出", "Unable to quit"),
          message: t("应用与内置代理将保持运行", "The app and local proxy will keep running"),
          detail: (error instanceof Error ? error.message : String(error)) + '\n' + t('请在连接设置中处理后再退出。', 'Resolve the issue in Connection settings before quitting.'), buttons: [t("返回应用", "Return to app")]});
      }
    })();
  });
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
  void app.whenReady().then(async () => {
    languageSettings = await preferences.load(app.getPreferredSystemLanguages());
    setLocale(languageSettings.locale);
    setupIpc();
    updateMenu();
    void controller.startWhistle().catch(() => { /* Connection status exposes startup errors with retry. */ });
    createWindow();
    app.on('activate', () => { if (!window) createWindow(); });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
