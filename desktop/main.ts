import { collectSources, relocateSource, relinkFolder, saveDocumentCopy } from './source-actions';
import { originalPath } from './source-store';
import { sourceEntries } from '../src/source-locations';
import { configureSourceStore, pruneSourceCache, SourceStore } from './source-store';
import { configureSourceAccess } from './source-access';
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, net, powerMonitor, protocol, shell } from 'electron';
import type { BaseWindow, IpcMainInvokeEvent, MenuItemConstructorOptions } from 'electron';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, extname, join, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { channels, gridColumns, desktopScheme, editorURL, renderOrigin, settingsURL, startURL, starterURL } from '../src/desktop';
import type { CanvasLayout, Command, ExportMode, ImportRequest, OpenAction, ProjectSummary, Result, McpClientTarget, McpSettings, SourceAction } from '../src/desktop';
import type { ProjectFiles } from '../src/project';
import { assetTypes, loadProject, renderData } from './project';
import type { OpenProject } from './project';
import { photoFile } from './photos';
import { captureBookPreview } from './preview';
import { DocumentSession } from './document-session';
import type { RenderSessions } from './document-session';
import { createDocument, documentIdentity, documentPath, isDocument, RecentDocuments } from './documents';
import { SettingsStore } from './settings';
import { AuthoringError } from './authoring-service';
import { createMcpConnection } from './mcp-connection';
import { addToCodex, bridgeLaunch, claudeCodeCommand, claudeExtension, findCodex } from './mcp-setup';
import { authoringErrorResult } from './authoring-errors';
import { acquireProjectLock } from './persistence';
import type { AuthoringCheckRequest } from '../src/authoring-check';
import type { SettingsPane } from '../src/settings';
import { mcpTools } from '../src/mcp-contract';
import { starters } from '../src/starters';
import { templateFolder, textSourcePath } from './document-actions';
import { configureRenditionCache, pruneRenditions } from './rendition-cache';

let settingsWindow: BrowserWindow | null = null;
let startWindow: BrowserWindow | null = null;
let settingsPane: SettingsPane = 'general';
let mcpConnection: Awaited<ReturnType<typeof createMcpConnection>> | undefined;
let mcpClients: { name: string }[] = [];
let quitting = false;
let quitReady = false;
let quitCleanup: Promise<void> | undefined;
let connectionSettingsQueue = Promise.resolve();
let cache: string;
let settings: SettingsStore;
let recents: RecentDocuments;
const sessions: RenderSessions = new Map();
const documents = new Map<number, DocumentSession>();
const identities = new Map<string, DocumentSession>();
const opening = new Map<string, Promise<DocumentSession>>();
const closing = new Set<Promise<void>>();
const covers = new Map<DocumentSession, { dirty: boolean; timer?: ReturnType<typeof setTimeout>; job?: AbortController; task?: Promise<void> }>();
const pickers = new Map<number, { window: BrowserWindow; select: (id?: string) => void }>();
const pendingOpenFiles: string[] = [];
let ready = false;
let lastDocument: DocumentSession | undefined;
const hidden = !!process.env.IMAGEFLOW_HIDE_WINDOW;
const devServer = app.isPackaged ? undefined : process.env.IMAGEFLOW_DEV_SERVER;
const devState = devServer ? process.env.IMAGEFLOW_DEV_STATE : undefined;
const devSample = devServer ? process.env.IMAGEFLOW_DEV_SAMPLE : undefined;
const csp = devServer
  ? "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self' " +
    devServer + ' ' + devServer.replace(/^http/, 'ws') + "; img-src 'self' data:"
  : "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; img-src 'self' data:";
if (app.isPackaged) process.env.ESBUILD_BINARY_PATH = join(process.resourcesPath, 'esbuild');
const viewPath = /^\/render\/([a-f0-9-]{36})(?:\/(.*))?$/;

