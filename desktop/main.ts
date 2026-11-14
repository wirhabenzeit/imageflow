import { commandRegistry, commandState, emptyMenuState } from '../src/commands';
import type { ContextMenuItem, ContextMenuResult } from '../src/desktop';
import type { RegisteredCommand } from '../src/commands';
import { bookName } from '../src/book-name';
import { collectSources, relocateSource, relinkFolder, saveDocumentCopy, fileIsAssigned, removeSources } from './source-actions';
import { originalPath } from './source-store';
import { sourceEntries } from '../src/source-locations';
import { configureSourceStore, pruneSourceCache, SourceStore } from './source-store';
import { configureSourceAccess } from './source-access';
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, net, powerMonitor, protocol, shell } from 'electron';
import type { BaseWindow, IpcMainInvokeEvent, MenuItemConstructorOptions } from 'electron';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, isAbsolute, parse } from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { channels, gridColumns, spreadCommands, desktopScheme, editorURL, renderOrigin, settingsURL, startURL, starterURL, assetsURL, templatesURL } from '../src/desktop';
import type { BookMenuState, CanvasLayout, Command, ExportMode, ImportRequest, OpenAction, ProjectSummary, Result, McpClientTarget, McpSettings, SourceAction, TemplateInfo } from '../src/desktop';
import type { ProjectFiles } from '../src/project';
import { renderPolicy } from './csp';
import { assetTypes, loadProject, renderData, TemplateCompileError } from './project';
import type { OpenProject } from './project';
import { photoFile } from './photos';
import { captureBookPreview, checkBookRender } from './preview';
import { PreviewError } from '../src/preview';
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
import { copyTemplate, TemplateImportError, TemplateLibrary } from './template-library';
import { TemplateTrust, trustedOrigins } from './template-trust';
import { isTemplateArchive, templateArchiveExtension, writeTemplateArchive } from './template-archive';
import { writeAuthoringSnapshot } from './authoring-sdk';
import type { ImportPlan, ResolvedTemplate } from './template-library';
import { describeImport, templatePicturePath, templatePictureURL } from '../src/library';
import type { LibraryEntry, LibraryImportResult, NewBookChoice } from '../src/library';
import { capabilities } from '../src/runtime-exports';
import { newSpread, openingSpreadStates } from '../src/editing';
import { templateFolder, textSourcePath } from './document-actions';
import { configureRenditionCache, pruneRenditions } from './rendition-cache';
import { decodes, readTemplatePreview } from './template-preview-file';
import { previewTypes } from '../src/template-preview';

