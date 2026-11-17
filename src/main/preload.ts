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
  chooseW2: () => ipcRenderer.invoke('manager:chooseW2'),
  importBackup: () => ipcRenderer.invoke('manager:importBackup'),
  exportBackup: () => ipcRenderer.invoke('manager:exportBackup'),
  importResponse: () => ipcRenderer.invoke('manager:importResponse'),
  openWhistle: () => ipcRenderer.invoke('manager:openWhistle'),
  openDataFolder: () => ipcRenderer.invoke('manager:openDataFolder'),
};
contextBridge.exposeInMainWorld('mockManager', bridge);