if (!app.requestSingleInstanceLock()) app.exit(0);
// The app remains available after its last book closes; cleanup opens the start window.
app.on('window-all-closed', () => {});
// macOS can deliver documents before Electron is ready. Register before waiting for app startup.
app.on('open-file', (event, path) => {
  event.preventDefault();
  if (!ready) pendingOpenFiles.push(path);
  else void openFromSystem(path);
});
app.on('second-instance', (_event, argv) => {
  const paths = argv.filter(isDocument);
  if (!ready) pendingOpenFiles.push(...paths);
  else if (paths.length) for (const path of paths) void openFromSystem(path);
  else if (lastDocument && !lastDocument.closing) focus(lastDocument.window);
  else if (ready) showStart();
});
protocol.registerSchemesAsPrivileged([
  { scheme: desktopScheme, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

function response(bytes: Uint8Array, type: string, headers?: Record<string, string>) {
  return new Response(new Uint8Array(bytes), { headers: { 'Content-Type': type, ...headers } });
}

async function pageHtml(dist: string) {
  if (!devServer) return readFile(join(dist, 'index.html'));
  const page = await net.fetch(devServer + '/');
  if (!page.ok) throw new Error('The Vite dev server did not return the editor page.');
  return new Uint8Array(await page.arrayBuffer());
}

async function serve(request: Request) {
  if (request.method !== 'GET') return new Response(null, { status: 405 });
  const { host, pathname } = new URL(request.url);
  if (host !== 'editor' && host !== 'render') return new Response(null, { status: 404 });
  const dist = join(app.getAppPath(), 'dist');
  if (!devServer && /^\/assets\/[\w.-]+\.[a-z0-9]+$/i.test(pathname)) return net.fetch(pathToFileURL(join(dist, pathname)).href);
  if (host === 'editor' && ['/', '/settings', '/start', '/new'].includes(pathname)) {
    return response(await pageHtml(dist), 'text/html; charset=utf-8', {
      'Content-Security-Policy': csp + ' ' + renderOrigin + '; frame-src ' + renderOrigin + "; frame-ancestors 'none'; base-uri 'none'",
    });
  }
  const match = host === 'render' ? viewPath.exec(pathname) : null;
  if (!match && devServer) return net.fetch(devServer + pathname + new URL(request.url).search);
  if (!match) return new Response(null, { status: 404 });
  const [, id, resource] = match;
  const session = sessions.get(id);
  if (!session) return new Response(null, { status: 404 });
  if (!resource) {
    return response(await pageHtml(dist), 'text/html; charset=utf-8', {
      'Content-Security-Policy': csp + '; frame-ancestors ' + editorURL + "; base-uri 'self'",
    });
  }
  if (resource === 'data') return Response.json(renderData(session.book, id, session.mode));
  if (resource.startsWith('template/')) {
    const asset = resource.slice('template/'.length);
    const bytes = session.book.assets.files.get(asset);
    if (bytes) return response(bytes, assetTypes[extname(asset).toLowerCase()] ?? 'application/octet-stream');
  }
  const photoMatch = /^(photo|thumb)\/([\w-]+)(?:\/([1-9]\d{0,5}))?$/.exec(resource);
  if (photoMatch) {
    const [, kind, photoId, size] = photoMatch;
    const photo = session.book.photos.get(photoId);
    const rendition = kind === 'thumb' ? 'thumb' : session.mode === 'edit' ? 'preview' : 'export';
    const width = size && rendition === 'export' ? Number(size) : undefined;
    if (photo) return net.fetch(pathToFileURL(await photoFile(photo, rendition, width)).href);
  }
  return new Response(null, { status: 404 });
}


function errorMessage(error: unknown) { return error instanceof Error ? error.message : 'ImageFlow could not complete the request.'; }
function focus(owner: BrowserWindow) {
  if (owner.isDestroyed()) return;
  if (owner.isMinimized()) owner.restore();
  if (!hidden) owner.show();
  owner.focus();
}
type RendererEvent = Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>;
function trusted(event: RendererEvent, owner: BrowserWindow | null | undefined, url: string) {
  return !!owner && !owner.isDestroyed() && event.sender === owner.webContents &&
    event.senderFrame === owner.webContents.mainFrame && event.senderFrame.url === url;
}
function editorOwner(event: RendererEvent) {
  const document = documents.get(event.sender.id);
  return trusted(event, document?.window, editorURL) ? document : undefined;
}
function settingsOwner(event: IpcMainInvokeEvent) { return trusted(event, settingsWindow, settingsURL) ? settingsWindow : undefined; }
function startOwner(event: IpcMainInvokeEvent) { return trusted(event, startWindow, startURL) ? startWindow : undefined; }
function appOwner(event: IpcMainInvokeEvent) { return editorOwner(event)?.window ?? startOwner(event) ?? settingsOwner(event); }
async function fromEditor<T>(event: IpcMainInvokeEvent, run: (document: DocumentSession) => Promise<T>): Promise<Result<T>> {
  const document = editorOwner(event);
  if (!document || quitting) return { error: 'Request is only available to an open book.' };
  return document.run(() => run(document));
}
function focusedDocument(owner: BaseWindow | null | undefined = BrowserWindow.getFocusedWindow()) {
  const browser = owner ? BrowserWindow.fromId(owner.id) : undefined;
  return browser ? documents.get(browser.webContents.id) : lastDocument && !lastDocument.closing ? lastDocument : undefined;
}
function report(owner: BrowserWindow | null | undefined, error: unknown) {
  if (owner && !owner.isDestroyed()) owner.webContents.send(channels.appError, errorMessage(error));
  else { showStart(); startWindow?.webContents.once('did-finish-load', () => report(startWindow, error)); }
}
function sampleFolder(name = 'whitewall') {
  return devSample ? join(devSample, name) : app.isPackaged ? join(process.resourcesPath, 'sample', name) : join(app.getAppPath(), 'sample', name);
}
async function openDocumentLocation(document: DocumentSession, action: 'reveal' | 'template' | 'text', id?: string) {
  if (action === 'reveal') { shell.showItemInFolder(document.book.folder); return; }
  const source = action === 'text' && id ? document.book.project.texts[id] : undefined;
  const path = action === 'template' ? await templateFolder(document.book.folder)
    : source ? await textSourcePath(document.book.folder, source, id) : undefined;
  if (!path) throw new Error('Choose a text source first.');
  const error = await shell.openPath(path);
  if (error) throw new Error(error);
}
function windowOptions() {
  return { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: join(__dirname, 'preload.cjs'), backgroundThrottling: !hidden };
}
function secureWindow(owner: BrowserWindow) {
  followAppearance(owner);
  owner.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}
function showStart() {
  if (quitting) return;
  if (startWindow && !startWindow.isDestroyed()) { focus(startWindow); return; }
  const owner = new BrowserWindow({ title: 'ImageFlow', width: 800, height: 570, minWidth: 680, minHeight: 480,
    show: false, ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : {}), webPreferences: windowOptions() });
  startWindow = owner;
  secureWindow(owner);
  owner.webContents.on('will-frame-navigate', (event) => event.preventDefault());
  owner.once('ready-to-show', () => { if (!hidden) owner.show(); });
  owner.once('closed', () => { if (startWindow === owner) startWindow = null; });
  void owner.loadURL(startURL).catch((error) => console.error('ImageFlow could not open its start window', error));
}
function publishRecents() { if (startWindow && !startWindow.isDestroyed()) startWindow.webContents.send(channels.recentsChanged); }
async function maintainSources() {
  await pruneSourceCache((await recents.list()).map((entry) => entry.path)).catch((error) => console.warn('ImageFlow could not prune source snapshots', error));
}
function track(task: Promise<void>) {
  closing.add(task);
  void task.catch((error) => console.error('ImageFlow could not finish document cleanup', error)).finally(() => closing.delete(task));
}
function markCoverDirty(document: DocumentSession) {
  const work = covers.get(document);
  if (work) { work.dirty = true; clearTimeout(work.timer); work.job?.abort(); }
  else covers.set(document, { dirty: true });
}
function captureCover(document: DocumentSession, book: OpenProject, closing = false) {
  const state = covers.get(document) ?? { dirty: true };
  covers.set(document, state);
  state.job?.abort();
  const job = new AbortController();
  state.job = job;
  state.task = (async () => {
    const id = randomUUID();
    sessions.set(id, { book, mode: 'export' });
    try {
      const cover = await captureBookPreview(renderOrigin + '/render/' + id,
        { target: { page: 1 }, maxEdge: 320, format: 'jpeg' }, job.signal);
      if (document.book !== book || (!closing && document.closing) || job.signal.aborted) return;
      await recents.refresh(book.folder, book.project.title, 'data:image/jpeg;base64,' + Buffer.from(cover.bytes).toString('base64'));
      state.dirty = false;
      publishRecents();
    } catch (error) {
      if (!job.signal.aborted) console.warn('ImageFlow could not update a recent-book cover', error);
    }
    finally { sessions.delete(id); }
  })();
  return state.task;
}
function scheduleCover(document: DocumentSession, book: OpenProject) {
  if (book.readOnly || document.closing) return;
  markCoverDirty(document);
  const state = covers.get(document)!;
  state.timer = setTimeout(() => {
    if (document.closing || document.book !== book) return;
    void captureCover(document, book);
  }, 1000);
}
async function saveDevState() {
  if (devState) await writeFile(devState, JSON.stringify([...documents.values()].filter((document) => !document.closing)
    .map((document) => ({ folder: document.book.folder, readOnly: document.book.readOnly })))).catch(() => {});
}
async function openDocument(path: string, readOnly = false): Promise<DocumentSession> {
  if (quitting) throw new Error('ImageFlow is closing.');
  if (!readOnly && !isDocument(path)) throw new Error('Choose an .imageflow document.');
  const { folder, identity } = await documentIdentity(path);
  const existing = identities.get(identity);
  if (existing) {
    if (existing.closing) {
      await existing.close().catch(() => {});
      if (identities.get(identity) === existing) identities.delete(identity);
      return openDocument(path, readOnly);
    }
    if (existing.book.folder !== folder) {
      const relocated = await existing.run(() => existing.relocate(folder));
      if ('error' in relocated) throw new Error(relocated.error);
    }
    if (!existing.book.readOnly) {
      await recents.remember(folder, existing.book.project.title);
      app.addRecentDocument(folder);
      publishRecents();
    }
    await saveDevState();
    focus(existing.window);
    return existing;
  }
  const pending = opening.get(identity);
  if (pending) return pending;
  const task = (async () => {
    const release = readOnly ? undefined : await acquireProjectLock(folder);
    let editor: BrowserWindow | undefined;
    let document: DocumentSession | undefined;
    try {
      const book = await loadProject(folder, cache, readOnly);
      if (quitting) throw new Error('ImageFlow is closing.');
      editor = new BrowserWindow({ width: 1520, height: 950, minWidth: 940, minHeight: 650, show: false,
        ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 20 } } : {}),
        webPreferences: windowOptions() });
      secureWindow(editor);
      document = new DocumentSession(editor, book, cache, sessions, release, (next) => {
        if (document && !next.readOnly) {
          void recents.refresh(next.folder, next.project.title).then(publishRecents).catch((error) => console.warn('ImageFlow could not update recent books', error));
          markCoverDirty(document);
        }
      });
      const current = document;
      const webContentsId = editor.webContents.id;
      documents.set(webContentsId, document);
      identities.set(identity, document);
      lastDocument = document;
      editor.on('focus', () => { lastDocument = current; updateMenus(); });
      editor.on('blur', () => { if (covers.get(current)?.dirty) scheduleCover(current, current.book); });
      editor.on('closed', () => {
        documents.delete(webContentsId);
        const work = covers.get(current);
        if (work) { clearTimeout(work.timer); work.job?.abort(); }
        const task = (async () => {
          try {
            await current.close(); await work?.task;
            if (work?.dirty && !quitting) await captureCover(current, current.book, true);
          }
          finally {
            covers.delete(current);
            await SourceStore.release(current.book.folder);
            await maintainSources();
            if (identities.get(identity) === current) identities.delete(identity);
            if (lastDocument === current) lastDocument = [...documents.values()].at(-1);
            await saveDevState();
            if (!documents.size && !quitting) showStart();
            updateMenus();
          }
        })();
        track(task);
      });
      await editor.loadURL(editorURL);
      editor.once('ready-to-show', () => { if (!hidden) focus(current.window); });
      // loadURL may finish after ready-to-show, so showing is also safe here.
      focus(editor);
      if (!readOnly) {
        await recents.remember(folder, book.project.title);
        app.addRecentDocument(folder);
        publishRecents();
        scheduleCover(current, book);
      }
      startWindow?.hide();
      await saveDevState();
      updateMenus();
      return current;
    } catch (error) {
      if (document) { editor?.destroy(); await document.close(); }
      else { editor?.destroy(); await release?.(); }
      throw error;
    }
  })();
  opening.set(identity, task);
  try { return await task; }
  finally { if (opening.get(identity) === task) opening.delete(identity); }
}
async function openFromSystem(path: string) {
  try { await openDocument(path); }
  catch (error) { report(startWindow ?? lastDocument?.window, error); }
}
async function chooseStarter(owner: BrowserWindow): Promise<string | undefined> {
  const existing = pickers.get(owner.id);
  if (existing) { focus(existing.window); return undefined; }
  const picker = new BrowserWindow({ title: 'New Book', width: 560, height: 430, resizable: false, show: false,
    parent: owner, modal: true, webPreferences: windowOptions() });
  secureWindow(picker);
  picker.webContents.on('will-frame-navigate', (event) => event.preventDefault());
  const result = new Promise<string | undefined>((resolve) => {
    let selection: string | undefined;
    let closed = false;
    let sheetOpen = false;
    let finishing = false;
    const finish = () => {
      if (!closed || sheetOpen || finishing) return;
      finishing = true;
      owner.off('sheet-begin', beginSheet);
      owner.off('sheet-end', endSheet);
      owner.off('closed', ownerClosed);
      // The next native panel must start outside the modal window's close callback.
      setImmediate(() => { pickers.delete(owner.id); resolve(owner.isDestroyed() ? undefined : selection); });
    };
    const beginSheet = () => { sheetOpen = true; };
    const endSheet = () => { sheetOpen = false; finish(); };
    const ownerClosed = () => { selection = undefined; closed = true; sheetOpen = false; finish(); };
    if (process.platform === 'darwin') { owner.on('sheet-begin', beginSheet); owner.on('sheet-end', endSheet); }
    owner.once('closed', ownerClosed);
    picker.once('closed', () => { closed = true; finish(); });
    pickers.set(owner.id, { window: picker, select: (id) => { selection = id; picker.close(); } });
  });
  picker.once('ready-to-show', () => { if (!hidden) picker.show(); });
  await picker.loadURL(starterURL);
  return result;
}
async function openProject(owner: BrowserWindow, action: OpenAction, document?: DocumentSession): Promise<ProjectSummary | null> {
  if (action === 'reload') {
    if (!document) throw new Error('Open a book first.');
    const result = await document.run(() => document.reload());
    if ('error' in result) throw new Error(result.error);
    return result.value;
  }
  if (action === 'sample') { await openDocument(sampleFolder(), true); return null; }
  if (action === 'new') {
    const starter = await chooseStarter(owner);
    if (!starter || owner.isDestroyed()) return null;
    const entry = starters.find((entry) => entry.id === starter);
    if (!entry) throw new Error('Choose an available starter.');
    const choice = await dialog.showSaveDialog(owner, { title: 'New Book', buttonLabel: 'Create Book',
      defaultPath: join(app.getPath('documents'), entry.defaultName + '.imageflow'), filters: [{ name: 'ImageFlow Book', extensions: ['imageflow'] }] });
    if (choice.canceled || !choice.filePath || owner.isDestroyed()) return null;
    const folder = await createDocument(documentPath(choice.filePath), sampleFolder(entry.folder));
    await openDocument(folder);
    return null;
  }
  if (action !== 'open') throw new Error('Unknown document action.');
  const choice = await dialog.showOpenDialog(owner, { title: 'Open ImageFlow Book', properties: ['openFile'],
    filters: [{ name: 'ImageFlow Book', extensions: ['imageflow'] }] });
  if (choice.canceled || !choice.filePaths[0] || owner.isDestroyed()) return null;
  await openDocument(choice.filePaths[0]);
  return null;
}
function updateMenus() {
  const document = focusedDocument();
  const menu = Menu.getApplicationMenu();
  for (const id of ['reload', 'save-copy', 'manage-sources', 'import-photos', 'import-folder', 'import-texts', 'export', 'print', 'undo', 'redo', 'sidebar', 'inspector',
    'layout-vertical', 'layout-grid', 'grid-columns', ...gridColumns.map((columns) => 'grid-columns-' + columns), 'reveal-book', 'open-template']) {
    const item = menu?.getMenuItemById(id);
    if (item) item.enabled = !!document && !document.closing;
  }
  const sidebar = menu?.getMenuItemById('sidebar');
  const inspector = menu?.getMenuItemById('inspector');
  if (sidebar) sidebar.label = document?.sidebar ? 'Hide Sidebar' : 'Show Sidebar';
  if (inspector) inspector.label = document?.inspector ? 'Hide Inspector' : 'Show Inspector';
  // Radio items check themselves when clicked; the window's own layout decides which stays checked. Checking one
  // item of a radio group unchecks the others.
  const layout = document?.layout ?? { mode: 'vertical', columns: 2 };
  const check = (id: string) => { const item = menu?.getMenuItemById(id); if (item) item.checked = true; };
  check(layout.mode === 'grid' ? 'layout-grid' : 'layout-vertical');
  check('grid-columns-' + layout.columns);
}
function menuCommand(label: string, accelerator: string | undefined, command: Command, id: string = command): MenuItemConstructorOptions {
  return { label, id, accelerator, click: (_item, owner) => {
    const document = focusedDocument(owner ?? undefined);
    let browser = owner ? BrowserWindow.fromId(owner.id) : undefined;
    if (command === 'new' || command === 'open' || command === 'sample') {
      if (!browser) { showStart(); browser = startWindow ?? undefined; }
      if (browser) void openProject(browser, command, document).catch((error) => report(browser, error));
    } else document?.window.webContents.send(channels.command, command);
  } };
}
const mcpDescriptorPath = () => join(app.getPath('userData'), 'mcp-connection.json');

