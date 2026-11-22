import { bookFormatOf, boxBase, coverInstance, scopeSpread } from '../src/project';
import { hidden } from './background-mode';
import { AppUpdater } from './updates';
import { copySample } from './sample-book.mjs';
import { updateUnavailable } from './update-environment';
import { checkUpdateFeed, updateTestConfiguration } from './update-feed';
import { updateBaseURL, releaseChannel } from '../src/update-feed';
import { defaultSettings } from '../src/settings';
import { MarkdownWindows } from './markdown-windows';
import { PresentationWindows } from './presentation-windows';
import { commandRegistry, commandState, emptyMenuState } from '../src/commands';
import type { ContextMenuItem, ContextMenuResult } from '../src/desktop';
import type { RegisteredCommand } from '../src/commands';
import { bookName } from '../src/book-name';
import { collectSources, CopyCancelled, relocateSource, relinkFolder, saveDocumentCopy, removeSources, renameSource } from './source-actions';
import { originalPath, within } from './source-store';
// The file a source is: Show in Finder, Edit in Default App, Quick Look and dragging out need one, so a photo that is
// not a file has none of them (ADR 0011).
async function sourceOriginal(folder: string, entry: SourceEntry) {
  const file = fileSourceOf(entry);
  if (!file) throw new Error(entry.name + ' is not a file on this Mac.');
  return originalPath(folder, file);
}
import { fileSourceOf, sourceEntries, sourceProvider } from '../src/source-locations';
import type { SourceEntry } from '../src/source-locations';
import { assetPageLabels, assetUsage, usageLabel } from '../src/asset-usage';
import { importFeedback } from '../src/import-feedback';
import { configureSourceStore, pruneSourceCache, SourceStore } from './source-store';
import { bookTrusted, configureSourceAccess, distrustBook, trustBook } from './source-access';
import { app, autoUpdater, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, net, powerMonitor, protocol, shell } from 'electron';
import type { BaseWindow, IpcMainInvokeEvent, MenuItemConstructorOptions } from 'electron';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, isAbsolute, parse } from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { channels, gridColumns, spreadCommands, desktopScheme, editorURL, renderOrigin, renderOrigins, settingsURL, startURL, starterURL, assetsURL, templatesURL } from '../src/desktop';
import type { AgentLeaseReply, BookMenuState, Command, ImportRequest, LightroomState, OpenAction, ProjectSummary, Result, MarkdownAction, McpClientTarget, McpSettings, SourceAction, SyncAction, TemplateInfo } from '../src/desktop';
import type { ProjectFiles } from '../src/project';
import { renderPolicy } from './csp';
import { assetTypes, loadProject, renderData, TemplateCompileError } from './project';
import type { OpenProject } from './project';
import { photoFile } from './photos';
import { captureBookPreview, checkBookRender } from './preview';
import { PreviewError } from '../src/preview';
import { chooseSyncTip, DocumentSession } from './document-session';
import { cloneFromRemote } from './sync-engine';
import { remoteBooks } from './sync-remote';
import { FolderRemote } from './sync-remote-folder';
import { configureMacHeader, setToolbarDragRegions } from './mac-header';
import type { RenderSessions } from './document-session';
import { AssetFacts } from './asset-facts';
import { createDocument, documentIdentity, documentPath, isDocument, RecentDocuments } from './documents';
import { SettingsStore } from './settings';
import { AuthoringError } from './authoring-service';
import { createMcpConnection } from './mcp-connection';
import { addToCodex, bridgeLaunch, claudeCodeCommand, claudeExtension, findCodex, skillArchive } from './mcp-setup';
import { authoringErrorResult } from './authoring-errors';
import { acquireProjectLock, configurePersistence } from './persistence';
import type { ProjectLock } from './persistence';
import type { AuthoringCheckRequest } from '../src/authoring-check';
import type { SettingsPane } from '../src/settings';
import { mcpTools } from '../src/mcp-contract';
import { starters } from '../src/starters';
import { copyTemplate, TemplateImportError, TemplateLibrary } from './template-library';
import { agentLibraryEntry, saveTemplateToLibrary } from './library-tools';
import { TemplateTrust, trustedOrigins } from './template-trust';
import { ReleasedTemplates } from './released-templates';
import { isTemplateArchive, templateArchiveExtension } from './template-archive';
import { writeAgentSkill, writeAuthoringSnapshot } from './authoring-sdk';
import type { ImportPlan, ResolvedTemplate } from './template-library';
import { describeImport, templatePicturePath, templatePictureURL } from '../src/library';
import type { LibraryEntry, LibraryImportResult, NewBookChoice, NewBookStart } from '../src/library';
import { capabilities } from '../src/runtime-exports';
import { newSpread, openingSpreadStates } from '../src/editing';
import { templateFolder, textSourcePath } from './document-actions';
import { configureRenditionCache, pruneRenditions } from './rendition-cache';
import { configureProxyStore, proxyStore } from './proxy-store';
import { decodes, readTemplatePreview } from './template-preview-file';
import { previewTypes } from '../src/template-preview';
import { LightroomBridge } from './lightroom/bridge';
import { launchLightroom } from './lightroom/launch';
import { defaultModules, installMessage, installPlugin, lightroomRunning, pluginStatus } from './lightroom/plugin-install';
import { lightroomProvider } from './providers/lightroom';
import { registerProvider } from './providers';

const presentationWindows = new PresentationWindows({
  hidden: () => hidden,
  window: () => ({ webPreferences: windowOptions() }), secure: secureWindow, focus,
  focused: (document) => { lastDocument = document; updateMenus(); },
  closed: (document, spread) => {
    if (quitting) return;
    document.window.webContents.send(channels.presentationClosed, spread);
    focus(document.window);
  },
  error: (document, error) => report(document.window, error),
});
let templatesWindow: BrowserWindow | null = null;
const assetsWindows = new Map<DocumentSession, { window: BrowserWindow; accept: string[] }>();
const markdownWindows = new MarkdownWindows({
  window: () => ({ webPreferences: windowOptions() }), secure: secureWindow, focus,
  focused: (document) => { lastDocument = document; updateMenus(); },
});
let settingsWindow: BrowserWindow | null = null;
const settingsPresentation = new WeakMap<BrowserWindow, { painted: boolean; sized: boolean }>();
let startWindow: BrowserWindow | null = null;
let settingsPane: SettingsPane = 'general';
let mcpConnection: Awaited<ReturnType<typeof createMcpConnection>> | undefined;
let mcpClients: { name: string }[] = [];
let quitting = false;
let preparingQuit = false;
let updates: AppUpdater;
const quitReplies = new Map<string, { sender: number; resolve: (allowed: boolean | undefined) => void; ack: () => void }>();
let quitReady = false;
let quitCleanup: Promise<void> | undefined;
let connectionSettingsQueue = Promise.resolve();
// The loopback bridge to the ImageFlow plugin in Lightroom Classic (ADR 0011). Its file is in this profile's folder, so
// a run with another profile (the smoke tests) never writes into the one the plugin reads.
let lightroom: LightroomBridge | undefined;
let cache: string;
let settings: SettingsStore;
let recents: RecentDocuments;
let library: TemplateLibrary;
let trust: TemplateTrust;
// Hashes of the built-in templates every release shipped (`sample/released-templates.json`).
let releasedTemplates: Promise<ReleasedTemplates> = Promise.resolve(new ReleasedTemplates());
const sessions: RenderSessions = new Map();
const documents = new Map<number, DocumentSession>();
const identities = new Map<string, DocumentSession>();
const opening = new Map<string, Promise<DocumentSession | undefined>>();
const openingEditors = new Map<number, { window: BrowserWindow; identity: string }>();
const closing = new Set<Promise<void>>();
const covers = new Map<DocumentSession, { dirty: boolean; timer?: ReturnType<typeof setTimeout>; job?: AbortController; task?: Promise<void> }>();
const pickers = new Map<number, { window: BrowserWindow }>();
const pendingOpenFiles: string[] = [];
let ready = false;
let lastDocument: DocumentSession | undefined;
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

