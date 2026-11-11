import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { channels } from '../src/desktop';
import type { DesktopApi } from '../src/desktop';

function listen<T>(channel: string, listener: (value: T) => void) {
  const callback = (_event: Electron.IpcRendererEvent, value: T) => listener(value);
  ipcRenderer.on(channel, callback);
  return () => { ipcRenderer.removeListener(channel, callback); };
}

const api: DesktopApi = {
  getSettings: () => ipcRenderer.invoke(channels.settings),
  updateSettings: (patch) => ipcRenderer.invoke(channels.updateSettings, patch),
  setPanelVisibility: (state) => ipcRenderer.invoke(channels.panelVisibility, state),
  openProject: (action) => ipcRenderer.invoke(channels.open, action),
  saveProject: (id, files, label) => ipcRenderer.invoke(channels.save, id, files, label),
  history: (id, direction) => ipcRenderer.invoke(channels.history, id, direction),
  mcpSettings: (enabled) => ipcRenderer.invoke(channels.mcp, enabled),
  onMcpChanged: (listener) => listen(channels.mcpChanged, listener),
  onAgentLease: (listener) => listen<string>(channels.agentLease, (id) => {
    ipcRenderer.send(channels.agentLeaseReply, id, listener(id));
  }),
  onAgentRelease: (listener) => listen(channels.agentRelease, listener),
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