function mcpLaunch() {
  // Packaging unpacks the bridge next to app.asar so ImageFlow's executable can run it as a plain Node script.
  const appPath = app.getAppPath();
  const bridge = join(appPath.endsWith('.asar') ? appPath + '.unpacked' : appPath, 'mcp-bridge.cjs');
  return bridgeLaunch(process.execPath, bridge, mcpDescriptorPath());
}

function mcpSettings(): McpSettings {
  const launch = mcpLaunch();
  return { enabled: !!mcpConnection, clients: mcpClients, launch, claudeCode: claudeCodeCommand(launch) };
}

function openWith(bundleId: string, file: string) {
  return new Promise<void>((resolve, reject) => {
    execFile('/usr/bin/open', ['-b', bundleId, file], (error) => { if (error) reject(error); else resolve(); });
  });
}

async function installMcp(target: McpClientTarget) {
  const launch = mcpLaunch();
  if (target === 'claude') {
    const file = join(app.getPath('userData'), 'ImageFlow.mcpb');
    await writeFile(file, claudeExtension({ launch, version: app.getVersion(), tools: mcpTools }));
    if (process.platform === 'darwin') {
      try { await openWith('com.anthropic.claudefordesktop', file); }
      catch {
        shell.showItemInFolder(file);
        throw new Error('Claude Desktop was not found. Install it, then open ImageFlow.mcpb from the folder shown in Finder.');
      }
    } else {
      const failure = await shell.openPath(file);
      if (failure) throw new Error(failure);
    }
    return 'Claude Desktop opened its extension installer. Choose Install there.';
  }
  if (target === 'codex') {
    const codex = await findCodex();
    if (!codex) throw new Error('Neither the ChatGPT desktop app nor the Codex CLI was found. Install one, or add the configuration under Other agents manually.');
    await addToCodex(codex, launch);
    return 'Added ImageFlow to ChatGPT and Codex. Start a new task in ChatGPT or Codex to load its tools.';
  }
  throw new Error('Unknown agent.');
}