if (updateTestConfiguration) {
  app.setPath('userData', updateTestConfiguration.profile);
  app.commandLine.appendSwitch('remote-debugging-port', String(updateTestConfiguration.debugPort));
}
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
  const renderHost = host === 'render' || host === 'thumbs';
  if (host !== 'editor' && !renderHost) return new Response(null, { status: 404 });
  const picture = renderHost && /^\/render\/([a-f0-9-]{36})\/(picture|place)\/([a-f0-9]{64})$/.exec(pathname);
  if (picture) {
    const session = sessions.get(picture[1]);
    if (session?.mode !== 'edit' || !session.pictures || !session.book.templateHash) return new Response(null, { status: 404 });
    // Pictures are scoped by the template file that draws them (desktop/picture-scopes.ts, in the frame's cache key), so
    // an edit elsewhere in the template keeps them; here only by the sites the book may reach now.
    const scope = JSON.stringify(['pictures-2', session.network?.() ?? []]);
    if (session.pictureScope !== scope) return new Response(null, { status: 404 });
    // The last picture shown at a place outlives template edits: a replacement frame shows it, as still drawing,
    // while it draws the new one, instead of an empty box for every map in the book (F-032). It is never taken as
    // the new picture, so it stays scoped to the allowed sites only.
    return session.pictures.respond(request, picture[2] === 'place' ? JSON.stringify(['place', session.network?.() ?? []]) : scope, picture[3]);
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
  if (host === 'editor' && ['/', '/settings', '/start', '/new', '/assets', '/templates', '/markdown', '/presentation'].includes(pathname)) {
    return response(await pageHtml(dist), 'text/html; charset=utf-8', {
      'Content-Security-Policy': csp + ' ' + renderOrigin + '; frame-src ' + renderOrigins.join(' ') + "; frame-ancestors 'none'; base-uri 'none'",
    });
  }
  // Template files by the template's hash (renderData): any open render session with that hash has the same files.
  const templateFile = renderHost && /^\/render\/([a-f0-9]{64})\/template\/(.+)$/.exec(pathname);
  if (templateFile) {
    const [, hash, asset] = templateFile;
    for (const session of sessions.values()) {
      const bytes = session.book.templateHash === hash ? session.book.assets.files.get(asset) : undefined;
      if (bytes) return response(bytes, assetTypes[extname(asset).toLowerCase()] ?? 'application/octet-stream');
    }
    return new Response(null, { status: 404 });
  }
  const match = renderHost ? viewPath.exec(pathname) : null;
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
    session.pictureScope ??= JSON.stringify(['pictures-2', origins]);
    return response(await pageHtml(dist), 'text/html; charset=utf-8', {
      'Content-Security-Policy': renderPolicy(csp, origins) + '; frame-ancestors ' + editorURL + "; base-uri 'self'",
    });
  }
  if (resource === 'data') {
    const origins = session.network?.() ?? [];
    return Response.json(renderData(session.book, id, session.mode, session.network ? origins : undefined, desktopScheme + '://' + host));
  }
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
    const rendition = kind === 'thumb' ? 'thumb' : kind === 'proof-photo' ? 'export' : session.mode === 'edit' || session.photos === 'preview' ? 'preview' : 'export';
    const width = size && rendition === 'export' ? Number(size) : undefined;
    // The editor's book view asks only for photos on or near the screen; a cover renders in the background.
    const priority = session.photos === 'preview' ? 2 : session.mode === 'edit' && rendition === 'preview' ? 0 : 1;
    if (photo) return net.fetch(pathToFileURL(await photoFile(photo, rendition, width, priority)).href);
  }
  return new Response(null, { status: 404 });
}


function errorMessage(error: unknown) { return error instanceof Error ? error.message : 'ImageFlow could not complete the request.'; }
function focus(owner: BrowserWindow) {
  if (owner.isDestroyed() || hidden) return;
  if (owner.isMinimized()) owner.restore();
  owner.show();
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
  return browser ? documents.get(browser.webContents.id) ?? markdownWindows.documentFor(browser) ?? presentationWindows.documentFor(browser) ?? [...assetsWindows].find(([, entry]) => entry.window === browser)?.[0] : lastDocument && !lastDocument.closing ? lastDocument : undefined;
}
function report(owner: BrowserWindow | null | undefined, error: unknown) {
  if (owner && !owner.isDestroyed()) owner.webContents.send(channels.appError, errorMessage(error));
  else { showStart(); startWindow?.webContents.once('did-finish-load', () => report(startWindow, error)); }
}
function sampleFolder(name: string) {
  return sampleRoot ? join(sampleRoot, name) : app.isPackaged ? join(process.resourcesPath, 'sample', name) : join(app.getAppPath(), 'sample', name);
}
/** Removing a file that parameters still use clears those assignments, so the person confirms it first and sees where
 * it is used. Anything else is removed at once; every removal is one undoable edit. */
async function confirmRemoval(owner: BrowserWindow, document: DocumentSession, chosen: SourceEntry[]) {
  const usage = assetUsage(document.book, assetPageLabels(document.summary));
  const used = chosen.filter(({ kind, id }) => kind === 'file' && usage.file[id]?.length);
  if (!used.length) return true;
  const where = [...new Set(used.flatMap(({ id }) => usage.file[id].map(({ pages }) => usageLabel(pages))))];
  const names = used.map((entry) => entry.name);
  const answer = await dialog.showMessageBox(owner, { type: 'warning', buttons: ['Remove', 'Cancel'], defaultId: 0, cancelId: 1,
    message: chosen.length === 1 ? 'Remove “' + names[0] + '” from the book?' : 'Remove ' + chosen.length + ' assets from the book?',
    detail: (used.length === 1 ? 'This file is used in: ' : names.join(', ') + ' are used in: ') + where.join(', ') + '.\nRemoving it clears those assignments. Undo brings it back.' });
  return answer.response === 0;
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
// Evicted proxies are fetched again by digest on the next sync.
async function pruneProxies() {
  await (await proxyStore())?.prune(1024 * 1024 * 1024).catch((error) => console.warn('ImageFlow could not prune sync proxies', error));
}
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
    // A 320-pixel cover needs no print-resolution photos.
    sessions.set(id, { book, mode: 'export', photos: 'preview', network: () => document.networkOrigins });
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
  if (document.closing) return;
  markCoverDirty(document);
  const state = covers.get(document)!;
  state.timer = setTimeout(() => {
    if (document.closing || document.book !== book) return;
    void captureCover(document, book);
  }, 1000);
}
async function saveDevState() {
  if (devState) await writeFile(devState, JSON.stringify([...documents.values()].filter((document) => !document.closing)
    .map((document) => ({ folder: document.book.folder })))).catch(() => {});
}
async function openDocument(path: string): Promise<DocumentSession | undefined> {
  if (quitting || preparingQuit) throw new Error('ImageFlow is closing.');
  if (!isDocument(path)) throw new Error('Choose an .imageflow document.');
  const { folder, identity } = await documentIdentity(path);
  const existing = identities.get(identity);
  if (existing) {
    if (existing.closing) {
      await existing.close().catch(() => {});
      if (identities.get(identity) === existing) identities.delete(identity);
      return openDocument(path);
    }
    if (existing.book.folder !== folder) {
      const relocated = await existing.run(() => existing.relocate(folder));
      if ('error' in relocated) throw new Error(relocated.error);
    }
    await recents.remember(folder, existing.book.project.title);
    app.addRecentDocument(folder);
    publishRecents();
    await saveDevState();
    focus(existing.window);
    return existing;
  }
  const pending = opening.get(identity);
  const loading = [...openingEditors.values()].find((editor) => editor.identity === identity && !editor.window.isDestroyed());
  if (pending && loading) {
    if (loading.window.isVisible()) focus(loading.window);
    return pending;
  }
  // A closed loading window's task may still be reading the book and holding its writer lock. The new window shows
  // at once and takes over when that task lets go.
  const previous = pending?.catch(() => undefined);
  const task = (async () => {
    const editor = new BrowserWindow({ title: bookName(folder), width: 1520, height: 950, minWidth: 940, minHeight: 650, show: false,
      webPreferences: windowOptions() });
    const webContentsId = editor.webContents.id;
    openingEditors.set(webContentsId, { window: editor, identity });
    editor.once('closed', () => {
      if (openingEditors.delete(webContentsId) && !openingEditors.size && !documents.size && !quitting && !preparingQuit) showStart();
    });
    const closed = new Promise<void>((resolve) => editor.once('closed', () => resolve()));
    let release: ProjectLock | undefined;
    let document: DocumentSession | undefined;
    let loadStarted = false;
    let registered = false;
    try {
      configureMacHeader(editor);
      // The document session owns the native title; the editor page's HTML title must not replace it.
      editor.on('page-title-updated', (event) => event.preventDefault());
      secureWindow(editor);
      editor.webContents.on('will-frame-navigate', (event) => {
        if (openingEditors.has(webContentsId)) event.preventDefault();
      });
      const shell = editor.loadURL(editorURL);
      // The editor can close during navigation while the book's files are still being read.
      void shell.catch(() => {});
      const reveal = () => void shell.then(() => focus(editor), () => {});
      if (previous) {
        reveal();
        await previous;
        if (editor.isDestroyed()) return;
      }
      release = await acquireProjectLock(folder);
      if (editor.isDestroyed()) return;
      // A book that cannot be locked fails without flashing an empty editor.
      if (!previous) reveal();
      loadStarted = true;
      const book = await loadProject(folder, cache);
      if (editor.isDestroyed()) return;
      if (quitting || preparingQuit) throw new Error('ImageFlow is closing.');
      document = new DocumentSession(editor, book, cache, sessions, release, (next) => {
        if (document) queueMicrotask(() => { if (document) publishAssets(document); });
        if (document) {
          void recents.refresh(next.folder, next.project.title).then(publishRecents).catch((error) => console.warn('ImageFlow could not update recent books', error));
          markCoverDirty(document);
        }
      });
      document.networkTrust = bookNetworkTrust;
      document.keepOriginals = () => !!settings.value.keepOriginals;
      document.syncChanged = () => updateMenus();
      document.dependencyCache = dependencyCache();
      document.authoringTypes = join(__dirname, 'authoring-types');
      document.authoringSkills = join(__dirname, 'skills');
      // Frames may reach what is already allowed from the first render on, without a question (ADR 0006).
      await document.prepareNetwork().catch((error) => console.warn('ImageFlow could not read network approvals', error));
      // Electron may never settle loadURL for a window destroyed mid-navigation.
      await Promise.race([shell, closed]);
      if (editor.isDestroyed()) return;
      if (quitting || preparingQuit) throw new Error('ImageFlow is closing.');
      // Start watchers only when the editor can receive and render a revision.
      document.start();
      const current = document;
      documents.set(webContentsId, document);
      openingEditors.delete(webContentsId);
      registered = true;
      editor.webContents.on('render-process-gone', () => {
        for (const reply of quitReplies.values()) if (reply.sender === webContentsId) reply.resolve(true);
      });
      identities.set(identity, document);
      lastDocument = document;
      editor.on('focus', () => { lastDocument = current; updateMenus(); refreshSyncOnFocus(current); });
      editor.on('blur', () => { if (covers.get(current)?.dirty) scheduleCover(current, current.book); });
      let closingTextEditors = false;
      editor.on('close', (event) => {
        if (!markdownWindows.windows().some((window) => markdownWindows.documentFor(window) === current)) return;
        event.preventDefault();
        if (closingTextEditors) return;
        closingTextEditors = true;
        void markdownWindows.closeFor(current).then((allowed) => {
          closingTextEditors = false;
          if (allowed && !current.window.isDestroyed()) current.window.close();
        }).catch((error) => { closingTextEditors = false; report(current.window, error); });
      });
      editor.on('closed', () => {
        documents.delete(webContentsId);
        presentationWindows.close(current);
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
            if (!documents.size && !openingEditors.size && !quitting) showStart();
            updateMenus();
          }
        })();
        track(task);
      });
      await recents.remember(folder, book.project.title);
      if (editor.isDestroyed()) return;
      app.addRecentDocument(folder);
      publishRecents();
      scheduleCover(current, book);
      startWindow?.hide();
      await saveDevState();
      updateMenus();
      return current;
    } catch (error) {
      if (editor.isDestroyed()) return;
      openingEditors.delete(webContentsId);
      editor.destroy();
      throw error;
    } finally {
      if (!registered && release) {
        // Releasing the source registry must neither mask the open's own result nor keep the writer lock.
        if (loadStarted) {
          await SourceStore.release(folder).catch((error) => console.warn('ImageFlow could not release book sources', error));
          // An aborted open leaves no derived facts registered; this flushes them while the writer lock is still held.
          await AssetFacts.release(folder).catch((error) => console.warn('ImageFlow could not release asset facts', error));
        }
        if (document) await document.close();
        else await release();
      }
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
    (stage) => library.withTemplate(selected.id, (current) => createBook(stage, current, selected.start)));
  // A book made here is the user's own, and its template may reach its sites without asking, now and after edits
  // (ADR 0006) — when the template it starts from was trusted for them: a built-in, a template with no sites, or one
  // whose sites the user allowed when importing it. Otherwise the book asks once, like a book from elsewhere.
  const declared = template.entry.network ?? [];
  const trusted = declared.length ? await bookNetworkTrust(template.entry.hash, declared).catch(() => []) : [];
  if (declared.every((origin) => trusted.includes(origin))) await trustBook(folder).catch((error) => console.warn('ImageFlow could not record the new book as yours', error));
  await openDocument(folder);
  if (closeOwner) owner.close();
  return true;
}
// Fills a new book's staging folder from a library template: the template's own copy, no photos, texts or files, and
// either the template's starting spreads (`openingSpreads`) or none. Either way `project.json` records the template's hash.
async function createBook(stage: string, template: ResolvedTemplate, start: NewBookStart) {
  const { entry, folder, info } = template;
  await copyTemplate(folder, join(stage, 'template'));
  await writeAuthoringSnapshot(join(stage, 'template'), join(__dirname, 'authoring-types'));
  await writeAgentSkill(stage, join(__dirname, 'skills'));
  await Promise.all(['photos', 'texts', 'files'].map((name) => mkdir(join(stage, name))));
  await writeFile(join(stage, 'photos.json'), '{}\n');
  const spreads = start === 'opening' ? openingSpreadStates(info) : [];
  await writeFile(join(stage, 'project.json'), JSON.stringify({
    schemaVersion: bookFormatOf({ spreads }), title: 'Untitled', template: { id: entry.id, version: entry.version, hash: entry.hash },
    params: {}, texts: {}, files: {}, spreads,
  }, null, 2) + '\n');
}
// The library's preview render uses a built-in's complete sample book, photos included, where the sample has them (the
// repository and development builds; packaged apps ship pre-rendered previews and no photos), or else its starting spreads.
async function stagePreviewBook(stage: string, template: ResolvedTemplate) {
  if (!template.sample || !existsSync(join(template.sample, 'photos.json'))) return createBook(stage, template, 'opening');
  await copySample(template.sample, stage);
  const file = join(stage, 'project.json');
  const project = JSON.parse(await readFile(file, 'utf8'));
  project.template = { ...project.template, hash: template.entry.hash };
  await writeFile(file, JSON.stringify(project, null, 2) + '\n');
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
        await stagePreviewBook(stage, template);
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
      sessions.set(session, { book, mode: 'export', photos: 'preview', network: () => origins });
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
  // A built-in template from an earlier release is trusted like the current one, so its books need not ask after an
  // update changes it.
  const released = builtIn === undefined ? (await releasedTemplates).trusted(hash, declared) : undefined;
  if (released) return released;
  const allowed = builtIn ?? await trust.allowed(hash);
  return declared ? trustedOrigins(declared, { builtIn: builtIn !== undefined, allowed }) : allowed;
}