const presentationWindows = new WeakMap<BrowserWindow, { simple: boolean; previous: boolean }>();
let templatesWindow: BrowserWindow | null = null;
const assetsWindows = new Map<DocumentSession, { window: BrowserWindow; accept: string[] }>();
let settingsWindow: BrowserWindow | null = null;
const settingsPresentation = new WeakMap<BrowserWindow, { painted: boolean; sized: boolean }>();
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
let library: TemplateLibrary;
let trust: TemplateTrust;
const sessions: RenderSessions = new Map();
const documents = new Map<number, DocumentSession>();
const identities = new Map<string, DocumentSession>();
const opening = new Map<string, Promise<DocumentSession>>();
const closing = new Set<Promise<void>>();
const covers = new Map<DocumentSession, { dirty: boolean; timer?: ReturnType<typeof setTimeout>; job?: AbortController; task?: Promise<void> }>();
const pickers = new Map<number, { window: BrowserWindow }>();
const pendingOpenFiles: string[] = [];
let ready = false;
let lastDocument: DocumentSession | undefined;
const hidden = !!process.env.IMAGEFLOW_HIDE_WINDOW;
const devServer = app.isPackaged ? undefined : process.env.IMAGEFLOW_DEV_SERVER;
const devState = devServer ? process.env.IMAGEFLOW_DEV_STATE : undefined;
const devSample = devServer ? process.env.IMAGEFLOW_DEV_SAMPLE : undefined;
// Packaging renders the built-in templates' opening spreads into this folder and quits (scripts/render-template-previews.mjs).
const renderPreviewsTo = app.isPackaged ? undefined : process.env.IMAGEFLOW_RENDER_TEMPLATE_PREVIEWS;
const sampleRoot = devSample ?? (renderPreviewsTo ? process.env.IMAGEFLOW_SAMPLE : undefined);
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
  const paths = argv.filter(isSystemFile);
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
  const { host, pathname } = new URL(request.url);
  if (host !== 'editor' && host !== 'render') return new Response(null, { status: 404 });
  const picture = host === 'render' && /^\/render\/([a-f0-9-]{36})\/picture\/([a-f0-9]{64})$/.exec(pathname);
  if (picture) {
    const session = sessions.get(picture[1]);
    if (session?.mode !== 'edit' || !session.pictures || !session.book.templateHash) return new Response(null, { status: 404 });
    const scope = JSON.stringify([session.book.templateHash, session.network?.() ?? []]);
    if (session.pictureScope !== scope) return new Response(null, { status: 404 });
    return session.pictures.respond(request, scope, picture[2]);
  }
  if (request.method !== 'GET') return new Response(null, { status: 405 });
  const dist = join(app.getAppPath(), 'dist');
  if (!devServer && /^\/assets\/[\w.-]+\.[a-z0-9]+$/i.test(pathname)) return net.fetch(pathToFileURL(join(dist, pathname)).href);
  const templatePicture = host === 'editor' && templatePicturePath.exec(pathname);
  if (templatePicture) {
    // A template's preview image or saved render, for New Book and Templates. Both are tied to the template's hash.
    const file = await library.pictureFile(templatePicture[1], templatePicture[2] as 'image' | 'render');
    if (!file) return new Response(null, { status: 404 });
    const bytes = await readFile(file);
    return response(bytes, previewTypes[extname(file).toLowerCase()] ?? 'application/octet-stream', { 'Cache-Control': 'no-cache' });
  }
  if (host === 'editor' && ['/', '/settings', '/start', '/new', '/assets', '/templates'].includes(pathname)) {
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
    // The frames of a book whose template declares network origins may reach the ones the user allowed: element
    // editors, and previews, checks and exports that draw <RenderedImage> pictures (ADR 0006).
    const origins = session.network?.() ?? [];
    // Network preparation finishes after the session is activated. Scope its pictures to the policy actually
    // served to the frame, so an already-approved book can cache its first preview as well as later saves.
    session.pictureScope ??= JSON.stringify([session.book.templateHash, origins]);
    return response(await pageHtml(dist), 'text/html; charset=utf-8', {
      'Content-Security-Policy': renderPolicy(csp, origins) + '; frame-ancestors ' + editorURL + "; base-uri 'self'",
    });
  }
  if (resource === 'data') return Response.json(renderData(session.book, id, session.mode));
  if (resource === 'template-preview') {
    // The Book check of the template's own preview image: the frame names the declared path, the app reads the file.
    const { file: _file, ...report } = await readTemplatePreview(join(session.book.folder, 'template'), new URL(request.url).searchParams.get('path') ?? '');
    return Response.json(report);
  }
  if (resource.startsWith('template/')) {
    const asset = resource.slice('template/'.length);
    const bytes = session.book.assets.files.get(asset);
    if (bytes) return response(bytes, assetTypes[extname(asset).toLowerCase()] ?? 'application/octet-stream');
  }
  const photoMatch = /^(photo|proof-photo|thumb)\/([\w-]+)(?:\/([1-9]\d{0,5}))?$/.exec(resource);
  if (photoMatch) {
    const [, kind, photoId, size] = photoMatch;
    const photo = session.book.photos.get(photoId);
    const rendition = kind === 'thumb' ? 'thumb' : kind === 'proof-photo' ? 'export' : session.mode === 'edit' ? 'preview' : 'export';
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
function assetsOwner(event: RendererEvent) {
  return [...assetsWindows].find(([, entry]) => trusted(event, entry.window, assetsURL))?.[0];
}
function templatesOwner(event: IpcMainInvokeEvent) { return trusted(event, templatesWindow, templatesURL) ? templatesWindow : undefined; }
async function fromBook<T>(event: IpcMainInvokeEvent, run: (document: DocumentSession) => Promise<T>): Promise<Result<T>> {
  const document = editorOwner(event) ?? assetsOwner(event);
  if (!document || quitting) return { error: 'Request is only available to an open book.' };
  return document.run(() => run(document));
}
function settingsOwner(event: IpcMainInvokeEvent) { return trusted(event, settingsWindow, settingsURL) ? settingsWindow : undefined; }
function pickerOwner(event: IpcMainInvokeEvent) { return [...pickers.values()].find((entry) => trusted(event, entry.window, starterURL))?.window; }
function startOwner(event: IpcMainInvokeEvent) { return trusted(event, startWindow, startURL) ? startWindow : undefined; }
function appOwner(event: IpcMainInvokeEvent) { return editorOwner(event)?.window ?? startOwner(event) ?? settingsOwner(event) ?? templatesOwner(event); }
async function fromEditor<T>(event: IpcMainInvokeEvent, run: (document: DocumentSession) => Promise<T>): Promise<Result<T>> {
  const document = editorOwner(event);
  if (!document || quitting) return { error: 'Request is only available to an open book.' };
  return document.run(() => run(document));
}
function focusedDocument(owner: BaseWindow | null | undefined = BrowserWindow.getFocusedWindow()) {
  const browser = owner ? BrowserWindow.fromId(owner.id) : undefined;
  return browser ? documents.get(browser.webContents.id) ?? [...assetsWindows].find(([, entry]) => entry.window === browser)?.[0] : lastDocument && !lastDocument.closing ? lastDocument : undefined;
}
function report(owner: BrowserWindow | null | undefined, error: unknown) {
  if (owner && !owner.isDestroyed()) owner.webContents.send(channels.appError, errorMessage(error));
  else { showStart(); startWindow?.webContents.once('did-finish-load', () => report(startWindow, error)); }
}
function sampleFolder(name: string) {
  return sampleRoot ? join(sampleRoot, name) : app.isPackaged ? join(process.resourcesPath, 'sample', name) : join(app.getAppPath(), 'sample', name);
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
  owner.webContents.on('context-menu', (_event, params) => {
    if (!params.isEditable) return;
    const suggestions: MenuItemConstructorOptions[] = params.misspelledWord ? [
      ...params.dictionarySuggestions.map((suggestion) => ({ label: suggestion, click: () => owner.webContents.replaceMisspelling(suggestion) })),
      { label: 'Add to Dictionary', click: () => owner.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord) },
      { type: 'separator' },
    ] : [];
    Menu.buildFromTemplate([...suggestions, { role: 'cut', enabled: params.editFlags.canCut },
      { role: 'copy', enabled: params.editFlags.canCopy }, { role: 'paste', enabled: params.editFlags.canPaste },
      { type: 'separator' }, { role: 'selectAll', enabled: params.editFlags.canSelectAll }]).popup({ window: owner });
  });
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
function showTemplates() {
  if (quitting) return;
  if (templatesWindow && !templatesWindow.isDestroyed()) { focus(templatesWindow); return; }
  const owner = new BrowserWindow({ title: 'Templates', width: 760, height: 560, minWidth: 580, minHeight: 400,
    show: false, webPreferences: windowOptions() });
  templatesWindow = owner;
  secureWindow(owner);
  owner.webContents.on('will-frame-navigate', (event) => event.preventDefault());
  owner.once('ready-to-show', () => focus(owner));
  owner.once('closed', () => { if (templatesWindow === owner) templatesWindow = null; });
  void owner.loadURL(templatesURL).catch((error) => report(owner, error));
}
function showAssets(document: DocumentSession, accept: string[]) {
  const current = assetsWindows.get(document);
  if (current && !current.window.isDestroyed()) { current.accept = accept; focus(current.window); return; }
  const owner = new BrowserWindow({ title: 'Assets — ' + bookName(document.book.folder), width: 760, height: 480,
    minWidth: 560, minHeight: 340, show: false, parent: document.window, webPreferences: windowOptions() });
  assetsWindows.set(document, { window: owner, accept });
  secureWindow(owner);
  owner.webContents.on('will-frame-navigate', (event) => event.preventDefault());
  owner.on('focus', () => { lastDocument = document; updateMenus(); });
  owner.once('ready-to-show', () => focus(owner));
  owner.once('closed', () => { if (assetsWindows.get(document)?.window === owner) assetsWindows.delete(document); });
  void owner.loadURL(assetsURL).catch((error) => report(owner, error));
}
function publishAssets(document: DocumentSession) {
  const owner = assetsWindows.get(document)?.window;
  if (owner && !owner.isDestroyed() && !document.closing) {
    owner.setTitle('Assets — ' + bookName(document.book.folder));
    owner.webContents.send(channels.changed, { value: document.summary });
  }
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
    sessions.set(id, { book, mode: 'export', network: () => document.networkOrigins });
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
        if (document) queueMicrotask(() => { if (document) publishAssets(document); });
        if (document && !next.readOnly) {
          void recents.refresh(next.folder, next.project.title).then(publishRecents).catch((error) => console.warn('ImageFlow could not update recent books', error));
          markCoverDirty(document);
        }
      });
      document.networkTrust = bookNetworkTrust;
      // Frames may reach what is already allowed from the first render on, without a question (ADR 0006).
      await document.prepareNetwork().catch((error) => console.warn('ImageFlow could not read network approvals', error));
      const current = document;
      const webContentsId = editor.webContents.id;
      documents.set(webContentsId, document);
      identities.set(identity, document);
      lastDocument = document;
      editor.on('focus', () => { lastDocument = current; updateMenus(); });
      editor.on('blur', () => { if (covers.get(current)?.dirty) scheduleCover(current, current.book); });
      editor.on('closed', () => {
        documents.delete(webContentsId);
        assetsWindows.get(current)?.window.destroy();
        assetsWindows.delete(current);
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
            for (const [key, value] of identities) if (value === current) identities.delete(key);
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
// Books and `.imageflow-template` files are what the system hands the app; a template file is imported.
const isSystemFile = (path: string) => isDocument(path) || isTemplateArchive(path);
async function openFromSystem(path: string) {
  if (isTemplateArchive(path)) {
    void importTemplate(undefined, path).then((result) => reportImports(lastDocument?.window ?? startWindow ?? undefined, [result], true))
      .catch((error) => report(startWindow ?? lastDocument?.window, error));
    return;
  }
  try { await openDocument(path); }
  catch (error) { report(startWindow ?? lastDocument?.window, error); }
}
function chooseStarter() {
  const existing = pickers.get(0);
  if (existing && !existing.window.isDestroyed()) { focus(existing.window); return; }
  const size = settings.value.newBookSize ?? { width: 720, height: 560 };
  const picker = new BrowserWindow({ title: 'New Book', ...size, minWidth: 560, minHeight: 420, show: false, webPreferences: windowOptions() });
  secureWindow(picker);
  picker.webContents.on('will-frame-navigate', (event) => event.preventDefault());
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  picker.on('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (picker.isDestroyed()) return;
      const [width, height] = picker.getSize();
      void settings.update({ newBookSize: { width, height } }).catch(() => {});
    }, 250);
  });
  pickers.set(0, { window: picker });
  picker.once('closed', () => { clearTimeout(resizeTimer); if (pickers.get(0)?.window === picker) pickers.delete(0); });
  picker.once('ready-to-show', () => focus(picker));
  void picker.loadURL(starterURL).catch((error) => report(picker, error));
}
async function createNewBook(owner: BrowserWindow, selected: NewBookChoice, closeOwner = true) {
  const template = await library.resolve(selected.id);
  const choice = await dialog.showSaveDialog(owner, { title: 'New Book', buttonLabel: 'Create',
    defaultPath: join(app.getPath('documents'), (template.defaultName ?? 'Untitled ' + template.entry.label) + '.imageflow'),
    filters: [{ name: 'ImageFlow Book', extensions: ['imageflow'] }] });
  if (choice.canceled || !choice.filePath || owner.isDestroyed()) return false;
  const folder = await createDocument(documentPath(choice.filePath),
    (stage) => library.withTemplate(selected.id, (current) => createBook(stage, current, selected.sample)));
  await openDocument(folder);
  if (closeOwner) owner.close();
  return true;
}
// Fills a new book's staging folder from a library template: its sample book, or the template's own copy with its
// opening spreads and no content. Either way `project.json` records the template's hash.
async function createBook(stage: string, template: ResolvedTemplate, sample: boolean) {
  const { entry, folder, info } = template;
  const file = join(stage, 'project.json');
  if (sample && template.sample) {
    await cp(template.sample, stage, { recursive: true, filter: (path) => basename(path) !== '.imageflow' && basename(path) !== 'node_modules' });
    const project = JSON.parse(await readFile(file, 'utf8'));
    project.template = { ...project.template, hash: entry.hash };
    await writeFile(file, JSON.stringify(project, null, 2) + '\n');
    await writeAuthoringSnapshot(join(stage, 'template'), join(__dirname, 'authoring-types'));
    return;
  }
  await copyTemplate(folder, join(stage, 'template'));
  await writeAuthoringSnapshot(join(stage, 'template'), join(__dirname, 'authoring-types'));
  await Promise.all(['photos', 'texts', 'files'].map((name) => mkdir(join(stage, name))));
  await writeFile(join(stage, 'photos.json'), '{}\n');
  await writeFile(file, JSON.stringify({
    schemaVersion: 1, title: 'Untitled', template: { id: entry.id, version: entry.version, hash: entry.hash },
    params: {}, texts: {}, files: {}, spreads: openingSpreadStates(info),
  }, null, 2) + '\n');
}