function appWindows() { return [...documents.values()].map((document) => document.window).concat([startWindow, settingsWindow].filter((window): window is BrowserWindow => !!window)); }
function publishMcpSettings() {
  const value = mcpSettings();
  for (const owner of appWindows()) if (!owner.isDestroyed()) owner.webContents.send(channels.mcpChanged, value);
}
async function disableMcp() {
  const connection = mcpConnection;
  mcpConnection = undefined;
  mcpClients = [];
  await connection?.close();
  // Closing the transport aborts requests; the document-owned queues retain their slots until work settles.
  await Promise.all([...documents.values()].map((document) => document.queue.whenIdle()));
  publishMcpSettings();
}
async function enableMcp() {
  if (quitting) throw new Error('ImageFlow is closing.');
  const connection = await createMcpConnection({
    descriptorPath: mcpDescriptorPath(),
    onClientsChanged: (clients) => { mcpClients = clients; publishMcpSettings(); },
    onCall: async (name, args, signal) => {
      try {
        if (name === 'list_projects') {
          const results = await Promise.all([...documents.values()].filter((document) => !document.closing)
            .map((document) => document.agentCall(name, args, signal)));
          return { projects: results.flatMap((result) => 'projects' in result && Array.isArray(result.projects) ? result.projects : []),
            scope: 'Open, authorized books. Select an explicit project handle; focus does not change the target. Handles expire when the book closes.' };
        }
        const document = [...documents.values()].find((document) => !document.closing && document.projectSession.handle === args.project);
        if (!document) throw new AuthoringError('PROJECT_CLOSED', 'This book is no longer open. Call list_projects for current handles.');
        return await document.agentCall(name, args, signal);
      } catch (error) { return authoringErrorResult(error, signal); }
    },
  });
  if (quitting) { await connection.close(); return; }
  mcpConnection = connection;
  publishMcpSettings();
}
function followAppearance(owner: BrowserWindow) {
  const updateBackground = () => owner.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#252525' : '#f5f5f5');
  nativeTheme.on('updated', updateBackground);
  owner.once('closed', () => nativeTheme.removeListener('updated', updateBackground));
}