/** Where template packages are installed, outside every book (ADR 0006): the user's Caches folder in the app, the profile
 * otherwise, so development runs and tests never share it. */
function dependencyCache() {
  return app.isPackaged && process.platform === 'darwin' ? join(app.getPath('home'), 'Library', 'Caches', 'ImageFlow', 'template-dependencies')
    : join(app.getPath('userData'), 'template-dependencies');
}

/** Installs the focused book's template packages outside the book and rebuilds its saved bundle (ADR 0006). */
async function rebuildBookDependencies(owner: BaseWindow | undefined) {
  const document = focusedDocument(owner);
  if (!document || document.closing) return;
  const window = document.window;
  window.webContents.send(channels.appNotice, 'Installing and bundling template packages…');
  try {
    const result = await document.rebuildDependencies(undefined, Number.POSITIVE_INFINITY);
    if (window.isDestroyed()) return;
    const imports = result.imports as string[];
    window.webContents.send(channels.appNotice, imports.length ? 'Rebuilt the template’s dependencies: ' + imports.length + (imports.length === 1 ? ' import' : ' imports') +
      ' bundled into template/vendor.' : 'The template imports no packages.');
    if (result.leftoverNodeModules) {
      const folder = join(document.book.folder, 'template', 'node_modules');
      const { response } = await dialog.showMessageBox(window, { type: 'question', buttons: ['Move to Trash', 'Keep'], defaultId: 0, cancelId: 1,
        message: 'Move the template’s node_modules folder to the Trash?',
        detail: 'The book doesn’t use it: it renders the saved bundle in template/vendor, and ImageFlow installs packages outside the book. Removing it makes the book smaller.' });
      if (response === 0) await shell.trashItem(folder);
    }
  } catch (error) { report(window, error); }
}

/** Withdraws the user's trust in the focused book (ADR 0006): its template asks again before reaching any site. */
async function stopTrustingBook(owner: BaseWindow | undefined) {
  const document = focusedDocument(owner);
  if (!document || document.closing) return;
  const window = document.window;
  if (!await bookTrusted(document.book.folder)) {
    await dialog.showMessageBox(window, { type: 'info', message: 'This book is not trusted.',
      detail: 'Its template asks before it connects to the internet.' });
    return;
  }
  const { response } = await dialog.showMessageBox(window, { type: 'warning', buttons: ['Stop Trusting', 'Cancel'], defaultId: 1, cancelId: 1,
    message: 'Stop trusting this book’s template?',
    detail: 'Maps and other pictures that load from the internet stop drawing until you trust the book again.' });
  if (response !== 0) return;
  await distrustBook(document.book.folder);
  await document.updateNetwork();
}

/** Library entries with why their network access needs no question, for Manage Templates and New Book. */
async function libraryWithTrust() {
  return Promise.all((await library.list()).map(async (entry) => {
    if (!entry.network?.length) return entry;
    // An imported copy of a built-in this or an earlier release shipped is trusted like the built-in, with no switch.
    if (entry.source === 'built-in' || (await releasedTemplates).has(entry.hash) || await library.isBuiltIn(entry.hash)) return { ...entry, networkTrust: 'built-in' as const };
    const allowed = new Set(await trust.allowed(entry.hash));
    return entry.network.every((origin) => allowed.has(origin)) ? { ...entry, networkTrust: 'allowed' as const } : entry;
  }));
}