// Renders of a template's opening spread, keyed by content hash. Rendering is serialized so opening a library does not
// launch one hidden browser per card; an offline or empty template keeps the neutral cover placeholder. A render with
// every site the template declares is saved in the library (`persist`), so later launches show it at once; one made
// offline is only kept until the app quits.
const templatePreviews = new Map<string, Promise<string | null>>();
const previewJobs = new Map<string, AbortController>();
let previewQueue: Promise<unknown> = Promise.resolve();
function templatePreview(id: string, hash: string, origins: string[], persist = false) {
  const key = JSON.stringify([hash, origins]);
  const existing = templatePreviews.get(key);
  if (existing) return existing;
  const controller = new AbortController();
  previewJobs.set(key, controller);
  const task = previewQueue.then(async () => {
    if (controller.signal.aborted) return null;
    const stage = await mkdtemp(join(cache, 'template-preview-'));
    const session = randomUUID();
    try {
      await library.withTemplate(id, async (template) => {
        if (template.entry.hash !== hash) throw new Error('Template changed.');
        await createBook(stage, template, true);
        const file = join(stage, 'project.json');
        const project = JSON.parse(await readFile(file, 'utf8'));
        if (!project.spreads.length) {
          const first = Object.keys(template.info.spreads)[0];
          if (!first) return [];
          project.spreads = [newSpread(first)];
          await writeFile(file, JSON.stringify(project));
        }
      });
      const book = await loadProject(stage, cache, true);
      const first = book.project.spreads[0];
      if (!first) return null;
      sessions.set(session, { book, mode: 'export', network: () => origins });
      let preview = await captureBookPreview(renderOrigin + '/render/' + session,
        { target: { spread: first.id }, maxEdge: 320, format: 'jpeg' }, controller.signal);
      // A blank opening page says little about a template. Prefer an illustrated sample spread in that case.
      const pixels = await sharp(preview.bytes).stats();
      if (pixels.channels.every(({ stdev }) => stdev < .75)) {
        const illustrated = book.project.spreads.find((spread) => spread.id !== first.id &&
          Object.values(spread.boxes).some(({ photo }) => !!photo && book.photos.has(photo)));
        if (illustrated) preview = await captureBookPreview(renderOrigin + '/render/' + session,
          { target: { spread: illustrated.id }, maxEdge: 320, format: 'jpeg' }, controller.signal);
      }
      // A picture that failed to draw, such as a map while its server is unreachable, is shown but never saved: the
      // next session renders again.
      if (persist && !controller.signal.aborted && !preview.status.errors.some(({ code }) => code && incompleteRender.has(code))) await library.saveRender(hash, preview.bytes).catch((error) => console.warn('ImageFlow could not save a template preview', error));
      return 'data:image/jpeg;base64,' + Buffer.from(preview.bytes).toString('base64');
    } catch { return null; }
    finally {
      sessions.delete(session);
      await SourceStore.release(stage);
      await rm(stage, { recursive: true, force: true });
    }
  });
  templatePreviews.set(key, task);
  const finished = () => { if (previewJobs.get(key) === controller) previewJobs.delete(key); };
  void task.then(finished, finished);
  if (templatePreviews.size > 24) templatePreviews.delete(templatePreviews.keys().next().value!);
  previewQueue = task.catch(() => {});
  return task;
}
// Book check errors that mean a render is missing something the template draws, so it must not be saved.
const incompleteRender = new Set(['rendered-image-failed', 'layout-render-failed', 'photo-decode-failed', 'source-unavailable', 'render-impure']);
/** Whether a render of this entry with these sites would show everything the template draws, so it may be saved. */
const completeRender = (entry: LibraryEntry, origins: readonly string[]) => (entry.network ?? []).every((origin) => origins.includes(origin));
/** Renders an entry's opening spread and saves it, unless the library already has a saved render for its hash. */
async function saveTemplatePreview(id: string) {
  const entry = (await library.list()).find((item) => item.id === id);
  if (!entry || entry.unavailable || entry.render) return;
  const origins = await bookNetworkTrust(entry.hash, entry.network);
  if (completeRender(entry, origins)) await templatePreview(entry.id, entry.hash, origins, true);
}
function invalidateTemplatePreviews(hash: string) {
  for (const key of new Set([...templatePreviews.keys(), ...previewJobs.keys()])) {
    if (JSON.parse(key)[0] !== hash) continue;
    previewJobs.get(key)?.abort();
    templatePreviews.delete(key);
  }
}

// Loads a template in a hidden renderer, the way a book loads it, to read and check its declarations. The ID is
// not known in advance: a first pass reads it from the declaration, a second loads the template under that ID.
async function probeTemplate(templateFolder: string): Promise<TemplateInfo> {
  const book = await mkdtemp(join(cache, 'template-check-'));
  const failure = (error: PreviewError) => new TemplateImportError(error.message, [
    ...(error.failure?.declarationIssues ?? []).map(({ path, message }) => (path ? path + ': ' : '') + message),
    ...(error.failure?.layoutFailures ?? []).map(({ spread, message }) => spread + ': ' + message),
  ].slice(0, 20));
  try {
    await copyTemplate(templateFolder, join(book, 'template'));
    await writeFile(join(book, 'photos.json'), '{}\n');
    type Rendered = { status: Awaited<ReturnType<typeof checkBookRender>> } | { error: PreviewError };
    const render = async (id: string, version: string): Promise<Rendered> => {
      await writeFile(join(book, 'project.json'), JSON.stringify({ schemaVersion: 1, title: 'Template check', template: { id, version }, params: {}, spreads: [] }));
      let loaded: OpenProject;
      try { loaded = await loadProject(book, cache, true); }
      catch (error) {
        if (!(error instanceof TemplateCompileError)) throw error;
        throw new TemplateImportError('The template could not be compiled.', error.diagnostics.slice(0, 20).map(({ message, location }) =>
          (location?.path ? location.path + (location.line ? ':' + location.line : '') + ': ' : '') + message));
      }
      const session = randomUUID();
      sessions.set(session, { book: loaded, mode: 'export' });
      try { return { status: await checkBookRender(renderOrigin + '/render/' + session) }; }
      catch (error) {
        if (error instanceof PreviewError) return { error };
        throw error;
      } finally { sessions.delete(session); }
    };
    const probe = 'template-check';
    const first = await render(probe, '0');
    const declared = 'status' in first ? first.status.template : first.error.template;
    if (!declared?.id) throw 'error' in first ? failure(first.error) : new TemplateImportError('The template did not report its ID.');
    const checked = declared.id === probe ? first : await render(declared.id, declared.version);
    if ('error' in checked) throw failure(checked.error);
    return checked.status.template;
  } finally {
    await rm(book, { recursive: true, force: true });
  }
}

async function confirmReplace(owner: BrowserWindow | undefined, plan: ImportPlan) {
  const name = plan.info.label ?? plan.info.id ?? 'This template';
  const options = {
    type: 'question' as const, buttons: ['Replace', 'Cancel'], defaultId: 1, cancelId: 1,
    message: plan.kind === 'older'
      ? 'Replace ' + name + ' ' + plan.current!.version + ' with the older version ' + plan.info.version + '?'
      : 'Replace ' + name + ' ' + plan.info.version + ' with a different template of the same version?',
    detail: plan.kind === 'changed' ? 'Use a new version number for a changed template.' : undefined,
  };
  const { response } = owner && !owner.isDestroyed() ? await dialog.showMessageBox(owner, options) : await dialog.showMessageBox(options);
  return response === 0;
}