/** Opens Settings, switching to `pane` when given. Without one, an open window keeps its current pane. */
function showSettings(pane?: SettingsPane) {
  const hidden = !!process.env.IMAGEFLOW_HIDE_WINDOW;
  settingsPane = pane ?? (settingsWindow && !settingsWindow.isDestroyed() ? settingsPane : 'general');
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    if (pane) settingsWindow.webContents.send(channels.settingsPane, pane);
    if (!hidden) { settingsWindow.show(); settingsWindow.focus(); }
    return;
  }
  const preferences = new BrowserWindow({
    title: 'Settings', width: 540, height: 240, useContentSize: true, show: false,
    resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#252525' : '#f5f5f5',
    autoHideMenuBar: true,
    webPreferences: {
      sandbox: true, contextIsolation: true, nodeIntegration: false, preload: join(__dirname, 'preload.cjs'),
      backgroundThrottling: !hidden,
    },
  });
  settingsWindow = preferences;
  followAppearance(preferences);
  preferences.webContents.on('will-frame-navigate', (event) => event.preventDefault());
  preferences.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  preferences.on('page-title-updated', (event) => event.preventDefault());
  preferences.once('ready-to-show', () => { if (!hidden) preferences.show(); });
  preferences.once('closed', () => { if (settingsWindow === preferences) settingsWindow = null; });
  void preferences.loadURL(settingsURL).catch((error: unknown) => console.error('ImageFlow could not open Settings', error));
}


