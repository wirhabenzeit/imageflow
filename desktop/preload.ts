import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { channels } from '../src/desktop';
import type { DesktopApi } from '../src/desktop';

function listen<T>(channel: string, listener: (value: T) => void) {
  const callback = (_event: Electron.IpcRendererEvent, value: T) => listener(value);
  ipcRenderer.on(channel, callback);
  return () => { ipcRenderer.removeListener(channel, callback); };
}

const api: DesktopApi = {
  openProject: (action) => ipcRenderer.invoke(channels.open, action),
  saveProject: (id, files) => ipcRenderer.invoke(channels.save, id, files),
  importFiles: (id, request) => ipcRenderer.invoke(channels.import, id, request),
  pathsForFiles: (files) => files.map((file) => webUtils.getPathForFile(file)).filter(Boolean),
  exportBook: (id, mode) => ipcRenderer.invoke(channels.export, id, mode),
  cancelExport: () => ipcRenderer.invoke(channels.cancel),
  checkBook: (id, request) => ipcRenderer.invoke(channels.check, id, request),
  cancelCheck: () => ipcRenderer.invoke(channels.cancelCheck),
  onCommand: (listener) => listen(channels.command, listener),
  onProjectChanged: (listener) => listen(channels.changed, listener),
  onProgress: (listener) => listen(channels.progress, listener),
};
contextBridge.exposeInMainWorld('imageflow', api);