/**
 * Shows what a template brings beyond the app before it enters the library (ADR 0006): its bundled npm packages and
 * the sites its element editors connect to. The user may allow those sites for this exact version at once.
 */
async function reviewImport(owner: BrowserWindow | undefined, plan: ImportPlan) {
  const network = plan.info.network ?? [];
  const name = (plan.info.label ?? plan.info.id) + ' ' + plan.info.version;
  const detail = [
    ...(plan.packages.length ? ['It includes these npm packages, bundled into the template:',
      ...plan.packages.map(({ name, version, license }) => '  ' + name + ' ' + version + (license ? ' (' + license + ')' : '')), ''] : []),
    ...(network.length ? ['To draw its pages and editors, while you edit and when you export, it connects to:', ...network.map((origin) => '  ' + origin),
      'It can send what you edit there. Exporting books made from it needs these sites.', ''] : []),
    'Templates contain code: only import templates from people you trust.',
  ].join('\n');
  const options = {
    type: 'question' as const, buttons: ['Import', 'Cancel'], defaultId: 0, cancelId: 1,
    message: 'Import ' + name + '?', detail,
    ...(network.length ? { checkboxLabel: 'Allow these sites in every book made from this version', checkboxChecked: false } : {}),
  };
  const { response, checkboxChecked } = owner && !owner.isDestroyed() ? await dialog.showMessageBox(owner, options) : await dialog.showMessageBox(options);
  return { ok: response === 0, allow: response === 0 && network.length > 0 && !!checkboxChecked };
}

/** Imports one template into the library, reviewing it first and remembering network trust the user gave. */
async function importTemplate(owner: BrowserWindow | undefined, path: string) {
  let allowed: ImportPlan | undefined;
  const result = await library.import(path, (plan) => confirmReplace(owner, plan), async (plan) => {
    const review = await reviewImport(owner, plan);
    if (review.allow) allowed = plan;
    return review.ok;
  });
  if (allowed && (result.status === 'imported' || result.status === 'replaced')) {
    await trust.allow(allowed.hash, allowed.info.network ?? [], { id: allowed.info.id ?? '', version: allowed.info.version }).catch((error) => console.warn('ImageFlow could not save template trust', error));
    // Lists already showing the new entry learn that it is trusted.
    publishLibrary();
  }
  // Rendered once now, so New Book shows the template at once from then on.
  if (result.id && (result.status === 'imported' || result.status === 'replaced')) {
    void saveTemplatePreview(result.id).catch((error) => console.warn('ImageFlow could not render a template preview', error));
  }
  return result;
}

/**
 * The sites a book's frames may reach without asking, because its template, as it is now, is trusted: those of
 * `declared`, or before the template has rendered, all the trust covers.
 */
async function bookNetworkTrust(hash: string, declared?: readonly string[]) {
  const builtIn = await library.builtInNetwork(hash);
  const allowed = builtIn ?? await trust.allowed(hash);
  return declared ? trustedOrigins(declared, { builtIn: builtIn !== undefined, allowed }) : allowed;
}

/** Library entries with why their network access needs no question, for Manage Templates and New Book. */
async function libraryWithTrust() {
  return Promise.all((await library.list()).map(async (entry) => {
    if (!entry.network?.length) return entry;
    if (entry.source === 'built-in') return { ...entry, networkTrust: 'built-in' as const };
    const allowed = new Set(await trust.allowed(entry.hash));
    return entry.network.every((origin) => allowed.has(origin)) ? { ...entry, networkTrust: 'allowed' as const } : entry;
  }));
}

/** Imports chosen folders or archives, with the code/trust warning in the import confirmation. */
async function importTemplates(owner: BrowserWindow | undefined, paths?: string[]): Promise<LibraryImportResult[]> {
  const options = { title: 'Import Templates', buttonLabel: 'Import',
    message: 'Choose template folders or .imageflow-template files.',
    filters: [{ name: 'ImageFlow Template', extensions: [templateArchiveExtension.slice(1)] }],
    properties: ['openDirectory', 'openFile', 'multiSelections'] as ('openDirectory' | 'openFile' | 'multiSelections')[] };
  const choice = paths ? { canceled: false, filePaths: paths } : owner && !owner.isDestroyed() ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
  if (choice.canceled) return [];
  const results: LibraryImportResult[] = [];
  for (const path of choice.filePaths) results.push(await importTemplate(owner, path));
  return results;
}

async function reportImports(owner: BrowserWindow | undefined, results: LibraryImportResult[], offerLibrary = false) {
  if (!results.length) return;
  const failed = results.filter(({ status }) => status === 'failed');
  const options = {
    type: failed.length ? 'warning' as const : 'info' as const,
    buttons: offerLibrary && failed.length < results.length ? ['OK', 'Show Templates'] : ['OK'], defaultId: 0,
    message: results.length === 1 ? describeImport(results[0]) : results.length - failed.length + ' of ' + results.length + ' templates imported.',
    detail: [...(results.length > 1 ? results.map(describeImport) : []), ...failed.flatMap(({ details }) => details ?? [])].join('\n'),
  };
  const { response } = owner && !owner.isDestroyed() ? await dialog.showMessageBox(owner, options) : await dialog.showMessageBox(options);
  if (response === 1) showTemplates();
}

/** Asks where to save a template file. The name says which template and version it holds. */
async function chooseTemplateFile(owner: BrowserWindow, name: string) {
  const choice = await dialog.showSaveDialog(owner, { title: 'Export Template', buttonLabel: 'Export',
    defaultPath: join(app.getPath('documents'), name.replace(/[/\\:]/g, '-') + templateArchiveExtension),
    filters: [{ name: 'ImageFlow Template', extensions: [templateArchiveExtension.slice(1)] }] });
  return choice.canceled || !choice.filePath ? undefined
    : isTemplateArchive(choice.filePath) ? choice.filePath : choice.filePath + templateArchiveExtension;
}

function publishLibrary() {
  for (const owner of [...appWindows(), ...[...pickers.values()].map(({ window }) => window)]) {
    if (!owner.isDestroyed()) owner.webContents.send(channels.libraryChanged);
  }
}