/** Saves an open book's template into the library for an agent, then renders its picture as an import does. */
async function saveBookTemplate(folder: string, replaceHash: string | undefined, signal: AbortSignal) {
  const result = await saveTemplateToLibrary(library, await templateFolder(folder), replaceHash, signal);
  if (result.status === 'saved' || result.status === 'replaced') {
    void saveTemplatePreview(result.template.id).catch((error) => console.warn('ImageFlow could not render a template preview', error));
  }
  return result;
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
/** Coming back to a book that syncs looks at its sync folder again, at most every few seconds (#251). */
const syncLooked = new WeakMap<DocumentSession, number>();
function refreshSyncOnFocus(document: DocumentSession) {
  if (!document.syncView || Date.now() - (syncLooked.get(document) ?? 0) < 5000) return;
  syncLooked.set(document, Date.now());
  void document.refreshSync().catch((error) => console.warn('ImageFlow could not read the sync status', error));
}

/** Syncs the focused book with its sync folder (#251), or asks for a folder first. */
async function syncDocument(document: DocumentSession) {
  if (!await document.syncFolder()) { await linkSyncFolder(document); return; }
  await document.syncNow();
}

/** Lets the book sync through a folder the user chooses, such as one in iCloud Drive or Dropbox, then syncs. */
async function linkSyncFolder(document: DocumentSession) {
  const current = await document.syncFolder();
  const choice = await dialog.showOpenDialog(document.window, { title: 'Sync with Folder', buttonLabel: 'Sync', properties: ['openDirectory', 'createDirectory'],
    message: 'Choose a folder that your Macs share, for example in iCloud Drive or Dropbox. Every Mac syncing this book chooses the same folder.',
    ...(current ? { defaultPath: current } : {}) });
  const folder = choice.filePaths[0];
  if (choice.canceled || !folder || document.closing) return;
  if (within(document.book.folder, folder) || folder === document.book.folder) throw new Error('Choose a folder outside the book.');
  // A folder without this book either has never seen it, or has not finished downloading what another Mac synced; a
  // first sync now would start a second history there, which shows later as changed on two Macs.
  if (await document.startsHistory(folder)) {
    const { response } = await dialog.showMessageBox(document.window, { type: 'question', buttons: ['Start Syncing', 'Cancel'], defaultId: 0, cancelId: 1,
      message: 'Start syncing “' + bookName(document.book.folder) + '” in “' + basename(folder) + '”?',
      detail: 'This folder has no copy of this book yet. If another Mac already syncs it to this folder, cancel and wait until the folder has finished downloading here.' });
    if (response !== 0) return;
  }
  await document.linkSync(folder);
  await document.syncNow();
}

async function unlinkSyncFolder(document: DocumentSession) {
  const folder = await document.syncFolder();
  if (!folder) return;
  const { response } = await dialog.showMessageBox(document.window, { type: 'question', buttons: ['Stop Syncing', 'Cancel'], defaultId: 0, cancelId: 1,
    message: 'Stop syncing this book on this Mac?', detail: 'The book and the sync folder “' + basename(folder) + '” stay as they are. Other Macs keep syncing.' });
  if (response === 0) await document.unlinkSync();
}

/**
 * Open from Sync Folder (#251): lists the books another Mac synced to a folder, by the titles in their commit headers,
 * and makes a new local book from the one chosen. It starts untrusted (ADR 0006).
 */
async function openFromSyncFolder(owner: BrowserWindow | undefined) {
  const parent = owner && !owner.isDestroyed() ? owner : undefined;
  const ask = <T extends Electron.MessageBoxOptions>(options: T) => parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options);
  const options = { title: 'Open from Sync Folder', buttonLabel: 'Choose', properties: ['openDirectory' as const],
    message: 'Choose the folder another Mac syncs its books to, for example in iCloud Drive or Dropbox.' };
  const choice = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
  const folder = choice.filePaths[0];
  if (choice.canceled || !folder) return;
  const remote = new FolderRemote(folder);
  const books = await remoteBooks(remote);
  if (!books.length) {
    await ask({ type: 'info', message: 'There are no ImageFlow books in this folder yet.',
      detail: 'Sync a book to it on another Mac (File → Sync → Sync with Folder…), wait until the folder has finished syncing here, then try again.' });
    return;
  }
  let book = books[0];
  if (books.length > 1) {
    const shown = books.slice(0, 6);
    const { response } = await ask({ type: 'question', buttons: [...shown.map(({ title, newer }) => newer ? 'A Book Synced by a Newer ImageFlow' : title || 'Untitled'), 'Cancel'], cancelId: shown.length, defaultId: 0,
      message: 'Which book do you want to open?', detail: books.length > shown.length ? 'The ' + shown.length + ' most recently synced books are shown.' : undefined });
    if (!shown[response]) return;
    book = shown[response];
  }
  if (book.newer) {
    await ask({ type: 'info', message: 'This book was synced by a newer version of ImageFlow.', detail: 'Update ImageFlow to open it.' });
    return;
  }
  const tipId = book.tips.length === 1 ? book.tips[0].commitId : parent ? await chooseSyncTip(parent, book.tips) : book.tips.at(-1)!.commitId;
  const tip = book.tips.find(({ commitId }) => commitId === tipId);
  if (!tip) return;
  const saveOptions = { title: 'Save Book from Sync Folder', buttonLabel: 'Save',
    defaultPath: join(app.getPath('documents'), (book.title || 'Untitled').replace(/[/\\:]/g, '-') + '.imageflow'), filters: [{ name: 'ImageFlow Book', extensions: ['imageflow'] }] };
  const save = parent ? await dialog.showSaveDialog(parent, saveOptions) : await dialog.showSaveDialog(saveOptions);
  if (save.canceled || !save.filePath) return;
  const path = await cloneFromRemote({ remote, tip, destination: documentPath(save.filePath), syncFolder: folder });
  const document = await openDocument(path);
  if (document && settings.value.keepOriginals) void document.downloadSyncedOriginals().catch((error) => report(document.window, error));
}

async function syncCommand(document: DocumentSession, action: SyncAction) {
  if (action === 'sync') await syncDocument(document);
  else if (action === 'download') await document.downloadSyncedOriginals();
  else if (action === 'link') await linkSyncFolder(document);
  else if (action === 'unlink') await unlinkSyncFolder(document);
  else throw new Error('Unknown sync action.');
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
      { id: 'check-updates', label: 'Check for Updates…', click: () => { showSettings('general'); updates.check(); } },
      { id: 'restart-update', label: 'Restart to Update', enabled: updates.state.status === 'ready', click: () => updates.restart() },
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
      registered('export'), { type: 'separator' },
      { id: 'open-sync-folder', label: 'Open from Sync Folder…', click: (_item, owner) => {
        const window = owner ? BrowserWindow.fromId(owner.id) ?? undefined : undefined;
        void openFromSyncFolder(window).catch((error) => report(window ?? startWindow, error));
      } },
      { label: 'Sync', submenu: ([['sync-now', 'Sync Now', 'sync'], ['sync-download', 'Download Originals', 'download'], ['sync-link', 'Sync with Folder…', 'link'],
        ['sync-unlink', 'Stop Syncing This Book…', 'unlink']] as const).flatMap(([id, label, action]) => [
        ...id === 'sync-link' ? [{ type: 'separator' as const }] : [],
        { id, label, enabled: false, click: (_item: Electron.MenuItem, owner?: BaseWindow) => {
          const document = focusedDocument(owner);
          if (document && !document.closing) void syncCommand(document, action).catch((error) => report(document.window, error));
        } }]) },
      { type: 'separator' }, registered('reveal-book'),
    ] },
    { label: 'Edit', submenu: [
      registered('undo'), registered('redo'),
      { role: 'undo', id: 'native-undo', visible: false, acceleratorWorksWhenHidden: false },
      { role: 'redo', id: 'native-redo', visible: false, acceleratorWorksWhenHidden: false },
      { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'delete' }, { role: 'selectAll' },
    ] },
    { label: 'Book', submenu: [
      registered('add-spread'), registered('duplicate-spread'), registered('delete-spread'),
      { type: 'separator' }, registered('move-spread-up'), registered('move-spread-down'), registered('swap-pages'),
      { type: 'separator' }, registered('manage-sources'), registered('copy-assets', 'copy-assets', 'checkbox'),
      { type: 'separator' }, registered('book-check'),
    ] },
    { label: 'Templates', submenu: [{ label: 'Manage Templates…', click: () => showTemplates() },
      { type: 'separator' }, { id: 'rebuild-dependencies', label: 'Rebuild Template Dependencies', enabled: false, click: (_item, owner) => void rebuildBookDependencies(owner) },
      { id: 'stop-trusting-book', label: 'Stop Trusting This Book’s Template…', enabled: false, click: (_item, owner) => void stopTrustingBook(owner) }] },
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
  if (!inBook) { state.editing = true; state.canExport = false; }
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
  const stopTrusting = menu?.getMenuItemById('stop-trusting-book');
  if (stopTrusting) stopTrusting.enabled = state.document;
  const rebuild = menu?.getMenuItemById('rebuild-dependencies');
  if (rebuild) rebuild.enabled = state.document && state.writable;
  const sync = document && !document.closing ? document.syncView : undefined;
  const syncEnabled: Record<string, boolean> = { 'sync-now': state.document && state.writable && !sync?.syncing,
    'sync-download': !!sync && !sync.syncing && (sync.status?.pendingOriginals ?? 0) > 0, 'sync-link': state.document && state.writable && !sync?.syncing,
    'sync-unlink': !!sync && !sync.syncing };
  for (const [id, enabled] of Object.entries(syncEnabled)) { const item = menu?.getMenuItemById(id); if (item) item.enabled = enabled; }
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
    await writeFile(file, claudeExtension({ launch, version: app.getVersion(), tools: mcpTools, icon: await readFile(join(app.getAppPath(), 'extension-icon.png')) }));
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
  if (target === 'skill') {
    const file = join(app.getPath('downloads'), 'imageflow-templates.zip');
    await writeFile(file, await skillArchive(join(app.getAppPath(), 'skills', 'imageflow-templates')));
    shell.showItemInFolder(file);
    return 'Saved imageflow-templates.zip to Downloads. Upload it in Claude under Settings → Capabilities → Skills, or unzip it into ~/.claude/skills for Claude Code.';
  }
  if (target === 'codex') {
    const codex = await findCodex();
    if (!codex) throw new Error('Neither the ChatGPT desktop app nor the Codex CLI was found. Install one, or add the configuration under Other agents manually.');
    await addToCodex(codex, launch);
    return 'Added ImageFlow to ChatGPT and Codex. Start a new task in ChatGPT or Codex to load its tools.';
  }
  throw new Error('Unknown agent.');
}