void app.whenReady().then(async () => {
  settings = new SettingsStore(join(app.getPath('userData'), 'settings.json'));
  recents = new RecentDocuments(join(app.getPath('userData'), 'recent-documents.json'));
  await Promise.all([settings.load(), recents.load()]);
  configureSourceStore(join(app.getPath('userData'), 'source-cache'));
  configureSourceAccess(join(app.getPath('userData'), 'source-access'));
  nativeTheme.themeSource = settings.value.appearance;
  cache = await mkdtemp(join(app.getPath('temp'), 'imageflow-cache-'));
  const renditions = await configureRenditionCache(cache, join(app.getPath('userData'), 'Cache', 'renditions'));
  await maintainSources();
  const sourceMaintenance = setInterval(() => { if (![...documents.values()].some((document) => document.busy)) void maintainSources(); }, 5 * 60 * 1000);
  sourceMaintenance.unref();
  await pruneRenditions(renditions).catch((error) => console.warn('ImageFlow could not prune image previews', error));
  powerMonitor.on('resume', () => { for (const document of documents.values()) document.projectSession.inputs.invalidate(); });
  app.on('browser-window-focus', () => updateMenus());
  if (!app.isPackaged && process.env.IMAGEFLOW_BENCHMARK === '1') {
    Object.defineProperty(globalThis, 'imageflowBenchmarkInputs', { value: () => lastDocument?.projectSession.inputs.metrics });
  }
  app.on('before-quit', () => { quitting = true; clearInterval(sourceMaintenance); });
  app.on('will-quit', (event) => {
    if (quitReady) return;
    event.preventDefault();
    quitCleanup ??= (async () => {
      await connectionSettingsQueue;
      await disableMcp();
      await Promise.allSettled([...opening.values()]);
      await Promise.allSettled([...closing]);
      await Promise.all([settings.settled(), recents.settled()]);
      await maintainSources();
      await rm(cache, { recursive: true, force: true });
      await pruneRenditions(renditions).catch((error) => console.warn('ImageFlow could not prune image previews', error));
    })().catch((error) => console.error('ImageFlow could not finish cleanup', error)).finally(() => { quitReady = true; app.quit(); });
  });
  protocol.handle(desktopScheme, async (request) => {
    try { return await serve(request); }
    catch (error) { console.error('ImageFlow could not serve a document resource', error); return new Response(null, { status: 404 }); }
  });
  ipcMain.handle(channels.current, (event) => {
    const document = editorOwner(event);
    return document && !document.closing ? { value: document.summary } : { error: 'This window has no open book.' };
  });
  ipcMain.handle(channels.open, async (event, action: OpenAction) => {
    const owner = editorOwner(event)?.window ?? startOwner(event);
    if (!owner || quitting) return { error: 'Request is only available to a book or the start window.' };
    try { return { value: await openProject(owner, action, editorOwner(event)) }; }
    catch (error) { return { error: errorMessage(error) }; }
  });
  ipcMain.handle(channels.chooseStarter, (event, id?: string) => {
    const picker = [...pickers.values()].find((entry) => trusted(event, entry.window, starterURL));
    if (!picker || (id !== undefined && !starters.some((entry) => entry.id === id))) return;
    picker.select(id);
  });
  ipcMain.handle(channels.recents, async (event) => startOwner(event) ? { value: await recents.list() } : { error: 'Request is only available to the start window.' });
  ipcMain.handle(channels.recentAction, async (event, id: string, action: 'open' | 'locate' | 'remove') => {
    const owner = startOwner(event);
    if (!owner || typeof id !== 'string') return { error: 'Request is only available to the start window.' };
    try {
      const entry = await recents.get(id);
      if (action === 'remove') { await recents.remove(id); publishRecents(); }
      else if (action === 'open') {
        const document = await openDocument(entry.path);
        await recents.remember(document.book.folder, document.book.project.title, entry.id);
        publishRecents();
      }
      else if (action === 'locate') {
        const choice = await dialog.showOpenDialog(owner, { title: 'Locate ' + entry.title, properties: ['openFile'],
          filters: [{ name: 'ImageFlow Book', extensions: ['imageflow'] }] });
        if (!choice.canceled && choice.filePaths[0]) {
          const document = await openDocument(choice.filePaths[0]);
          await recents.remember(document.book.folder, document.book.project.title, entry.id);
          publishRecents();
        }
      } else throw new Error('Unknown recent-book action.');
      return { value: null };
    } catch (error) { return { error: errorMessage(error) }; }
  });
  ipcMain.handle(channels.documentAction, (event, action: 'reveal' | 'template' | 'text', id?: string) => fromEditor(event, async (document) => {
    await openDocumentLocation(document, action, id);
  }));
  ipcMain.handle(channels.sourceAction, (event, request: SourceAction) => fromEditor(event, async (document) => {
    const source = sourceEntries(document.book).find((entry) => entry.key === request.key);
    if (document.book.readOnly) throw new Error('Create an editable book first.');
    let next = document.book;
    let message: string | undefined;
    if (request.action === 'retry') return { summary: await document.reload() };
    if (request.action === 'collect') next = await collectSources(document.book);
    else if (request.action === 'locate-folder') {
      const choice = await dialog.showOpenDialog(document.window, { title: 'Locate Missing Sources in Folder', properties: ['openDirectory'] });
      if (!choice.canceled && choice.filePaths[0]) {
        const result = await relinkFolder(document.book, choice.filePaths[0]);
        next = result.book;
        const names = new Map(sourceEntries(document.book).map((entry) => [entry.key as string, basename(entry.path)]));
        message = result.repaired + ' sources located.' + (result.ambiguous.length ? ' Multiple matches need Locate… for: ' + result.ambiguous.map((key) => names.get(key) ?? 'a source').join(', ') : '');
      }
    } else {
      if (!source) throw new Error('Choose a registered source.');
      if (request.action === 'reveal') {
        shell.showItemInFolder(await originalPath(document.book.folder, source));
        return { summary: document.summary };
      }
      if (request.action === 'copy') next = await relocateSource(document.book, source.key, undefined, true);
      else if (request.action === 'locate' || request.action === 'replace') {
        if (source.kind === 'file' && !request.accept?.length) throw new Error('This template does not declare a compatible file parameter.');
        const choice = await dialog.showOpenDialog(document.window, { title: request.action === 'replace' ? 'Replace Original' : 'Locate Original', properties: ['openFile'],
          filters: [{ name: source.kind === 'photo' ? 'Photos' : 'Source', extensions: source.kind === 'photo' ? ['jpg', 'jpeg', 'png', 'webp'] : source.kind === 'file' ? request.accept!.map((extension) => extension.slice(1)) : ['md'] }] });
        if (!choice.canceled && choice.filePaths[0]) next = await relocateSource(document.book, source.key, choice.filePaths[0], false, request.accept);
      } else throw new Error('Unknown source action.');
    }
    document.projectSession.record(next, 'Source location changed', false);
    return { summary: document.activate(next), message };
  }));
  ipcMain.handle(channels.saveCopy, (event, includeAssets: boolean) => fromEditor(event, async (document) => {
    if (typeof includeAssets !== 'boolean') throw new Error('Choose whether to include all assets.');
    const choice = await dialog.showSaveDialog(document.window, { title: 'Save a Copy', buttonLabel: 'Save Copy',
      defaultPath: join(app.getPath('documents'), document.book.project.title + ' Copy.imageflow'), filters: [{ name: 'ImageFlow Book', extensions: ['imageflow'] }] });
    if (choice.canceled || !choice.filePath) return null;
    const folder = await saveDocumentCopy(document.book, choice.filePath, includeAssets);
    await openDocument(folder);
    return null;
  }));
  ipcMain.handle(channels.settings, (event) => appOwner(event) ? { value: settings.value } : { error: 'Request is only available to an app window.' });
  ipcMain.handle(channels.updateSettings, async (event, patch: unknown) => {
    if (!appOwner(event)) return { error: 'Request is only available to an app window.' };
    try {
      const value = await settings.update(patch);
      nativeTheme.themeSource = value.appearance;
      for (const owner of appWindows()) if (!owner.isDestroyed()) owner.webContents.send(channels.settingsChanged, value);
      return { value };
    } catch (error) { return { error: errorMessage(error) }; }
  });
  ipcMain.handle(channels.save, (event, id: string, files: ProjectFiles, label?: string) => fromEditor(event, async (document) => {
    document.currentBook(id);
    return document.activate(await document.projectSession.save(files, typeof label === 'string' ? label : 'Book edit'));
  }));
  ipcMain.handle(channels.history, (event, id: string, direction: 'undo' | 'redo') => fromEditor(event, async (document) => {
    document.currentBook(id);
    if (direction !== 'undo' && direction !== 'redo') throw new Error('Unknown history action.');
    return document.activate(await document.projectSession.undo(direction));
  }));
  ipcMain.handle(channels.showSettings, (event, pane: SettingsPane) => { if (appOwner(event) && (pane === 'general' || pane === 'agents')) showSettings(pane); });
  ipcMain.handle(channels.settingsPane, (event) => settingsOwner(event) ? settingsPane : 'general');
  ipcMain.handle(channels.fitSettings, (event, height: number) => {
    const owner = settingsOwner(event);
    if (!owner || typeof height !== 'number' || !Number.isFinite(height)) return;
    const [width] = owner.getContentSize();
    owner.setContentSize(width, Math.round(Math.min(Math.max(height, 120), 760)), process.platform === 'darwin');
  });
  ipcMain.handle(channels.mcp, async (event, enabled?: boolean) => {
    if (!appOwner(event)) return { error: 'Request is only available to an app window.' };
    try {
      if (enabled !== undefined && typeof enabled !== 'boolean') throw new Error('Invalid connection setting.');
      const update = connectionSettingsQueue.then(async () => {
        if (enabled === true && !mcpConnection) await enableMcp();
        if (enabled === false) await disableMcp();
      });
      connectionSettingsQueue = update.catch(() => {});
      await update;
      return { value: mcpSettings() };
    } catch (error) { return { error: errorMessage(error) }; }
  });
  ipcMain.handle(channels.mcpInstall, async (event, target: McpClientTarget) => {
    if (!settingsOwner(event)) return { error: 'Request is only available to Settings.' };
    try { return { value: await installMcp(target) }; }
    catch (error) { return { error: errorMessage(error) }; }
  });
  ipcMain.on(channels.agentLeaseReply, (event, id: string, allowed: boolean) => { editorOwner(event)?.replyLease(id, allowed); });
  ipcMain.handle(channels.import, (event, id: string, request: ImportRequest) => fromEditor(event, (document) => document.importFiles(document.window, id, request)));
  ipcMain.handle(channels.export, (event, id: string, mode: ExportMode) => fromEditor(event, (document) => document.exportBook(document.window, id, mode)));
  ipcMain.handle(channels.cancel, (event) => { editorOwner(event)?.cancelExport(); });
  ipcMain.handle(channels.check, (event, id: string, request: AuthoringCheckRequest) => fromEditor(event, (document) => document.checkOpenBook(document.currentBook(id), request)));
  ipcMain.handle(channels.cancelCheck, (event) => { editorOwner(event)?.cancelCheck(); });
  ipcMain.handle(channels.panelVisibility, (event, state: { sidebar: boolean; inspector: boolean; layout?: CanvasLayout }) => {
    const document = editorOwner(event);
    if (!document || typeof state?.sidebar !== 'boolean' || typeof state?.inspector !== 'boolean') return;
    document.sidebar = state.sidebar;
    document.inspector = state.inspector;
    const layout = state.layout;
    if (layout && (layout.mode === 'vertical' || layout.mode === 'grid') && gridColumns.some((columns) => columns === layout.columns)) {
      document.layout = { mode: layout.mode, columns: layout.columns };
    }
    updateMenus();
  });
  app.setAboutPanelOptions({ applicationName: 'ImageFlow', applicationVersion: app.getVersion() });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu', submenu: [
      { role: 'about' }, { type: 'separator' },
      { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => showSettings() },
      { label: 'Agent Connections…', click: () => showSettings('agents') },
      { label: 'Show Start Window', click: () => showStart() },
      { type: 'separator' }, { role: 'services' }, { type: 'separator' },
      { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' },
    ] },
    { label: 'File', submenu: [
      menuCommand('New Book…', 'CmdOrCtrl+N', 'new'),
      menuCommand('Open…', 'CmdOrCtrl+O', 'open'),
      menuCommand('Explore a Sample', undefined, 'sample'),
      menuCommand('Reload Book', 'CmdOrCtrl+R', 'reload'),
      menuCommand('Save a Copy…', 'CmdOrCtrl+Shift+S', 'save-copy'),
      menuCommand('Manage Sources…', undefined, 'manage-sources'),
      { type: 'separator' },
      menuCommand('Import Photos…', 'CmdOrCtrl+I', 'import-photos'),
      menuCommand('Import Photo Folder…', 'CmdOrCtrl+Shift+I', 'import-folder'),
      menuCommand('Import Markdown…', undefined, 'import-texts'),
      { type: 'separator' },
      menuCommand('Export Proof PDF…', 'CmdOrCtrl+Shift+E', 'export'),
      menuCommand('Export Print PDF…', undefined, 'print'),
      { type: 'separator' },
      { id: 'reveal-book', label: 'Reveal in Finder', click: (_item, owner) => { const document = focusedDocument(owner); if (document) shell.showItemInFolder(document.book.folder); } },
      { id: 'open-template', label: 'Open Template Folder', click: (_item, owner) => {
        const document = focusedDocument(owner);
        if (document) void document.run(() => openDocumentLocation(document, 'template')).then((result) => { if ('error' in result) report(document.window, result.error); });
      } },
      { type: 'separator' }, { role: 'close' },
    ] },
    { label: 'Edit', submenu: [
      menuCommand('Undo Book Edit', 'CmdOrCtrl+Z', 'undo'),
      menuCommand('Redo Book Edit', 'CmdOrCtrl+Shift+Z', 'redo'),
      { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
    ] },
    { label: 'View', submenu: [
      menuCommand('Hide Sidebar', 'Alt+CmdOrCtrl+1', 'toggle-project', 'sidebar'),
      menuCommand('Hide Inspector', 'Alt+CmdOrCtrl+2', 'toggle-inspector', 'inspector'),
      { type: 'separator' },
      { ...menuCommand('Vertical', undefined, 'layout-vertical'), type: 'radio' },
      { ...menuCommand('Grid', undefined, 'layout-grid'), type: 'radio' },
      { label: 'Grid Columns', id: 'grid-columns', submenu: gridColumns.map((columns) =>
        ({ ...menuCommand(columns === 1 ? '1 Column' : columns + ' Columns', undefined, `grid-columns-${columns}`), type: 'radio' as const })) },
    ] },
    { role: 'windowMenu' },
  ]));
  ready = true;
  const paths = [...new Set([...pendingOpenFiles.splice(0), ...process.argv.filter(isDocument)])];
  if (paths.length) for (const path of paths) await openFromSystem(path);
  else if (devState) {
    try {
      const state = JSON.parse(await readFile(devState, 'utf8')) as { folder: string; readOnly: boolean }[];
      for (const entry of state) await openDocument(entry.folder, entry.readOnly);
    } catch { /* No development documents to restore. */ }
  }
  if (!documents.size) showStart();
  app.on('activate', () => { if (!documents.size && !quitting) showStart(); });
  updateMenus();
});