async function openProject(owner: BrowserWindow, action: OpenAction, document?: DocumentSession): Promise<ProjectSummary | null> {
  if (action === 'reload') {
    if (!document) throw new Error('Open a book first.');
    const result = await document.run(() => document.reload());
    if ('error' in result) throw new Error(result.error);
    return result.value;
  }
  if (action === 'new') { chooseStarter(); return null; }
  if (action !== 'open') throw new Error('Unknown document action.');
  const choice = await dialog.showOpenDialog(owner, { title: 'Open ImageFlow Book', properties: ['openFile'],
    filters: [{ name: 'ImageFlow Book', extensions: ['imageflow'] }] });
  if (choice.canceled || !choice.filePaths[0] || owner.isDestroyed()) return null;
  await openDocument(choice.filePaths[0]);
  return null;
}
async function moveBook(document: DocumentSession, renameOnly: boolean) {
  const original = document.book.folder;
  const choice = renameOnly
    ? await dialog.showSaveDialog(document.window, { title: 'Rename Book', buttonLabel: 'Rename', defaultPath: original,
      filters: [{ name: 'ImageFlow Book', extensions: ['imageflow'] }] })
    : await dialog.showOpenDialog(document.window, { title: 'Move Book To', buttonLabel: 'Move', properties: ['openDirectory', 'createDirectory'] });
  const destination = 'filePath' in choice ? choice.filePath && documentPath(choice.filePath)
    : choice.filePaths[0] ? join(choice.filePaths[0], basename(original)) : undefined;
  if (choice.canceled || !destination || destination === original) return;
  const oldRecent = (await recents.list()).find(({ path }) => path === original);
  const result = await document.run(async () => {
    await document.moveTo(destination);
    const identity = await documentIdentity(document.book.folder);
    for (const [key, value] of identities) if (value === document) identities.delete(key);
    identities.set(identity.identity, document);
    await recents.remember(document.book.folder, bookName(document.book.folder), oldRecent?.id);
    app.addRecentDocument(document.book.folder); publishRecents(); await saveDevState();
  });
  if ('error' in result) throw new Error(result.error);
}
async function revertOpened(document: DocumentSession) {
  const choice = await dialog.showMessageBox(document.window, { type: 'question', message: 'Restore the opening content and settings?',
    buttons: ['Restore', 'Cancel'], defaultId: 1, cancelId: 1 });
  if (choice.response !== 0) return;
  const result = await document.run(async () => document.notify({ value: document.activate(await document.projectSession.revertOpened()) }));
  if ('error' in result) throw new Error(result.error);
}
function installMenu() {
  const registered = (id: RegisteredCommand, command: Command | undefined = id as Command, type?: 'checkbox' | 'radio'): MenuItemConstructorOptions => {
    const item = commandState(id, emptyMenuState);
    return { ...item, type, acceleratorWorksWhenHidden: false, click: (_item, owner) => {
      const document = focusedDocument(owner);
      if (!document || !commandState(id, document.menuState ?? emptyMenuState).enabled) return;
      if ((id === 'undo' || id === 'redo') && owner === assetsWindows.get(document)?.window) {
        void document.run(async () => document.notify({ value: document.activate(await document.projectSession.undo(id)) }))
          .then((result) => { if ('error' in result) report(owner as BrowserWindow, new Error(result.error)); });
      }
      else if (id === 'reveal-book') shell.showItemInFolder(document.book.folder);
      else if (id === 'rename-book' || id === 'move-book') void moveBook(document, id === 'rename-book').catch((error) => report(document.window, error));
      else if (id === 'revert-opened') void revertOpened(document).catch((error) => report(document.window, error));
      else if (command) {
        const target = command.startsWith('photos-') && owner === assetsWindows.get(document)?.window ? assetsWindows.get(document)!.window : document.window;
        target.webContents.send(channels.command, command);
      }
    } };
  };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu', submenu: [
      { role: 'about' }, { type: 'separator' },
      { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => showSettings() },
      { type: 'separator' }, { role: 'services' }, { type: 'separator' },
      { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' },
    ] },
    { label: 'File', submenu: [
      { label: 'New Book…', accelerator: 'CmdOrCtrl+N', click: () => chooseStarter() },
      { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: (_item, owner) => {
        const window = owner ? BrowserWindow.fromId(owner.id) : startWindow;
        if (window) void openProject(window, 'open').catch((error) => report(window, error)); else showStart();
      } },
      { role: 'recentDocuments', submenu: [{ role: 'clearRecentDocuments' }] },
      { type: 'separator' }, { role: 'close' }, registered('save-copy'), registered('rename-book'), registered('move-book'),
      { label: 'Revert To', submenu: [registered('revert-opened'), registered('reload')] },
      { type: 'separator' },
      registered('import'),
      registered('export'), registered('print'), { type: 'separator' }, registered('reveal-book'),
    ] },
    { label: 'Edit', submenu: [
      registered('undo'), registered('redo'),
      { role: 'undo', id: 'native-undo', visible: false, acceleratorWorksWhenHidden: false },
      { role: 'redo', id: 'native-redo', visible: false, acceleratorWorksWhenHidden: false },
      { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'delete' }, { role: 'selectAll' },
    ] },
    { label: 'Book', submenu: [
      registered('add-spread'), registered('duplicate-spread'), registered('delete-spread'),
      { type: 'separator' }, registered('move-spread-up'), registered('move-spread-down'),
      { type: 'separator' }, registered('manage-sources'), registered('copy-assets', 'copy-assets', 'checkbox'),
      { type: 'separator' }, registered('book-check'),
    ] },
    { label: 'Templates', submenu: [{ label: 'Manage Templates…', click: () => showTemplates() }] },
    { label: 'View', submenu: [
      registered('sidebar', 'toggle-project'), registered('inspector', 'toggle-inspector'), registered('sources', 'toggle-sources'),
      { type: 'separator' }, registered('layout-vertical', 'layout-vertical', 'radio'), registered('layout-grid', 'layout-grid', 'radio'),
      { label: 'Columns', id: 'grid-columns', submenu: gridColumns.map((columns) => ({ id: 'grid-columns-' + columns,
        label: columns === 1 ? '1 Column' : columns + ' Columns', type: 'radio' as const,
        click: (_item: Electron.MenuItem, owner?: BaseWindow) => {
          const document = focusedDocument(owner); if (document?.layout.mode === 'grid') document.window.webContents.send(channels.command, `grid-columns-${columns}`);
        } })) },
      registered('guides', 'toggle-guides', 'checkbox'), { type: 'separator' },
      registered('zoom-in'), { ...registered('zoom-in'), id: 'zoom-in-equals', accelerator: 'CmdOrCtrl+=', visible: false, acceleratorWorksWhenHidden: true },
      registered('zoom-out'), registered('zoom-actual'), registered('zoom-fit'),
      { type: 'separator' },
      { label: 'Sort Photos By', submenu: [registered('photos-sort-capture', undefined, 'radio'), registered('photos-sort-name', undefined, 'radio'), registered('photos-sort-import', undefined, 'radio')] },
      { label: 'Group Photos', submenu: [registered('photos-group-none', undefined, 'radio'), registered('photos-group-day', undefined, 'radio'),
        { label: 'By Time Gap', submenu: [registered('photos-gap-30', undefined, 'radio'), registered('photos-gap-120', undefined, 'radio'), registered('photos-gap-360', undefined, 'radio'), registered('photos-gap-custom')] }] },
      registered('photos-show-time', undefined, 'checkbox'),
      { type: 'separator' }, registered('presentation'), registered('presentation-start'),
      // macOS supplies its own full-screen item, including the system keyboard shortcut.
      ...process.platform === 'darwin' ? [] : [{ type: 'separator' as const }, { role: 'togglefullscreen' as const }],
    ] },
    { role: 'windowMenu', submenu: [{ label: 'Welcome to ImageFlow', accelerator: 'CmdOrCtrl+Shift+1', click: () => showStart() },
      { type: 'separator' }, { role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }] },
    { role: 'help', submenu: [
      { label: 'ImageFlow Help', click: () => void shell.openExternal('https://github.com/wirhabenzeit/imageflow#readme') },
      { label: 'Connect an Agent…', click: () => showSettings('agents') },
      { label: 'Template Authoring Guide', click: () => void shell.openExternal('https://github.com/wirhabenzeit/imageflow/blob/main/docs/template-api.md') },
    ] },
  ]));
}
function updateMenus() {
  const document = focusedDocument();
  const owner = BrowserWindow.getFocusedWindow() ?? document?.window;
  const inBook = !!document && owner === document.window;
  const state: BookMenuState = { ...emptyMenuState, ...document?.menuState, document: !!document && !document.closing,
    sidebar: document?.sidebar, inspector: document?.inspector, sources: document?.sources, guides: document?.guides, layout: document?.layout };
  if (!inBook) { state.editing = true; state.canExport = false; state.canPrint = false; }
  const menu = Menu.getApplicationMenu();
  for (const id of Object.keys(commandRegistry) as RegisteredCommand[]) {
    const item = menu?.getMenuItemById(id);
    if (!item) continue;
    const next = commandState(id, state);
    item.label = next.label; item.enabled = next.enabled;
    // Electron selects a radio item when its setter is used, even when assigned false.
    if (next.checked !== undefined && (item.type !== 'radio' || next.checked)) item.checked = next.checked;
  }
  const inAssets = !!document && owner === assetsWindows.get(document)?.window;
  const native = (!inBook && !inAssets) || (inBook && state.textEditing);
  const zoomAlias = menu?.getMenuItemById('zoom-in-equals');
  if (zoomAlias) zoomAlias.enabled = commandState('zoom-in', state).enabled;
  for (const direction of ['undo', 'redo']) {
    const own = menu?.getMenuItemById(direction), text = menu?.getMenuItemById('native-' + direction);
    if (own) own.visible = !native;
    if (text) text.visible = native;
  }
  for (const columns of gridColumns) {
    const item = menu?.getMenuItemById('grid-columns-' + columns);
    if (item) { item.enabled = state.document && state.layout?.mode === 'grid'; if (state.layout?.columns === columns) item.checked = true; }
  }
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


function appWindows() { return [...documents.values()].map((document) => document.window).concat([startWindow, settingsWindow, templatesWindow, ...[...assetsWindows.values()].map(({ window }) => window)].filter((window): window is BrowserWindow => !!window)); }
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

function revealSettings(owner: BrowserWindow) {
  const state = settingsPresentation.get(owner);
  if (state?.painted && state.sized && !process.env.IMAGEFLOW_HIDE_WINDOW) { owner.show(); owner.focus(); }
}

/** Opens Settings, switching to `pane` when given. Without one, an open window keeps its current pane. */
function showSettings(pane?: SettingsPane) {
  const hidden = !!process.env.IMAGEFLOW_HIDE_WINDOW;
  settingsPane = pane ?? (settingsWindow && !settingsWindow.isDestroyed() ? settingsPane : 'general');
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    if (pane) settingsWindow.webContents.send(channels.settingsPane, pane);
    revealSettings(settingsWindow);
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
  const presentation = { painted: false, sized: false };
  settingsPresentation.set(preferences, presentation);
  followAppearance(preferences);
  preferences.webContents.on('will-frame-navigate', (event) => event.preventDefault());
  preferences.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  preferences.on('page-title-updated', (event) => event.preventDefault());
  preferences.once('ready-to-show', () => { presentation.painted = true; revealSettings(preferences); });
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
  // IMAGEFLOW_TEMPLATES points tests and development at another library folder.
  library = new TemplateLibrary(process.env.IMAGEFLOW_TEMPLATES || join(app.getPath('userData'), 'Templates'),
    starters.map((starter) => ({ template: join(sampleFolder(starter.folder), 'template'), sample: sampleFolder(starter.folder), defaultName: starter.defaultName })),
    probeTemplate, (path) => shell.trashItem(path), capabilities.join(',') + '@' + app.getVersion(), join(__dirname, 'authoring-types'),
    // Built-in templates ship renders of their opening spreads; later ones are kept with the app's other caches.
    renderPreviewsTo ? { cache: renderPreviewsTo } : {
      shipped: join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'template-previews'),
      cache: join(app.getPath('userData'), 'Cache', 'template-previews'),
    });
  library.onChange(publishLibrary);
  trust = new TemplateTrust(join(app.getPath('userData'), 'template-trust.json'));
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
      for (const job of previewJobs.values()) job.abort();
      await previewQueue;
      await rm(cache, { recursive: true, force: true });
      await pruneRenditions(renditions).catch((error) => console.warn('ImageFlow could not prune image previews', error));
    })().catch((error) => console.error('ImageFlow could not finish cleanup', error)).finally(() => { quitReady = true; app.quit(); });
  });
  protocol.handle(desktopScheme, async (request) => {
    try { return await serve(request); }
    catch (error) { console.error('ImageFlow could not serve a document resource', error); return new Response(null, { status: 404 }); }
  });
  ipcMain.handle(channels.popupMenu, async (event, items: unknown, point: unknown) => {
    const owner = appOwner(event) ?? pickerOwner(event) ?? assetsWindows.get(assetsOwner(event)!)?.window;
    if (!owner || !Array.isArray(items) || items.length > 80) return null;
    let selected: string | null = null;
    const entries = items.flatMap<MenuItemConstructorOptions>((item) => {
      if (item?.type === 'separator') return [{ type: 'separator' as const }];
      if (typeof item?.label !== 'string' || typeof item.id !== 'string') return [];
      return [{ label: item.label.slice(0, 160), enabled: item.enabled !== false,
        ...(typeof item.toolTip === 'string' ? { toolTip: item.toolTip.slice(0, 300) } : {}),
        ...(typeof item.checked === 'boolean' ? { type: 'checkbox' as const, checked: item.checked } : {}), click: () => { selected = item.id; } }];
    });
    const at = point as { x?: unknown; y?: unknown };
    const position = Number.isInteger(at?.x) && Number.isInteger(at?.y) ? { x: Number(at.x), y: Number(at.y) } : {};
    await new Promise<void>((resolve) => Menu.buildFromTemplate(entries).popup({ window: owner, ...position, callback: resolve }));
    return selected;
  });
  ipcMain.handle(channels.contextMenu, async (event, input: unknown, snapshot?: BookMenuState) => {
    const document = editorOwner(event) ?? assetsOwner(event);
    const owner = document ? (assetsOwner(event) ? assetsWindows.get(document)?.window : document.window) : templatesOwner(event) ?? startOwner(event);
    if (!owner || document?.closing || !Array.isArray(input) || input.length > 100) return null;
    const state: BookMenuState = { ...emptyMenuState, ...snapshot, document: !!document,
      writable: !!document && !document.book.readOnly && (snapshot?.writable ?? true) };
    let chosen: ContextMenuResult | null = null;
    let count = 0;
    const build = (items: ContextMenuItem[], depth = 0): MenuItemConstructorOptions[] => {
      if (depth > 4 || !Array.isArray(items)) return [];
      return items.flatMap((entry): MenuItemConstructorOptions[] => {
        if (++count > 200 || !entry) return [];
        if (typeof entry === 'object' && 'type' in entry) return [{ type: 'separator' }];
        const request = typeof entry === 'string' ? { command: entry } : entry;
        if (!Object.hasOwn(commandRegistry, request.command)) return [];
        const item = commandState(request.command, state, true);
        const children = request.items && build(request.items, depth + 1);
        return [{ ...item, label: typeof request.label === 'string' ? request.label.slice(0, 200) : item.label,
          enabled: item.enabled && request.enabled !== false, registerAccelerator: false,
          ...(children ? { submenu: children } : {}),
          ...(request.checked !== undefined || item.checked !== undefined ? { type: 'checkbox' as const, checked: request.checked ?? item.checked } : {}),
          click: () => { if (request.command === 'issue-copy' && typeof request.value === 'string') clipboard.writeText(request.value); chosen = { command: request.command, ...(typeof request.value === 'string' ? { value: request.value } : {}) }; } }];
      });
    };
    await new Promise<void>((resolve) => Menu.buildFromTemplate(build(input)).popup({ window: owner, callback: resolve }));
    return chosen;
  });
  ipcMain.handle(channels.presentation, (event, active: unknown) => {
    const owner = editorOwner(event)?.window;
    if (!owner || typeof active !== 'boolean') return;
    if (active && !presentationWindows.has(owner)) {
      const simple = process.platform === 'darwin' && !owner.isFullScreen();
      presentationWindows.set(owner, { simple, previous: simple ? owner.isSimpleFullScreen() : owner.isFullScreen() });
      if (simple) owner.setSimpleFullScreen(true); else owner.setFullScreen(true);
    } else if (!active && presentationWindows.has(owner)) {
      const { simple, previous } = presentationWindows.get(owner)!;
      presentationWindows.delete(owner);
      if (simple) owner.setSimpleFullScreen(previous); else owner.setFullScreen(previous);
    }
  });
  ipcMain.handle(channels.documentProxy, async (event, action: unknown) => {
    const document = editorOwner(event);
    if (!document || document.closing) return;
    const folder = document.book.folder;
    if (action === 'drag') { document.window.webContents.startDrag({ file: folder, icon: await app.getFileIcon(folder) }); return; }
    if (action !== 'path') return;
    const paths = [folder];
    while (dirname(paths.at(-1)!) !== paths.at(-1)) paths.push(dirname(paths.at(-1)!));
    const entries = await Promise.all(paths.map(async (path) => ({ label: basename(path) || parse(path).root,
      icon: await app.getFileIcon(path).catch(() => undefined), click: () => shell.showItemInFolder(path) })));
    Menu.buildFromTemplate(entries).popup({ window: document.window });
  });
  ipcMain.handle(channels.dragSources, async (event, keys: unknown) => {
    const document = assetsOwner(event);
    if (!document || !Array.isArray(keys) || !keys.every((key) => typeof key === 'string')) return;
    const entries = sourceEntries(document.book).filter(({ key }) => keys.includes(key));
    const files = await Promise.all(entries.map((entry) => originalPath(document.book.folder, entry)));
    if (files.length) assetsWindows.get(document)?.window.webContents.startDrag({ file: files[0], files, icon: await app.getFileIcon(files[0]) });
  });
  ipcMain.handle(channels.showAssets, (event, accept: unknown) => {
    const document = editorOwner(event);
    if (!document || document.closing || !Array.isArray(accept) || !accept.every((ext) => typeof ext === 'string' && /^\.[a-z0-9]{1,10}$/.test(ext)))
      return { error: 'Request is only available to an open book.' };
    showAssets(document, accept);
    return { value: undefined };
  });
  ipcMain.handle(channels.showTemplates, (event) => {
    if (appOwner(event) || pickerOwner(event)) showTemplates();
  });
  ipcMain.handle(channels.current, (event) => {
    const document = editorOwner(event) ?? assetsOwner(event);
    return document && !document.closing ? { value: document.summary } : { error: 'This window has no open book.' };
  });
  ipcMain.handle(channels.open, async (event, action: OpenAction) => {
    const owner = editorOwner(event)?.window ?? startOwner(event);
    if (!owner || quitting) return { error: 'Request is only available to a book or the start window.' };
    try { return { value: await openProject(owner, action, editorOwner(event)) }; }
    catch (error) { return { error: errorMessage(error) }; }
  });
  ipcMain.handle(channels.chooseStarter, async (event, choice?: NewBookChoice) => {
    const owner = pickerOwner(event);
    if (!owner) return { error: 'Request is only available to New Book.' };
    if (!choice) { owner.close(); return { value: false }; }
    if (typeof choice.id !== 'string' || typeof choice.sample !== 'boolean') return { error: 'Choose a template.' };
    try { return { value: await createNewBook(owner, choice) }; }
    catch (error) { return { error: errorMessage(error) }; }
  });
  ipcMain.handle(channels.recents, async (event) => startOwner(event) ? { value: await recents.list() } : { error: 'Request is only available to the start window.' });
  ipcMain.handle(channels.recentAction, async (event, id: string, action: 'open' | 'locate' | 'remove' | 'reveal') => {
    const owner = startOwner(event);
    if (!owner || typeof id !== 'string') return { error: 'Request is only available to the start window.' };
    try {
      const entry = await recents.get(id);
      if (action === 'reveal') shell.showItemInFolder(entry.path);
      else if (action === 'remove') { await recents.remove(id); publishRecents(); }
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
  ipcMain.handle(channels.sourceAction, (event, request: SourceAction) => fromBook(event, async (document) => {
    const owner = assetsOwner(event) ? assetsWindows.get(document)?.window ?? document.window : document.window;
    if (assetsOwner(event)) request = { ...request, accept: assetsWindows.get(document)?.accept };
    const activate = (summary: ProjectSummary) => { if (assetsOwner(event)) document.notify({ value: summary }); return summary; };
    const keys = request.keys ?? (request.key ? [request.key] : undefined);
    if (keys && (!Array.isArray(keys) || keys.length > 1000 || !keys.every((key) => typeof key === 'string'))) throw new Error('Invalid asset selection.');
    const chosen = sourceEntries(document.book).filter(({ key }) => keys?.includes(key));
    const source = chosen[0];
    if (request.action === 'jump') {
      if (!document.book.project.spreads.some(({ id }) => id === request.spread)) throw new Error('This spread no longer exists.');
      document.window.webContents.send(channels.sourceCommand, { action: 'jump', spread: request.spread }); focus(document.window);
      return { summary: document.summary };
    }
    if (request.action === 'place') {
      if (document.book.readOnly || !chosen.length) throw new Error('Select assets in an editable book.');
      document.window.webContents.send(channels.sourceCommand, { action: 'place', keys: chosen.map(({ key }) => key) }); focus(document.window);
      return { summary: document.summary };
    }
    if (request.action === 'reveal' || request.action === 'open' || request.action === 'preview') {
      if (!source) throw new Error('Choose a registered source.');
      const path = await originalPath(document.book.folder, source);
      if (request.action === 'reveal') for (const entry of chosen) shell.showItemInFolder(await originalPath(document.book.folder, entry));
      else if (request.action === 'open') { const error = await shell.openPath(path); if (error) throw new Error(error); }
      else owner.previewFile(path);
      return { summary: document.summary };
    }
    if (document.book.readOnly) throw new Error('Create an editable book first.');
    let next = document.book;
    let message: string | undefined;
    if (request.action === 'retry') return { summary: activate(await document.reload()) };
    if (request.action === 'collect') next = await collectSources(document.book, keys);
    else if (request.action === 'remove') {
      if (!keys?.length) throw new Error('Select assets first.');
      next = await removeSources(document.book, keys);
      document.projectSession.record(next, 'Remove assets', true, false);
      return { summary: activate(document.activate(next)) };
    }
    else if (request.action === 'locate-folder') {
      const choice = await dialog.showOpenDialog(owner, { title: 'Locate Missing Sources in Folder', properties: ['openDirectory'] });
      if (!choice.canceled && choice.filePaths[0]) {
        const result = await relinkFolder(document.book, choice.filePaths[0], keys);
        next = result.book;
        const names = new Map(sourceEntries(document.book).map((entry) => [entry.key as string, basename(entry.path)]));
        message = result.repaired + ' sources located.' + (result.ambiguous.length ? ' Multiple matches need Locate… for: ' + result.ambiguous.map((key) => names.get(key) ?? 'a source').join(', ') : '');
      }
    } else {
      if (!source) throw new Error('Choose a registered source.');
      if (request.action === 'copy') next = await collectSources(document.book, chosen.filter(({ linked }) => linked).map(({ key }) => key));
      else if (request.action === 'locate' || request.action === 'replace') {
        if (source.kind === 'file' && !request.accept?.length) throw new Error('This template does not declare a compatible file parameter.');
        const choice = await dialog.showOpenDialog(owner, { title: request.action === 'replace' ? 'Replace Original' : 'Locate Original', properties: ['openFile'],
          filters: [{ name: source.kind === 'photo' ? 'Photos' : 'Source', extensions: source.kind === 'photo' ? ['jpg', 'jpeg', 'png', 'webp'] : source.kind === 'file' ? request.accept!.map((extension) => extension.slice(1)) : ['md'] }] });
        if (!choice.canceled && choice.filePaths[0]) next = await relocateSource(document.book, source.key, choice.filePaths[0], false, request.accept);
      } else throw new Error('Unknown source action.');
    }
    document.projectSession.record(next, 'Source location changed', false);
    return { summary: activate(document.activate(next)), message };
  }));
  ipcMain.handle(channels.saveCopy, (event, includeAssets?: boolean) => fromEditor(event, async (document) => {
    if (includeAssets === undefined) {
      const answer = await dialog.showMessageBox(document.window, { type: 'question', message: 'Duplicate this book?',
        buttons: ['Duplicate', 'Cancel'], defaultId: 0, cancelId: 1, checkboxLabel: 'Include all files', checkboxChecked: true,
        detail: sourceEntries(document.book).some(({ linked }) => linked) ? 'Unchecked: linked files keep their full paths.' : undefined });
      if (answer.response !== 0) return null;
      includeAssets = answer.checkboxChecked;
    }
    if (typeof includeAssets !== 'boolean') throw new Error('Choose whether to include all files.');
    const choice = await dialog.showSaveDialog(document.window, { title: 'Duplicate Book', buttonLabel: 'Duplicate',
      defaultPath: join(app.getPath('documents'), bookName(document.book.folder) + ' Copy.imageflow'), filters: [{ name: 'ImageFlow Book', extensions: ['imageflow'] }] });
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
  ipcMain.handle(channels.showSettings, (event, pane: SettingsPane) => {
    if ((appOwner(event) || pickerOwner(event)) && (pane === 'general' || pane === 'agents')) showSettings(pane);
  });
  ipcMain.handle(channels.templatePreview, async (event, id: unknown, hash: unknown) => {
    if ((!templatesOwner(event) && !pickerOwner(event)) || typeof id !== 'string' || typeof hash !== 'string')
      return { error: 'Request is only available to Templates and New Book.' };
    try {
      const entry = (await library.list()).find((entry) => entry.id === id && entry.hash === hash);
      if (!entry || entry.unavailable) return { value: null };
      if (entry.render) {
        // The window asks only when it has no picture, or a saved one failed to load: a damaged render is removed and
        // made again.
        const file = await library.pictureFile(hash, 'render');
        if (file && await decodes(file)) return { value: templatePictureURL(hash, 'render') };
        if (file) await rm(file, { force: true }).catch(() => {});
      }
      const origins = await bookNetworkTrust(hash, entry.network);
      return { value: await templatePreview(id, hash, origins, completeRender(entry, origins)) };
    } catch (error) { return { error: errorMessage(error) }; }
  });
  ipcMain.handle(channels.library, async (event) => {
    if (!appOwner(event) && !pickerOwner(event)) return { error: 'Request is only available to an app window.' };
    try { return { value: await libraryWithTrust() }; }
    catch (error) { return { error: errorMessage(error) }; }
  });
  ipcMain.handle(channels.libraryImport, async (event, paths?: unknown) => {
    const owner = templatesOwner(event) ?? pickerOwner(event);
    if (!owner) return { error: 'Request is only available to Templates and New Book.' };
    if (paths !== undefined && (!Array.isArray(paths) || paths.length > 50 || !paths.every((path) => typeof path === 'string' && isAbsolute(path)))) return { error: 'Choose template folders or archives.' };
    try { return { value: await importTemplates(owner, paths as string[] | undefined) }; }
    catch (error) { return { error: errorMessage(error) }; }
  });
  ipcMain.handle(channels.templateAction, async (event, id: unknown, action: unknown) => {
    const owner = templatesOwner(event);
    if (!owner || typeof id !== 'string' || (action !== 'reveal' && action !== 'new')) return { error: 'Choose a template in the library.' };
    try {
      if (action === 'new') await createNewBook(owner, { id, sample: false }, false);
      else shell.showItemInFolder((await library.resolve(id)).folder);
      return { value: undefined };
    } catch (error) { return { error: errorMessage(error) }; }
  });
  ipcMain.handle(channels.libraryExport, async (event, id: unknown) => {
    const owner = templatesOwner(event);
    if (!owner || typeof id !== 'string') return { error: 'Request is only available to Templates.' };
    try {
      const entry = (await library.list()).find((item) => item.id === id);
      if (!entry) throw new Error('This template is no longer in the library.');
      const file = await chooseTemplateFile(owner, entry.label + ' ' + entry.version);
      if (!file) return { value: null };
      await library.export(id, file);
      return { value: file };
    } catch (error) { return { error: errorMessage(error) }; }
  });
  ipcMain.handle(channels.libraryTrust, async (event, id: unknown, allow: unknown) => {
    const owner = templatesOwner(event);
    if (!owner || typeof id !== 'string' || typeof allow !== 'boolean') return { error: 'Request is only available to Templates.' };
    try {
      const entry = (await library.list()).find((item) => item.id === id && item.source === 'imported');
      if (!entry?.network?.length) throw new Error('This template does not ask for network access.');
      if (allow) await trust.allow(entry.hash, entry.network, entry); else await trust.revoke(entry.hash);
      invalidateTemplatePreviews(entry.hash);
      publishLibrary();
      // Open books from this template follow at once: their frames are rendered again under the new policy (ADR 0006).
      for (const document of documents.values()) void document.updateNetwork().catch((error) => console.warn('ImageFlow could not update network access', error));
      return { value: true };
    } catch (error) { return { error: errorMessage(error) }; }
  });
  ipcMain.handle(channels.libraryRemove, async (event, id: unknown) => {
    const owner = templatesOwner(event);
    if (!owner || typeof id !== 'string') return { error: 'Request is only available to Templates.' };
    try {
      const entry = (await library.list()).find((item) => item.id === id && item.source === 'imported');
      if (!entry) throw new Error('This template is no longer in the library.');
      const { response } = await dialog.showMessageBox(owner, { type: 'question', buttons: ['Move to Trash', 'Cancel'], defaultId: 1, cancelId: 1,
        message: 'Move ' + entry.label + ' to the Trash?',
        detail: entry.replacesBuiltIn ? 'The built-in template will be restored.' : undefined });
      if (response !== 0) return { value: false };
      invalidateTemplatePreviews(entry.hash);
      await library.remove(id);
      return { value: true };
    } catch (error) { return { error: errorMessage(error) }; }
  });
  ipcMain.handle(channels.settingsPane, (event) => settingsOwner(event) ? settingsPane : 'general');
  ipcMain.handle(channels.fitSettings, (event, height: number) => {
    const owner = settingsOwner(event);
    if (!owner || typeof height !== 'number' || !Number.isFinite(height)) return;
    const presentation = settingsPresentation.get(owner);
    if (!presentation) return;
    const firstFit = !presentation.sized;
    const [width, currentHeight] = owner.getContentSize();
    const nextHeight = Math.round(Math.min(Math.max(height, 120), 760));
    // The first measured size must be applied before showing, without a native resize animation.
    if (nextHeight !== currentHeight) owner.setContentSize(width, nextHeight, !firstFit && owner.isVisible() && process.platform === 'darwin');
    presentation.sized = true;
    if (firstFit) revealSettings(owner);
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
  ipcMain.handle(channels.import, (event, id: string, request: ImportRequest) => fromEditor(event, async (document) => {
    if (request.target && request.paths?.length) {
      document.currentBook(id);
      for (const source of sourceEntries(document.book).filter(({ kind }) => kind === request.kind)) {
        const path = await originalPath(document.book.folder, source).catch(() => undefined);
        if (!path || path !== request.paths[0]) continue;
        const files = structuredClone({ project: document.book.project, photoIndex: document.book.photoIndex });
        const spread = files.project.spreads.find(({ id }) => id === request.target!.spread);
        if (!spread) throw new Error('The spread changed.');
        spread.boxes[request.target.box] = { params: spread.boxes[request.target.box]?.params ?? {},
          ...(request.kind === 'photo' ? { photo: source.id } : { text: source.id }) };
        return { summary: document.activate(await document.projectSession.save(files, 'Place asset')), imported: [source.id] };
      }
    }
    return document.importFiles(document.window, id, request);
  }));
  ipcMain.handle(channels.network, async (event, id: string, origins: unknown) => {
    const document = editorOwner(event);
    if (!document || quitting) return { error: 'Request is only available to an open book.' };
    try { return { value: await document.editorNetwork(id, origins) }; }
    catch (error) { return { error: errorMessage(error) }; }
  });
  ipcMain.handle(channels.export, (event, id: string, mode: ExportMode) => fromEditor(event, (document) => document.exportBook(document.window, id, mode)));
  ipcMain.handle(channels.cancel, (event) => { editorOwner(event)?.cancelExport(); });
  ipcMain.handle(channels.check, (event, id: string, request: AuthoringCheckRequest) => fromEditor(event, (document) => document.checkOpenBook(document.currentBook(id), request)));
  ipcMain.handle(channels.cancelCheck, (event) => { editorOwner(event)?.cancelCheck(); });
  ipcMain.handle(channels.bookMenu, (event, state: BookMenuState) => {
    const document = editorOwner(event);
    if (!document || !state || typeof state.enabled !== 'object' || !state.enabled ||
        typeof state.editing !== 'boolean' || typeof state.writable !== 'boolean' || typeof state.busy !== 'boolean') return;
    document.menuState = { ...emptyMenuState, ...state,
      enabled: Object.fromEntries(spreadCommands.map((id) => [id, state.enabled[id] === true])) as BookMenuState['enabled'] };
    document.window.setDocumentEdited(state.saving === true);
    if (typeof state.sidebar === 'boolean') document.sidebar = state.sidebar;
    if (typeof state.inspector === 'boolean') document.inspector = state.inspector;
    if (typeof state.sources === 'boolean') document.sources = state.sources;
    if (typeof state.guides === 'boolean') document.guides = state.guides;
    if (state.layout && (state.layout.mode === 'grid' || state.layout.mode === 'vertical') && gridColumns.includes(state.layout.columns as 1|2|3|4)) document.layout = state.layout;
    updateMenus();
  });
  ipcMain.handle(channels.panelVisibility, (event, state: { sidebar: boolean; inspector: boolean; sources?: boolean; guides?: boolean; layout?: CanvasLayout }) => {
    const document = editorOwner(event);
    if (!document || typeof state?.sidebar !== 'boolean' || typeof state?.inspector !== 'boolean') return;
    document.sidebar = state.sidebar;
    document.inspector = state.inspector;
    if (typeof state.sources === 'boolean') document.sources = state.sources;
    if (typeof state.guides === 'boolean') document.guides = state.guides;
    const layout = state.layout;
    if (layout && (layout.mode === 'vertical' || layout.mode === 'grid') && gridColumns.some((columns) => columns === layout.columns)) {
      document.layout = { mode: layout.mode, columns: layout.columns };
    }
    updateMenus();
  });
  app.setAboutPanelOptions({ applicationName: 'ImageFlow', applicationVersion: app.getVersion() });
  installMenu();
  if (renderPreviewsTo) {
    for (const entry of await library.list()) if (entry.source === 'built-in') await saveTemplatePreview(entry.id);
    app.quit();
    return;
  }
  ready = true;
  const paths = [...new Set([...pendingOpenFiles.splice(0), ...process.argv.filter(isSystemFile)])];
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
