import { contextBridge, ipcRenderer } from 'electron';
import type { AppData, DesktopBridge } from '../shared/types';
const bridge: DesktopBridge = {
  load: () => ipcRenderer.invoke('manager:load'),
  save: (data: AppData) => ipcRenderer.invoke('manager:save', data),
  status: () => ipcRenderer.invoke('manager:status'),
  apply: () => ipcRenderer.invoke('manager:apply'),
  disable: () => ipcRenderer.invoke('manager:disable'),
  restore: () => ipcRenderer.invoke('manager:restore'),
  startWhistle: () => ipcRenderer.invoke('manager:startWhistle'),
  enableMultiSelect: () => ipcRenderer.invoke('manager:enableMultiSelect'),
  enableRules: () => ipcRenderer.invoke('manager:enableRules'),
  testConnection: () => ipcRenderer.invoke('manager:testConnection'),
  exportCertificate: () => ipcRenderer.invoke('manager:exportCertificate'),
  onPrepareQuit: callback => {
    const listener = (_event: Electron.IpcRendererEvent, id: string) => {
      void callback().then(() => ipcRenderer.send('manager:preparedQuit', {id, ok: true}),
        error => ipcRenderer.send('manager:preparedQuit', {id, ok: false, error: error instanceof Error ? error.message : String(error)}));
    };
    ipcRenderer.on('manager:prepareQuit', listener);
    return () => { ipcRenderer.removeListener('manager:prepareQuit', listener); };
  },
  onQuitCancelled: callback => {
    const listener = () => callback();
    ipcRenderer.on('manager:quitCancelled', listener);
    return () => { ipcRenderer.removeListener('manager:quitCancelled', listener); };
  },
  importBackup: () => ipcRenderer.invoke('manager:importBackup'),
  exportBackup: () => ipcRenderer.invoke('manager:exportBackup'),
  importResponse: () => ipcRenderer.invoke('manager:importResponse'),
  openDataFolder: () => ipcRenderer.invoke('manager:openDataFolder'),
  systemProxyStatus: () => ipcRenderer.invoke('manager:systemProxyStatus'),
  setSystemProxy: (enabled: boolean) => ipcRenderer.invoke('manager:setSystemProxy', enabled),
  releaseSystemProxy: () => ipcRenderer.invoke('manager:releaseSystemProxy'),
};
contextBridge.exposeInMainWorld('mockManager', bridge);
