import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { channels } from '../src/desktop';
import type { DesktopApi } from '../src/desktop';

function listen<T>(channel: string, listener: (value: T) => void) {
  const callback = (_event: Electron.IpcRendererEvent, value: T) => listener(value);
  ipcRenderer.on(channel, callback);
  return () => { ipcRenderer.removeListener(channel, callback); };
}

const api: DesktopApi = {
  onSourceCommand: (listener) => listen(channels.sourceCommand, listener),
  templateAction: (id, action) => ipcRenderer.invoke(channels.templateAction, id, action),
  showContextMenu: (ids, state) => ipcRenderer.invoke(channels.contextMenu, ids, state),
  documentIcon: () => ipcRenderer.invoke(channels.documentIcon),
  popupMenu: (items, point) => ipcRenderer.invoke(channels.popupMenu, items, point),
  setPresentation: (active) => ipcRenderer.invoke(channels.presentation, active),
  documentProxy: (action) => ipcRenderer.invoke(channels.documentProxy, action),
  dragSources: (keys) => ipcRenderer.invoke(channels.dragSources, keys),
  showAssets: (accept) => ipcRenderer.invoke(channels.showAssets, accept),
  showTemplates: () => ipcRenderer.invoke(channels.showTemplates),
  templatePreview: (id, hash) => ipcRenderer.invoke(channels.templatePreview, id, hash),
  sourceAction: (request) => ipcRenderer.invoke(channels.sourceAction, request),
  saveCopy: (includeAssets) => ipcRenderer.invoke(channels.saveCopy, includeAssets),
  currentProject: () => ipcRenderer.invoke(channels.current),
  onAppError: (listener) => listen(channels.appError, listener),
  recentDocuments: () => ipcRenderer.invoke(channels.recents),
  onRecentsChanged: (listener) => listen(channels.recentsChanged, listener),
  recentDocument: (id, action) => ipcRenderer.invoke(channels.recentAction, id, action),
  chooseStarter: (choice) => ipcRenderer.invoke(channels.chooseStarter, choice),
  library: () => ipcRenderer.invoke(channels.library),
  onLibraryChanged: (listener) => listen(channels.libraryChanged, listener),
  importTemplates: (paths) => ipcRenderer.invoke(channels.libraryImport, paths),
  removeTemplate: (id) => ipcRenderer.invoke(channels.libraryRemove, id),
  exportTemplate: (id) => ipcRenderer.invoke(channels.libraryExport, id),
  trustTemplate: (id, allow) => ipcRenderer.invoke(channels.libraryTrust, id, allow),
  documentAction: (action, id) => ipcRenderer.invoke(channels.documentAction, action, id),
  getSettings: () => ipcRenderer.invoke(channels.settings),
  updateSettings: (patch) => ipcRenderer.invoke(channels.updateSettings, patch),
  onSettingsChanged: (listener) => listen(channels.settingsChanged, listener),
  showSettings: (pane) => ipcRenderer.invoke(channels.showSettings, pane),
  settingsPane: () => ipcRenderer.invoke(channels.settingsPane),
  onSettingsPane: (listener) => listen(channels.settingsPane, listener),
  fitSettings: (height) => ipcRenderer.invoke(channels.fitSettings, height),
  setBookMenuState: (state) => ipcRenderer.invoke(channels.bookMenu, state),
  setPanelVisibility: (state) => ipcRenderer.invoke(channels.panelVisibility, state),
  openProject: (action) => ipcRenderer.invoke(channels.open, action),
  saveProject: (id, files, label) => ipcRenderer.invoke(channels.save, id, files, label),
  history: (id, direction) => ipcRenderer.invoke(channels.history, id, direction),
  mcpSettings: (enabled) => ipcRenderer.invoke(channels.mcp, enabled),
  onMcpChanged: (listener) => listen(channels.mcpChanged, listener),
  installMcp: (target) => ipcRenderer.invoke(channels.mcpInstall, target),
  onAgentLease: (listener) => listen<string>(channels.agentLease, (id) => {
    ipcRenderer.send(channels.agentLeaseReply, id, listener(id));
  }),
  onAgentRelease: (listener) => listen(channels.agentRelease, listener),
  importFiles: (id, request) => ipcRenderer.invoke(channels.import, id, request),
  editorNetwork: (id, origins) => ipcRenderer.invoke(channels.network, id, origins),
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