function appWindows() { return [...documents.values()].map((document) => document.window).concat([...markdownWindows.windows(), startWindow, settingsWindow, templatesWindow, ...[...assetsWindows.values()].map(({ window }) => window)].filter((window): window is BrowserWindow => !!window)); }
function updateWindows() { return [...appWindows(), ...[...openingEditors.values()].map(({ window }) => window), ...[...pickers.values()].map(({ window }) => window)].filter((owner) => !owner.isDestroyed()); }
function updateStateFor(owner: BrowserWindow) {
  const windows = updateWindows();
  const focused = BrowserWindow.getFocusedWindow();
  const target = focused && windows.includes(focused) ? focused : lastDocument?.window ?? windows.find((window) => window.isVisible()) ?? startWindow;
  return { ...updates.state, installedVersion: app.getVersion(), notice: owner === target };
}
function publishUpdates() {
  if (!updates) return;
  for (const owner of updateWindows()) owner.webContents.send(channels.updateChanged, updateStateFor(owner));
}

// The plugin ships beside the app in development and in Contents/Resources in a package. IMAGEFLOW_LIGHTROOM_MODULES
// points a development build at another Modules folder, so trying the install never touches Lightroom's own.
const lightroomLocations = () => ({ bundled: join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'ImageFlow.lrplugin'),
  modules: (!app.isPackaged && process.env.IMAGEFLOW_LIGHTROOM_MODULES) || defaultModules() });
async function lightroomState(): Promise<LightroomState> {
  const connection = lightroom?.connection;
  return { plugin: await pluginStatus(lightroomLocations()),
    ...(connection ? { connection: { plugin: connection.plugin.version, ...(connection.catalog.name ? { catalog: connection.catalog.name } : {}) } } : {}) };
}
async function publishLightroom() {
  if (!settingsWindow || settingsWindow.isDestroyed()) return;
  const state = await lightroomState().catch(() => undefined);
  if (state && settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.webContents.send(channels.lightroomChanged, state);
}

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
  if (quitting || preparingQuit) throw new Error('ImageFlow is closing.');
  const connection = await createMcpConnection({
    descriptorPath: mcpDescriptorPath(),
    onClientsChanged: (clients) => { mcpClients = clients; publishMcpSettings(); },
    onCall: async (name, args, signal, client) => {
      try {
        if (name === 'list_projects') {
          const results = await Promise.all([...documents.values()].filter((document) => !document.closing)
            .map((document) => document.agentCall(name, args, signal)));
          return { projects: results.flatMap((result) => 'projects' in result && Array.isArray(result.projects) ? result.projects : []),
            scope: 'Open, authorized books. Select an explicit project handle; focus does not change the target. Handles expire when the book closes.' };
        }
        if (name === 'list_templates') return { templates: (await libraryWithTrust()).map(agentLibraryEntry) };
        const document = [...documents.values()].find((document) => !document.closing && document.projectSession.handle === args.project);
        if (!document) throw new AuthoringError('PROJECT_CLOSED', 'This book is no longer open. Call list_projects for current handles.');
        // Queued with the book's other agent calls, so closing the book waits for the save.
        if (name === 'save_template_to_library') return await document.queue.run((queued) => saveBookTemplate(document.book.folder, args.replaceHash as string | undefined, queued), signal);
        return await document.agentCall(name, args, signal, client);
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
  settings = new SettingsStore(join(app.getPath('userData'), 'settings.json'), { ...defaultSettings, updateChannel: releaseChannel(app.getVersion()) ?? 'stable' });
  recents = new RecentDocuments(join(app.getPath('userData'), 'recent-documents.json'));
  await Promise.all([settings.load(), recents.load()]);
  configureSourceStore(join(app.getPath('userData'), 'source-cache'));
  configureSourceAccess(join(app.getPath('userData'), 'source-access'));
  configurePersistence(join(app.getPath('userData'), 'persistence'));
  // Sync proxies of photos whose originals are not on this Mac (ADR 0010); kept with the other caches, never in books.
  void configureProxyStore(join(app.getPath('userData'), 'Cache', 'proxies')).catch((error) => console.warn('ImageFlow could not open the sync proxy cache', error));
  // Photos of a Lightroom Classic catalog are read through the plugin; until it connects they are offline.
  lightroom = new LightroomBridge({ file: join(app.getPath('userData'), 'lightroom-bridge.json'), version: app.getVersion() });
  registerProvider(lightroomProvider(lightroom));
  lightroom.onConnection(() => void publishLightroom());
  void lightroom.start().catch((error) => console.warn('ImageFlow could not start the Lightroom bridge:', errorMessage(error)));
  nativeTheme.themeSource = settings.value.appearance;
  const checkFeed = () => checkUpdateFeed({ baseURL: updateTestConfiguration?.baseURL ?? updateBaseURL,
    channel: settings.value.updateChannel, platform: process.platform + '-' + process.arch, installed: app.getVersion(),
    request: net.fetch as typeof fetch, current: () => updates.current(), native: autoUpdater });
  updates = new AppUpdater({
    pending: true,
    driver: {
      // Every check reads the selected channel and sets the feed, so the first check needs no separate setup.
      initialize: () => checkFeed(),
      check: () => checkFeed(),
      install: () => autoUpdater.quitAndInstall(),
    },
    changed: (state) => {
      publishUpdates();
      const restart = Menu.getApplicationMenu()?.getMenuItemById('restart-update');
      if (restart) restart.enabled = state.status === 'ready';
    },
    quit: () => app.quit(),
  });
  autoUpdater.on('error', (error) => updates.failed(error));
  autoUpdater.on('update-available', () => updates.available());
  autoUpdater.on('update-not-available', () => updates.current());
  autoUpdater.on('update-downloaded', (_event, _notes, name) => updates.downloaded(name));
  cache = await mkdtemp(join(app.getPath('temp'), 'imageflow-cache-'));
  // IMAGEFLOW_TEMPLATES points tests and development at another library folder.
  library = new TemplateLibrary(process.env.IMAGEFLOW_TEMPLATES || join(app.getPath('userData'), 'Templates'),
    starters.map((starter) => ({ template: join(sampleFolder(starter.folder), 'template'), sample: sampleFolder(starter.folder),
      defaultName: starter.defaultName })),
    probeTemplate, (path) => shell.trashItem(path), capabilities.join(',') + '@' + app.getVersion(), join(__dirname, 'authoring-types'),
    // Built-in templates ship renders of their opening spreads; later ones are kept with the app's other caches.
    renderPreviewsTo ? { cache: renderPreviewsTo } : {
      shipped: join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'template-previews'),
      cache: join(app.getPath('userData'), 'Cache', 'template-previews'),
    });
  library.onChange(publishLibrary);
  trust = new TemplateTrust(join(app.getPath('userData'), 'template-trust.json'));
  releasedTemplates = ReleasedTemplates.read(sampleFolder('released-templates.json'));
  const renditions = await configureRenditionCache(cache, join(app.getPath('userData'), 'Cache', 'renditions'));
  await maintainSources();
  const sourceMaintenance = setInterval(() => { if (![...documents.values()].some((document) => document.busy)) void maintainSources(); }, 5 * 60 * 1000);
  sourceMaintenance.unref();
  await pruneRenditions(renditions).catch((error) => console.warn('ImageFlow could not prune image previews', error));
  await pruneProxies();
  powerMonitor.on('resume', () => { for (const document of documents.values()) document.projectSession.inputs.invalidate(); });
  app.on('browser-window-focus', () => { updateMenus(); publishUpdates(); });
  if (!app.isPackaged && process.env.IMAGEFLOW_BENCHMARK === '1') {
    Object.defineProperty(globalThis, 'imageflowBenchmarkInputs', { value: () => lastDocument?.projectSession.inputs.metrics });
  }
  let quitApproved = false;
  // How long Quit waits for a book window to acknowledge that it is saving its input, before asking whether to quit anyway.
  const quitAcknowledgeMs = 10_000;
  app.on('before-quit', (event) => {
    if (quitApproved) { quitting = true; updates.dispose(); clearInterval(sourceMaintenance); return; }
    event.preventDefault();
    if (preparingQuit) return;
    preparingQuit = true;
    const locked: DocumentSession[] = [];
    const prepared: DocumentSession[] = [];
    const forceClose = new Set<DocumentSession>();
    void (async () => {
      // Source editors flush pending keystrokes and retain their existing cancel/failure prompts.
      for (const document of documents.values()) if (!await markdownWindows.closeFor(document)) return;
      await Promise.allSettled([...opening.values()]);
      for (const document of documents.values()) {
        if (document.closing || document.window.isDestroyed()) continue;
        const deadline = Date.now() + 30_000;
        while (document.busy && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
        if (document.busy) throw new Error('Wait for the book to finish saving or exporting, then try again.');
        if (document.closing || document.window.isDestroyed()) continue;
        const contents = document.window.webContents;
        if (contents.isCrashed() || contents.isLoadingMainFrame()) { forceClose.add(document); continue; }
        // The renderer blurs plain fields and drains its save queue before freezing new input.
        // Keep main-side saves available until that acknowledgement arrives.
        prepared.push(document);
        const id = randomUUID();
        const allowed = await new Promise<boolean | undefined>((resolve) => {
          // A live renderer acknowledges at once, then may take as long as its pending save needs. Only a missing
          // acknowledgement, Electron's own hang detection or a very long silence counts as "not responding". A window
          // in the background of a slow Mac can take several seconds to answer: 3 s asked whether to quit a working window.
          let timer = setTimeout(() => finish(undefined), quitAcknowledgeMs);
          const hung = () => finish(undefined);
          const finish = (allowed: boolean | undefined) => {
            clearTimeout(timer); quitReplies.delete(id);
            if (!document.window.isDestroyed()) document.window.off('unresponsive', hung);
            resolve(allowed);
          };
          document.window.once('unresponsive', hung);
          quitReplies.set(id, { sender: contents.id, resolve: finish, ack: () => {
            clearTimeout(timer);
            timer = setTimeout(() => finish(undefined), 120_000);
          } });
          contents.send(channels.prepareQuit, id);
        });
        if (contents.isDestroyed() || contents.isCrashed()) { forceClose.add(document); continue; }
        if (allowed === undefined) {
          const { response } = await dialog.showMessageBox(document.window, { type: 'warning',
            message: 'This book window is not responding.',
            detail: 'Quit anyway? Unsaved changes in this window may be lost. Saved book changes will be kept.',
            buttons: ['Keep Open', 'Quit Anyway'], defaultId: 0, cancelId: 0 });
          if (response !== 1) return;
          forceClose.add(document);
          continue;
        }
        if (!allowed) {
          focus(document.window);
          throw new Error('Finish or discard the active edit in this book, then try quitting or restarting again.');
        }
        if (document.busy) throw new Error('Wait for the book to finish saving or exporting, then try again.');
        document.busy = true;
        locked.push(document);
      }
      quitApproved = true;
      quitting = true;
      // Native close callbacks settle writers and release book locks in the ordinary will-quit cleanup.
      // Their busy guard must be released now that renderer input is frozen.
      for (const document of locked) document.busy = false;
      for (const document of forceClose) if (!document.window.isDestroyed()) document.window.destroy();
      app.quit();
    })().catch((error) => report(lastDocument?.window, error)).finally(() => {
      preparingQuit = false;
      if (!quitApproved) {
        updates.cancelRestart();
        for (const document of locked) document.busy = false;
        for (const document of prepared) if (!document.window.isDestroyed()) document.window.webContents.send(channels.cancelQuit);
      }
    });
  });
  ipcMain.on(channels.prepareQuitAck, (event, id: unknown) => {
    if (typeof id !== 'string') return;
    const reply = quitReplies.get(id);
    if (reply?.sender === event.sender.id && editorOwner(event)) reply.ack();
  });
  ipcMain.on(channels.prepareQuitReply, (event, id: unknown, allowed: unknown) => {
    if (typeof id !== 'string') return;
    const reply = quitReplies.get(id);
    if (reply?.sender === event.sender.id && editorOwner(event)) reply.resolve(allowed === true);
  });
  app.on('will-quit', (event) => {
    if (quitReady) return;
    event.preventDefault();
    quitCleanup ??= (async () => {
      await connectionSettingsQueue;
      await disableMcp();
      // The plugin sees the bridge file go and waits for the next run of ImageFlow.
      await lightroom?.stop().catch(() => {});
      await Promise.allSettled([...opening.values()]);
      await Promise.allSettled([...closing]);
      await Promise.all([settings.settled(), recents.settled()]);
      await maintainSources();
      for (const job of previewJobs.values()) job.abort();
      await previewQueue;
      await rm(cache, { recursive: true, force: true });
      await pruneRenditions(renditions).catch((error) => console.warn('ImageFlow could not prune image previews', error));
      await pruneProxies();
    })().then(() => {
      quitReady = true;
      // Never call quitAndInstall until ordinary window close, saves and MCP/lock cleanup finish.
      if (!updates.finishQuit()) app.quit();
    }).catch((error) => {
      console.error('ImageFlow could not finish cleanup', error);
      updates.cancelRestart();
      quitReady = true;
      app.quit();
    });
  });
  protocol.handle(desktopScheme, async (request) => {
    try { return await serve(request); }
    catch (error) { console.error('ImageFlow could not serve a document resource', error); return new Response(null, { status: 404 }); }
  });
  ipcMain.handle(channels.popupMenu, async (event, items: unknown, point: unknown) => {
    const owner = appOwner(event) ?? pickerOwner(event) ?? assetsWindows.get(assetsOwner(event)!)?.window;
    if (!owner || !Array.isArray(items) || items.length > 80) return null;
    let selected: string | null = null;
    // A submenu, such as the texts a box can show, holds up to 500 items, one level deep.
    type Item = { type?: unknown; label?: unknown; id?: unknown; enabled?: unknown; checked?: unknown; toolTip?: unknown; submenu?: unknown } | null;
    const build = (items: Item[], depth = 0): MenuItemConstructorOptions[] => items.slice(0, 500).flatMap<MenuItemConstructorOptions>((item) => {
      if (item?.type === 'separator') return [{ type: 'separator' as const }];
      if (typeof item?.label !== 'string') return [];
      if (Array.isArray(item.submenu) && depth === 0) {
        return [{ label: item.label.slice(0, 160), enabled: item.enabled !== false, submenu: build(item.submenu as Item[], depth + 1) }];
      }
      const id = item.id;
      if (typeof id !== 'string') return [];
      return [{ label: item.label.slice(0, 160), enabled: item.enabled !== false,
        ...(typeof item.toolTip === 'string' ? { toolTip: item.toolTip.slice(0, 300) } : {}),
        ...(typeof item.checked === 'boolean' ? { type: 'checkbox' as const, checked: item.checked } : {}), click: () => { selected = id; } }];
    });
    const entries = build(items as Item[]);
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
      writable: !!document && (snapshot?.writable ?? true) };
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
  ipcMain.handle(channels.presentation, (event, spread: unknown) => {
    const document = editorOwner(event);
    if (!document || quitting || typeof spread !== 'string') return { error: 'Request is only available to an open book.' };
    try { presentationWindows.show(document, spread); return { value: undefined }; }
    catch (error) { return { error: errorMessage(error) }; }
  });
  ipcMain.handle(channels.presentationState, (event) => {
    const entry = presentationWindows.owner(event);
    return entry && !entry.document.closing ? { value: { summary: entry.document.summary, start: entry.spread } }
      : { error: 'This window has no presentation.' };
  });
  ipcMain.handle(channels.presentationSpread, (event, spread: unknown) => {
    const entry = presentationWindows.owner(event);
    if (entry) presentationWindows.select(entry, spread);
  });
  ipcMain.handle(channels.presentationClose, (event, spread: unknown) => {
    const entry = presentationWindows.owner(event);
    if (entry) { presentationWindows.select(entry, spread); presentationWindows.close(entry.document); }
  });
  ipcMain.handle(channels.toolbarDragRegions, (event, regions: unknown) => {
    const owner = editorOwner(event)?.window;
    if (owner && process.platform === 'darwin') setToolbarDragRegions(owner, regions);
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
    const files = (await Promise.all(entries.map((entry) => sourceOriginal(document.book.folder, entry).catch(() => undefined)))).filter((file) => file !== undefined);
    if (files.length) assetsWindows.get(document)?.window.webContents.startDrag({ file: files[0], files, icon: await app.getFileIcon(files[0]) });
  });
  // Document icons are the same for every file of a type, so they are looked up by extension and kept.
  const fileIcons = new Map<string, string>();
  ipcMain.handle(channels.fileIcons, async (event, extensions: unknown) => {
    const found: Record<string, string> = {};
    if (!(editorOwner(event) ?? assetsOwner(event)) || !Array.isArray(extensions) || extensions.length > 64) return found;
    for (const extension of extensions) {
      if (typeof extension !== 'string' || !/^[a-z0-9]{0,10}$/.test(extension)) continue;
      if (!fileIcons.has(extension)) {
        const icon = await app.getFileIcon(join(app.getPath('temp'), 'file' + (extension && '.' + extension))).then((image) => image.isEmpty() ? '' : image.toDataURL({ scaleFactor: 2 })).catch(() => '');
        fileIcons.set(extension, icon);
      }
      if (fileIcons.get(extension)) found[extension] = fileIcons.get(extension)!;
    }
    return found;
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
  ipcMain.handle(channels.current, async (event): Promise<Result<ProjectSummary>> => {
    const document = editorOwner(event) ?? assetsOwner(event);
    if (document && !document.closing) return { value: document.summary };
    const loading = openingEditors.get(event.sender.id);
    if (loading && trusted(event, loading.window, editorURL)) {
      try {
        const opened = await opening.get(loading.identity);
        if (opened?.window === loading.window && !opened.closing) return { value: opened.summary };
      } catch (error) { return { error: errorMessage(error) }; }
    }
    return { error: 'This window has no open book.' };
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
    if (typeof choice.id !== 'string' || (choice.start !== 'opening' && choice.start !== 'empty')) return { error: 'Choose a template.' };
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
        if (!document) return { value: null };
        await recents.remember(document.book.folder, document.book.project.title, entry.id);
        publishRecents();
      }
      else if (action === 'locate') {
        const choice = await dialog.showOpenDialog(owner, { title: 'Locate ' + entry.title, properties: ['openFile'],
          filters: [{ name: 'ImageFlow Book', extensions: ['imageflow'] }] });
        if (!choice.canceled && choice.filePaths[0]) {
          const document = await openDocument(choice.filePaths[0]);
          if (!document) return { value: null };
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
  ipcMain.handle(channels.showMarkdown, async (event, request: unknown) => {
    const document = editorOwner(event) ?? assetsOwner(event);
    if (!document || document.closing || quitting) return { error: 'Request is only available to an open book.' };
    try {
      // Only mutations take the book lock; dialogs and window loading must not block other editors' autosaves.
      if (!request || typeof request !== 'object') throw new Error('Choose a Markdown source.');
      if ('id' in request && typeof request.id === 'string') await markdownWindows.open(document, { id: request.id });
      else if ('name' in request && typeof request.name === 'string') await markdownWindows.open(document, { name: request.name });
      else throw new Error('Choose a Markdown source or a name for new text.');
      return { value: undefined };
    } catch (error) { return { error: errorMessage(error) }; }
  });
  ipcMain.handle(channels.markdownAction, async (event, request: MarkdownAction) => {
    const entry = markdownWindows.owner(event);
    if (!entry) return { error: 'Request is only available to this Markdown editor.' };
    try { return { value: await markdownWindows.action(entry, request) }; }
    catch (error) { return { error: errorMessage(error) }; }
  });
  ipcMain.handle(channels.sourceAction, (event, request: SourceAction) => fromBook(event, async (document) => {
    const owner = assetsOwner(event) ? assetsWindows.get(document)?.window ?? document.window : document.window;
    if (assetsOwner(event)) request = { ...request, accept: assetsWindows.get(document)?.accept };
    // The editor window learns of a change the Assets window made; a request that changed nothing (an import of files the
    // book holds already, F-046) tells it nothing, so it does not render the book again.
    const shown = document.summary.id;
    const activate = (summary: ProjectSummary) => { if (assetsOwner(event) && summary.id !== shown) document.notify({ value: summary }); return summary; };
    const keys = request.keys ?? (request.key ? [request.key] : undefined);
    if (keys && (!Array.isArray(keys) || keys.length > 1000 || !keys.every((key) => typeof key === 'string'))) throw new Error('Invalid asset selection.');
    const chosen = sourceEntries(document.book).filter(({ key }) => keys?.includes(key));
    const source = chosen[0];
    if (request.action === 'jump') {
      if (request.spread === coverInstance) {
        if (!document.book.project.cover || !document.menuState?.view) throw new Error('The active format does not show the exterior cover.');
      } else if (!document.book.project.spreads.some(({ id }) => id === request.spread)) throw new Error('This spread no longer exists.');
      document.window.webContents.send(channels.sourceCommand, { action: 'jump', spread: request.spread }); focus(document.window);
      return { summary: document.summary };
    }
    if (request.action === 'place') {
      if (!chosen.length) throw new Error('Select assets in the book.');
      document.window.webContents.send(channels.sourceCommand, { action: 'place', keys: chosen.map(({ key }) => key) }); focus(document.window);
      return { summary: document.summary };
    }
    if (request.action === 'reveal' || request.action === 'open' || request.action === 'preview') {
      if (!source) throw new Error('Choose a registered source.');
      const path = await sourceOriginal(document.book.folder, source);
      if (request.action === 'reveal') for (const entry of chosen) shell.showItemInFolder(await sourceOriginal(document.book.folder, entry));
      else if (request.action === 'open') { const error = await shell.openPath(path); if (error) throw new Error(error); }
      else owner.previewFile(path);
      return { summary: document.summary };
    }
    let next = document.book;
    let message: string | undefined;
    if (request.action === 'retry') return { summary: activate(await document.reload()) };
    if (request.action === 'launch') {
      // Offered only where the photo's provider offers it (`SourceProvider.repairs`). Once the plugin connects, the
      // provider's watch reports the photos and the book observes them again: nothing waits here.
      if (!chosen.some(({ key }) => document.book.sources?.[key]?.repairs?.includes('launch'))) throw new Error('These assets cannot be brought back by opening an app.');
      await launchLightroom();
      return { summary: document.summary, message: lightroom?.connection ? undefined : 'Opening Lightroom Classic. Its photos come back once the ImageFlow plugin connects.' };
    }
    // Photos without a file are materialized on the way; one whose source cannot produce it stays as it was.
    const unproduced: string[] = [];
    const collect = (chosenKeys?: readonly string[]) => document.copying(owner, (options) =>
      collectSources(document.book, chosenKeys, { ...options, failed: (photo) => unproduced.push(photo.name) }));
    const unproducedMessage = () => unproduced.length ? (unproduced.length === 1 ? unproduced[0] + ' could not be copied: its source could not produce the original.'
      : unproduced.length + ' photos could not be copied: their source could not produce the originals (' + unproduced.join(', ') + ').') : undefined;
    if (request.action === 'collect') { next = await collect(keys); message = unproducedMessage(); }
    else if (request.action === 'import') {
      // Photos, Markdown and files the template's file parameters accept; the Assets window supplies its own accept list.
      if (request.paths !== undefined && (!Array.isArray(request.paths) || request.paths.length > 1000 || !request.paths.every((path) => typeof path === 'string'))) throw new Error('Invalid import.');
      const result = await document.importFiles(owner, document.active.id, { paths: request.paths, accept: request.accept });
      if (!result) return { summary: document.summary };
      return { summary: activate(result.summary), message: importFeedback(result.imported.length, result.counts) };
    }
    else if (request.action === 'remove') {
      if (!keys?.length) throw new Error('Select assets first.');
      if (!await confirmRemoval(owner, document, chosen)) return { summary: document.summary };
      next = await removeSources(document.book, keys);
      document.projectSession.record(next, 'Remove assets', true, false);
      return { summary: activate(document.activate(next)) };
    }
    else if (request.action === 'rename') {
      if (!source || chosen.length !== 1) throw new Error('Choose one asset to rename.');
      next = await renameSource(document.book, source.key, request.name);
      if (next === document.book) return { summary: document.summary };
      message = 'Renamed to ' + sourceEntries(next).find(({ key }) => key === source.key)!.name + '.';
    }
    else if (request.action === 'locate-folder') {
      const choice = await dialog.showOpenDialog(owner, { title: 'Locate Missing Sources in Folder', buttonLabel: 'Locate',
        properties: ['openDirectory', 'treatPackageAsDirectory'] });
      if (!choice.canceled && choice.filePaths[0]) {
        // Every missing source the folder holds is located and approved, not only the selected ones (F-045): choosing
        // the folder is the approval, and the rest of a moved or re-approved folder would otherwise stay missing.
        const result = await relinkFolder(document.book, choice.filePaths[0]);
        next = result.book;
        const names = new Map(sourceEntries(document.book).map((entry) => [entry.key as string, entry.name]));
        message = result.repaired + ' sources located.' + (result.ambiguous.length ? ' Multiple matches need Locate… for: ' + result.ambiguous.map((key) => names.get(key) ?? 'a source').join(', ') : '');
      }
    } else {
      if (!source) throw new Error('Choose a registered source.');
      // A linked file, or a photo without a file; one in the package is in the book already.
      if (request.action === 'copy') { next = await collect(chosen.filter((entry) => sourceProvider(entry) !== 'package').map(({ key }) => key)); message = unproducedMessage(); }
      else if (request.action === 'locate' || request.action === 'replace') {
        // Locate is offered where the photo's provider offers it (`SourceProvider.repairs`); Replace is always a file.
        const status = document.book.sources?.[source.key];
        if (request.action === 'locate' && status && status.state !== 'available' && !status.repairs?.includes('locate')) throw new Error(source.name + ' cannot be located as a file.');
        if (source.kind === 'file' && !request.accept?.length) throw new Error('This template does not declare a compatible file parameter.');
        const choice = await dialog.showOpenDialog(owner, { title: request.action === 'replace' ? 'Replace Original' : 'Locate Original', properties: ['openFile'],
          filters: [{ name: source.kind === 'photo' ? 'Photos' : 'Source', extensions: source.kind === 'photo' ? ['jpg', 'jpeg', 'png', 'webp'] : source.kind === 'file' ? request.accept!.map((extension) => extension.slice(1)) : ['md'] }] });
        if (!choice.canceled && choice.filePaths[0]) next = await relocateSource(document.book, source.key, choice.filePaths[0], false, request.accept);
      } else throw new Error('Unknown source action.');
    }
    document.projectSession.record(next, 'Source location changed', false);
    return { summary: activate(document.activate(next)), message };
  }));
  ipcMain.handle(channels.syncState, (event): Result<unknown> => {
    const document = editorOwner(event);
    return document ? { value: document.syncView ?? null } : { error: 'Request is only available to an open book.' };
  });
  ipcMain.handle(channels.syncAction, async (event, action: unknown): Promise<Result<void>> => {
    const document = editorOwner(event);
    if (!document || quitting) return { error: 'Request is only available to an open book.' };
    if (action !== 'sync' && action !== 'download' && action !== 'link' && action !== 'unlink') return { error: 'Unknown sync action.' };
    try { await syncCommand(document, action); return { value: undefined }; }
    catch (error) { return { error: errorMessage(error) }; }
  });
  ipcMain.handle(channels.saveCopy, (event, includeAssets?: boolean) => fromEditor(event, async (document) => {
    if (includeAssets === undefined) {
      const answer = await dialog.showMessageBox(document.window, { type: 'question', message: 'Duplicate this book?',
        buttons: ['Duplicate', 'Cancel'], defaultId: 0, cancelId: 1, checkboxLabel: 'Include all files', checkboxChecked: true,
        detail: sourceEntries(document.book).some((entry) => sourceProvider(entry) !== 'package') ? 'Unchecked: linked files keep their full paths, and photos from other sources stay linked to them.' : undefined });
      if (answer.response !== 0) return null;
      includeAssets = answer.checkboxChecked;
    }
    if (typeof includeAssets !== 'boolean') throw new Error('Choose whether to include all files.');
    const choice = await dialog.showSaveDialog(document.window, { title: 'Duplicate Book', buttonLabel: 'Duplicate',
      defaultPath: join(app.getPath('documents'), bookName(document.book.folder) + ' Copy.imageflow'), filters: [{ name: 'ImageFlow Book', extensions: ['imageflow'] }] });
    if (choice.canceled || !choice.filePath) return null;
    let folder: string;
    try { folder = await document.copying(document.window, (options) => saveDocumentCopy(document.book, choice.filePath!, includeAssets!, undefined, false, options)); }
    catch (error) { if (error instanceof CopyCancelled) return null; throw error; }
    await openDocument(folder);
    return null;
  }));
  const loadingOwner = (event: IpcMainInvokeEvent) => {
    const loading = openingEditors.get(event.sender.id);
    return trusted(event, loading?.window, editorURL) ? loading!.window : undefined;
  };
  const updateOwner = (event: IpcMainInvokeEvent) => appOwner(event) ?? loadingOwner(event) ?? pickerOwner(event) ??
    assetsWindows.get(assetsOwner(event)!)?.window ?? markdownWindows.owner(event)?.window;
  ipcMain.handle(channels.updateState, (event) => { const owner = updateOwner(event); return owner ? updateStateFor(owner) : { status: 'unavailable' }; });
  ipcMain.handle(channels.dismissUpdate, (event) => { if (updateOwner(event)) updates.dismissNotice(); });
  ipcMain.handle(channels.checkUpdates, (event) => { if (updateOwner(event) && !preparingQuit && !quitting) updates.check(); });
  ipcMain.handle(channels.restartUpdate, (event) => { if (updateOwner(event) && !preparingQuit && !quitting) updates.restart(); });
  ipcMain.handle(channels.settings, (event) => appOwner(event) ? { value: settings.value } : { error: 'Request is only available to an app window.' });
  ipcMain.handle(channels.updateSettings, async (event, patch: unknown) => {
    if (!appOwner(event)) return { error: 'Request is only available to an app window.' };
    try {
      if (patch && typeof patch === 'object' && 'updateChannel' in patch && patch.updateChannel !== settings.value.updateChannel &&
          ['checking', 'downloading', 'ready'].includes(updates.state.status)) throw new Error('Finish the current update before changing channels.');
      if (patch && typeof patch === 'object' && 'agentAccess' in patch) throw new Error('Change agent access in Settings → Agents.');
      const previousChannel = settings.value.updateChannel;
      const value = await settings.update(patch);
      nativeTheme.themeSource = value.appearance;
      updates.setAutomatic(value.automaticUpdates);
      if (value.updateChannel !== previousChannel && value.automaticUpdates) updates.check();
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
      if (action === 'new') await createNewBook(owner, { id, start: 'opening' }, false);
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
      if ((await releasedTemplates).has(entry.hash) || await library.isBuiltIn(entry.hash)) throw new Error('This version ships with ImageFlow, which always allows its network access.');
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
        // The choice outlasts this run: the connection starts again when ImageFlow next opens.
        if (enabled !== undefined && !!settings.value.agentAccess !== enabled) await settings.update({ agentAccess: enabled });
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
  ipcMain.handle(channels.lightroom, async (event) => {
    if (!settingsOwner(event)) return { error: 'Request is only available to Settings.' };
    try { return { value: await lightroomState() }; }
    catch (error) { return { error: errorMessage(error) }; }
  });
  ipcMain.handle(channels.lightroomInstall, async (event) => {
    if (!settingsOwner(event)) return { error: 'Request is only available to Settings.' };
    try {
      const locations = lightroomLocations();
      const before = await pluginStatus(locations);
      const after = await installPlugin(locations);
      // A running Lightroom keeps the plugin it loaded at start until it is restarted.
      const running = !!lightroom?.connection || await lightroomRunning();
      return { value: { state: await lightroomState(), message: installMessage(before, after, running) } };
    } catch (error) { return { error: errorMessage(error) }; }
  });
  ipcMain.on(channels.agentLeaseReply, (event, id: string, reply: AgentLeaseReply) => { editorOwner(event)?.replyLease(id, reply); });
  ipcMain.handle(channels.import, (event, id: string, request: ImportRequest) => fromEditor(event, async (document) => {
    if (request.target && request.paths?.length) {
      document.currentBook(id);
      for (const source of sourceEntries(document.book).filter(({ kind }) => kind === request.kind)) {
        const path = await sourceOriginal(document.book.folder, source).catch(() => undefined);
        if (!path || path !== request.paths[0]) continue;
        const files = structuredClone({ project: document.book.project, photoIndex: document.book.photoIndex });
        const spread = scopeSpread(files.project.spreads.find(({ id }) => id === request.target!.spread), request.target.page);
        if (!spread) throw new Error('The spread changed.');
        spread.boxes[request.target.box] = { ...boxBase(spread.boxes[request.target.box]),
          ...(request.kind === 'photo' ? { photo: source.id } : { text: source.id }) };
        return { summary: document.activate(await document.projectSession.save(files, 'Place asset')), imported: [source.id] };
      }
    }
    return document.importFiles(document.window, id, request, undefined, true);
  }));
  ipcMain.handle(channels.network, async (event, id: string, origins: unknown) => {
    const document = editorOwner(event);
    if (!document || quitting) return { error: 'Request is only available to an open book.' };
    try { return { value: await document.editorNetwork(id, origins) }; }
    catch (error) { return { error: errorMessage(error) }; }
  });
  ipcMain.handle(channels.export, (event, id: string, surface?: unknown) =>
    fromEditor(event, (document) => document.exportBook(document.window, id, surface === 'cover' ? 'cover' : undefined)));
  ipcMain.handle(channels.cancel, (event) => { editorOwner(event)?.cancelExport(); });
  ipcMain.handle(channels.check, (event, id: string, request: AuthoringCheckRequest) => fromEditor(event, (document) => document.checkOpenBook(document.currentBook(id), request)));
  ipcMain.handle(channels.cancelCheck, (event) => { editorOwner(event)?.cancelCheck(); });
  ipcMain.handle(channels.bookMenu, (event, state: BookMenuState) => {
    const document = editorOwner(event);
    if (!document || !state || typeof state.enabled !== 'object' || !state.enabled ||
        typeof state.editing !== 'boolean' || typeof state.writable !== 'boolean' || typeof state.busy !== 'boolean') return;
    const previousLabels = JSON.stringify([document.menuState?.pageLabels, document.menuState?.coverBoxIds]);
    const pageLabels = Object.fromEntries(document.book.project.spreads.flatMap(({ id }) => {
      const label = state.pageLabels?.[id];
      return typeof label === 'string' ? [[id, label.slice(0, 100)]] : [];
    }));
    const coverBoxIds = Array.isArray(state.coverBoxIds) ? state.coverBoxIds.filter((id) => typeof id === 'string') : undefined;
    document.menuState = { ...emptyMenuState, ...state,
      pageLabels, coverBoxIds, enabled: Object.fromEntries(spreadCommands.map((id) => [id, state.enabled[id] === true])) as BookMenuState['enabled'] };
    if (previousLabels !== JSON.stringify([pageLabels, coverBoxIds])) publishAssets(document);
    document.window.setDocumentEdited(state.saving === true);
    if (typeof state.sidebar === 'boolean') document.sidebar = state.sidebar;
    if (typeof state.inspector === 'boolean') document.inspector = state.inspector;
    if (typeof state.sources === 'boolean') document.sources = state.sources;
    if (typeof state.guides === 'boolean') document.guides = state.guides;
    if (state.layout && (state.layout.mode === 'grid' || state.layout.mode === 'vertical') && gridColumns.includes(state.layout.columns as 1|2|3|4)) document.layout = state.layout;
    updateMenus();
  });
  // The panel shows the bundle's app icon; the credits line carries the same tagline as the start window.
  app.setAboutPanelOptions({
    applicationName: 'ImageFlow', applicationVersion: app.getVersion(),
    credits: 'Designed in code. Composed by eye.', copyright: '© 2026 The ImageFlow authors',
    website: 'https://github.com/wirhabenzeit/imageflow',
  });
  installMenu();
  if (renderPreviewsTo) {
    for (const entry of await library.list()) if (entry.source === 'built-in') await saveTemplatePreview(entry.id);
    app.quit();
    return;
  }
  ready = true;
  const paths = [...new Set([...(updateTestConfiguration ? [updateTestConfiguration.book] : []), ...pendingOpenFiles.splice(0), ...process.argv.filter(isSystemFile)])];
  if (paths.length) for (const path of paths) await openFromSystem(path);
  else if (devState) {
    try {
      const state = JSON.parse(await readFile(devState, 'utf8')) as { folder: string }[];
      for (const entry of state) await openDocument(entry.folder);
    } catch { /* No development documents to restore. */ }
  }
  if (!documents.size) showStart();
  updates.setAutomatic(settings.value.automaticUpdates);
  // Agent access the user turned on stays on across restarts, with new credentials for this run; installed bridges read
  // the connection file before each call, so agents reconnect without being set up again.
  if (settings.value.agentAccess && !quitting && !preparingQuit) {
    const restore = connectionSettingsQueue.then(async () => { if (!mcpConnection) await enableMcp(); });
    connectionSettingsQueue = restore.catch((error) => console.warn('ImageFlow could not restore agent access', error));
  }
  // Signature/filesystem checks must not delay creating the library or the first usable window.
  void updateUnavailable({ packaged: app.isPackaged, platform: process.platform,
    executable: process.execPath, downloads: app.getPath('downloads') }).then((reason) => {
      if (!quitting) updates.setEligibility(reason);
    }).catch((error) => {
      console.warn('ImageFlow could not prepare update checks', error);
      if (!quitting) updates.setEligibility('Could not prepare update checks. Reopen ImageFlow to try again.');
    });
  app.on('activate', () => { if (!documents.size && !openingEditors.size && !quitting) showStart(); });
  updateMenus();
});
