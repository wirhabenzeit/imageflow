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
import { originalPath } from './source-store';
// The file a source is: Show in Finder, Edit in Default App, Quick Look and dragging out need one, so a photo that is
// not a file has none of them (ADR 0011).
async function sourceOriginal(folder: string, entry: SourceEntry) {
  const file = fileSourceOf(entry);
  if (!file) throw new Error(entry.name + ' is not a file on this Mac.');
  return originalPath(folder, file);
}
import { fileSourceOf, sourceEntries, sourceProvider, sourceReach } from '../src/source-locations';
import type { SourceEntry } from '../src/source-locations';
import { assetPageLabels, assetUsage, usageLabel } from '../src/asset-usage';
import { importFeedback } from '../src/import-feedback';
import { configureSourceStore, pruneSourceCache, SourceStore } from './source-store';
import { bookTrusted, configureSourceAccess, trustBook } from './source-access';
import { app, autoUpdater, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, nativeTheme, net, powerMonitor, protocol, pushNotifications, safeStorage, shell } from 'electron';
import type { BaseWindow, IpcMainInvokeEvent, MenuItemConstructorOptions } from 'electron';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, isAbsolute, parse, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { channels, gridColumns, spreadCommands, desktopScheme, editorURL, renderOrigin, renderOrigins, settingsURL, startURL, starterURL, assetsURL, syncURL, templatesURL } from '../src/desktop';
import type { AgentLeaseReply, BookMenuState, Command, ImportRequest, LibraryAction, LibraryBook, LibraryRemote, LightroomState, OpenAction, ProjectSummary, RecentDocument, Result, SyncBook, SyncStatus, MarkdownAction, McpClientTarget, McpSettings, SourceAction, SyncAction, TemplateInfo } from '../src/desktop';
import type { ProjectFiles } from '../src/project';
import { renderPolicy } from './csp';
import { assetTypes, loadProject, renderData, TemplateCompileError } from './project';
import type { OpenProject } from './project';
import { photoFile } from './photos';
import { captureBookPreview, checkBookRender } from './preview';
import { PreviewError } from '../src/preview';
import { askForPhotosAccess, chooseSyncTip, DocumentSession, macName, photosPrivacySettings } from './document-session';
import { BookDownloads } from './downloads';
import { cloneFromRemote, describeSync, downloadName, originalsAway, unavailableStatus } from './sync-engine';
import { BookDeletedError, BookDeleteError, BookNotDeletedError, remoteTips } from './sync-remote';
import type { BookUsage, SyncRemote } from './sync-remote';
import { configureSyncSetup, readSyncState, startNewBook, startsWithSetup, SyncElsewhereError } from './sync-pull';
import { ClosedBookSyncs } from './sync-closed';
import { deleteFromSyncQuestion, libraryBook, libraryListing, limited, syncsWithRemote } from './sync-library';
import { insideBook, pendingUploadsText, SyncService, UntrustedBookError } from './sync-service';
import { cloudKitPush } from './sync-auto';
import { settleSyncSetup, syncExcludedBook as excludedFrom } from './sync-start';
import { syncSetupPatch } from './sync-settings';
import { cleanUp, cleanUpQuestion, cleanUpSummary, planCleanUp, unusedStorage } from './sync-sweep';
import type { CleanUpPlan } from './sync-sweep';
import { configureMacHeader, setToolbarDragRegions } from './mac-header';
import { showSavePanel } from './save-panel';
import type { RenderSessions } from './document-session';
import { AssetFacts } from './asset-facts';
import { createDocument, documentIdentity, documentPath, isDocument, RecentDocuments } from './documents';
import { SettingsStore } from './settings';
import { FileCredentialStore, MemoryCredentialStore } from './sync-credentials';
import type { CredentialStore } from './sync-credentials';
import { folderSyncFlag, forgetOtherCredentials, registerSyncSettings, setICloudEntitled, syncPatchError, usableBackend } from './sync-settings';
import { loadCloudKitNative } from './sync-store-cloudkit';
import type { CloudKitNative } from './sync-store-cloudkit';
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
import { agentLibraryEntry, readLibraryTemplate, saveTemplateToLibrary } from './library-tools';
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
import type { SentPhotos } from './lightroom/bridge';
import { parseResult, selectionResultSchema } from './lightroom/protocol';
import type { LightroomLocator, PhotosLocator } from '../src/source-locator';
import { showInPhotos } from './photos-show';
import { launchLightroom } from './lightroom/launch';
import { showInLightroom } from './lightroom/show';
import { defaultModules, installMessage, installPlugin, lightroomRunning, pluginStatus } from './lightroom/plugin-install';
import { lightroomProvider } from './providers/lightroom';
import { photosProvider } from './providers/photos';
import { photosLibrary } from './photos-library';
import { photosLocators, requireAccess } from './photos-drop';
import { backgroundPreviews } from './provided-photos';
import type { WantedPreview } from './provided-photos';
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
let syncWindow: BrowserWindow | null = null;
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
// The one backend every book syncs through on this Mac (`AppSettings.sync`): a bucket with the credentials stored for
// it (read at each use, so a key saved in Settings → Sync counts at once) and the commit headers this Mac has read.
// iCloud (#292) goes through the CloudKit addon, loaded once; it reports a build without the entitlements and never
// touches CloudKit there.
let cloudKitNative: CloudKitNative | undefined | null = null;
const cloudKit = () => (cloudKitNative === null ? (cloudKitNative = loadCloudKitNative()) : cloudKitNative);
// A setting that names iCloud in a build without the iCloud entitlements leaves sync off (`usableBackend`).
/** What the Sync window last showed that Clean Up would free (#285), which Clean Up then deletes. */
let cleanUpPlan: CleanUpPlan | undefined;
const syncService = new SyncService(() => usableBackend(settings?.value.sync), { credentials: () => syncCredentials(), cacheFolder: () => app.getPath('userData'), cloudKit,
  setup: () => settings?.value.syncSetup,
  booksUnchosen: () => !!settings?.value.syncBooksUnchosen,
  // CloudKit's account-change event (also sent without a change) reads the status of the open books again; it never
  // pushes (#284).
  accountChanged: () => { for (const document of documents.values()) void document.refreshSync().catch((error) => console.warn('ImageFlow could not read the sync status', error)); } });
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
    // The editor's frames, and the design proof, which renders the editor's revision and shares its pictures.
    if (!session?.pictures || !session.book.templateHash) return new Response(null, { status: 404 });
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
  if (host === 'editor' && ['/', '/settings', '/start', '/new', '/assets', '/templates', '/markdown', '/presentation', '/sync'].includes(pathname)) {
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
function syncOwner(event: IpcMainInvokeEvent) { return trusted(event, syncWindow, syncURL) ? syncWindow ?? undefined : undefined; }
/** The windows that list the library: the Start window and the Sync window. */
function libraryOwner(event: IpcMainInvokeEvent) { return startOwner(event) ?? syncOwner(event); }
function appOwner(event: IpcMainInvokeEvent) { return editorOwner(event)?.window ?? startOwner(event) ?? settingsOwner(event) ?? templatesOwner(event) ?? syncOwner(event); }
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
/**
 * Books that never start syncing by themselves (ADR 0012, section 3): the sample books that ship with the app, and the
 * books a template preview renders, which are staged in the app's cache. Read-only opens and untrusted books are told
 * apart by the sync service.
 */
const syncExcludedBook = (folder: string) => excludedFrom(folder, [sampleFolder(''), cache]);
/** The recent books on this Mac that can sync: without the sample and preview books. */
async function booksThatSync() {
  const entries = (await recents.list()).filter(({ available }) => available);
  const excluded = await Promise.all(entries.map(({ path }) => syncExcludedBook(path)));
  return entries.filter((_, index) => !excluded[index]);
}
function sampleFolder(name: string) {
  return sampleRoot ? join(sampleRoot, name) : app.isPackaged ? join(process.resourcesPath, 'sample', name) : join(app.getAppPath(), 'sample', name);
}
/** Removing a file that parameters still use clears those assignments, so the person confirms it first and sees where
 * it is used. Anything else is removed at once; every removal is one undoable edit. */
/**
 * Copy into Book cuts a linked file, a Lightroom Classic photo or an Apple Photos photo off from its source: later edits
 * there no longer reach the book. It asks first, and says that Lightroom or Photos produces each photo at full size on the way. When an original is
 * unavailable the copy fails anyway, so it does not ask.
 */
async function confirmCopy(owner: BrowserWindow, document: DocumentSession, entries: SourceEntry[]) {
  const copied = entries.filter((entry) => sourceReach(entry) !== 'book');
  if (!copied.length || copied.some(({ key }) => document.book.sources?.[key] && document.book.sources[key].state !== 'available')) return true;
  const lightroom = copied.filter((entry) => sourceProvider(entry) === 'lightroom').length;
  const photos = copied.filter((entry) => sourceProvider(entry) === 'photos').length;
  const files = copied.length - lightroom - photos;
  const what = copied.length === 1 ? copied[0].name : copied.length + ' ' + (files ? 'assets' : 'photos');
  const one = copied.length === 1;
  // Where the copied assets come from, in the order a sentence names them: "Lightroom Classic, Photos or their original files".
  const origins = [lightroom ? 'Lightroom Classic' : '', photos ? 'Photos' : '', files ? (one ? 'its original file' : 'their original files') : ''].filter(Boolean);
  const cut = (one ? 'It no longer follows ' : 'They no longer follow ') + (origins.length > 1 ? origins.slice(0, -1).join(', ') + ' or ' + origins.at(-1) : origins[0]);
  const rendered = (lightroom ? ' Lightroom renders ' + (lightroom === 1 ? 'the photo' : 'each photo') + ' at full size first, which can take a while.' : '')
    + (photos ? ' Photos hands over ' + (photos === 1 ? 'the photo' : 'each photo') + ' at full size first, downloading it from iCloud where needed.' : '');
  const answer = await dialog.showMessageBox(owner, { type: 'warning', buttons: ['Copy into Book', 'Cancel'], defaultId: 1, cancelId: 1,
    message: 'Copy ' + what + ' into the book?',
    detail: cut + ': later edits there won’t reach the book. The book grows by the size of the originals.' + rendered });
  return answer.response === 0;
}

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
/** The windows that list the library, as far as they are open. */
function libraryWindows() { return [startWindow, syncWindow].filter((window): window is BrowserWindow => !!window && !window.isDestroyed()); }
function publishRecents() { for (const window of libraryWindows()) window.webContents.send(channels.recentsChanged); }
/** What sync does with the books changed: told to the Sync window a few times a second at most. */
let syncBooksTimer: ReturnType<typeof setTimeout> | undefined;
function publishSyncBooks() {
  if (!syncWindow || syncWindow.isDestroyed()) return;
  syncBooksTimer ??= setTimeout(() => {
    syncBooksTimer = undefined;
    if (syncWindow && !syncWindow.isDestroyed()) syncWindow.webContents.send(channels.syncBooksChanged);
  }, 150);
}
/** The Sync window (#307): which books sync, what they take up and what is wrong with them. One, reused. */
function showSync() {
  if (quitting) return;
  if (!syncService.configured) { showSettings('sync'); return; }
  if (syncWindow && !syncWindow.isDestroyed()) { focus(syncWindow); return; }
  const owner = new BrowserWindow({ title: 'Synced Books', width: 720, height: 460, minWidth: 560, minHeight: 300,
    show: false, webPreferences: windowOptions() });
  syncWindow = owner;
  secureWindow(owner);
  owner.webContents.on('will-frame-navigate', (event) => event.preventDefault());
  owner.once('ready-to-show', () => focus(owner));
  owner.once('closed', () => { if (syncWindow === owner) syncWindow = null; });
  void owner.loadURL(syncURL).catch((error) => report(owner, error));
}
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
// Books closing because the app quits stay on the list: a restart after a main-process change reopens them.
async function saveDevState() {
  if (devState && !quitting && !preparingQuit) await writeFile(devState, JSON.stringify([...documents.values()].filter((document) => !document.closing)
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
      // A first sync that runs while the book is closed lets go of it; the open book's own sync goes on from there.
      await closedSyncs.stop(folder);
      release = await acquireProjectLock(folder);
      if (editor.isDestroyed()) return;
      // A book that cannot be locked fails without flashing an empty editor.
      if (!previous) reveal();
      loadStarted = true;
      // Opening a book waits for no previews: those this load wants are fetched once its session has started.
      const wanted: WantedPreview[] = [];
      const stopCollecting = backgroundPreviews(await realpath(folder), { wanted: (previews) => wanted.push(...previews), problem: () => undefined });
      const book = await loadProject(folder, cache).finally(stopCollecting);
      if (editor.isDestroyed()) return;
      if (quitting || preparingQuit) throw new Error('ImageFlow is closing.');
      document = new DocumentSession(editor, book, cache, sessions, release, (next) => {
        if (document) queueMicrotask(() => { if (document) publishAssets(document); });
        if (document) {
          void recents.refresh(next.folder, next.project.title, undefined, next.project.bookId).then(publishRecents).catch((error) => console.warn('ImageFlow could not update recent books', error));
          markCoverDirty(document);
        }
      });
      document.networkTrust = bookNetworkTrust;
      document.keepOriginals = () => settings.value.keepOriginals !== false;
      const tracked = document;
      document.syncChanged = () => {
        updateMenus();
        publishSyncBooks();
        libraryFollows(tracked);
        // A book that syncs here stays in the library beyond the most recent books (#283); while the remote cannot be
        // read (`unavailable`) tracking stays as it was.
        if (tracked.bookSync === 'unavailable') return;
        const syncs = tracked.bookSync === 'syncing';
        void recents.track(tracked.book.folder, syncs).then((changed) => { if (changed) publishRecents(); }).catch((error) => console.warn('ImageFlow could not update recent books', error));
      };
      document.cover = () => recentCover(tracked.book.folder);
      // Its originals follow at that open too, wherever it was downloaded: nothing else syncs a book that is up to date.
      const justDownloaded = downloadedBooks.delete(folder);
      document.announceSites = justDownloaded;
      document.syncService = syncService;
      document.syncAutomatically = () => settings.value.syncAutomatically !== false;
      const editing = document;
      document.textEditorsOpen = () => markdownWindows.windows().some((window) => markdownWindows.documentFor(window) === editing);
      document.syncExcluded = await syncExcludedBook(folder);
      const asking = document;
      asking.syncElsewhere = async () => { if (await offerSyncHere(asking)) void asking.syncNow().catch((error) => report(asking.window, error)); };
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
      document.wantPreviews(wanted);
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
            publishSyncBooks();
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
      if (justDownloaded && settings.value.keepOriginals !== false) void current.downloadSyncedOriginals().catch((error) => report(current.window, error));
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
  // Made while sync is set up: it syncs like the books that were turned on (ADR 0012, section 3).
  await startNewBook(folder).catch((error) => console.warn('ImageFlow could not note that the new book syncs', error));
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
    detail: 'Maps and other pictures that load from the internet stop drawing until you trust the book again.' +
      (syncService.configured ? ' The book also stops syncing on this Mac; other Macs keep syncing it.' : '') });
  if (response !== 0) return;
  // An untrusted book never continues syncing (ADR 0012, section 2): it stops on this Mac, and the remote is left as it
  // is. Through the session, so it waits for nothing and never interrupts a sync of the book.
  await document.stopTrusting();
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
/**
 * Coming back to a book that syncs looks at the remote again, at most every few seconds (#251): with Sync
 * automatically it pulls a fast-forward and pushes what waits, otherwise it reads the status (#284).
 */
const syncLooked = new WeakMap<DocumentSession, number>();
function refreshSyncOnFocus(document: DocumentSession) {
  if (!document.syncView || Date.now() - (syncLooked.get(document) ?? 0) < 5000) return;
  syncLooked.set(document, Date.now());
  document.focused();
}

/**
 * The network this Mac is on, as a signature that changes when it does (an interface or address comes or goes, or
 * the Mac goes offline): automatic syncs that back off after failures try again at once (#284).
 */
function networkSignature() {
  const addresses = Object.entries(networkInterfaces()).flatMap(([name, entries]) => (entries ?? []).filter((entry) => !entry.internal).map((entry) => name + ' ' + entry.address)).sort();
  return (net.isOnline() ? 'online' : 'offline') + '\n' + addresses.join('\n');
}
let networkSeen = '';
function watchNetwork() {
  networkSeen = networkSignature();
  const timer = setInterval(() => {
    const next = networkSignature();
    if (next === networkSeen) return;
    networkSeen = next;
    for (const document of documents.values()) document.autoSync.networkChanged();
  }, 10_000);
  timer.unref();
}

/**
 * Pushes from iCloud (#284): a database subscription with silent pushes, and the app registered for remote
 * notifications. A push names the database, not a book, so every open book looks at the remote, as on focus; a book's
 * look over iCloud reads only what changed in its zone. Inert where it fails: a bucket, an unsigned or unentitled
 * build, an iCloud that cannot be reached. Tried again when the backend changes to iCloud.
 */
let pushesRegistered: Promise<boolean> | undefined;
function registerSyncPushes() {
  if (process.platform !== 'darwin' || syncService.kind !== 'icloud' || pushesRegistered) return;
  const registering = pushesRegistered = (async () => {
    await pushNotifications.registerForAPNSNotifications();
    await syncService.subscribe();
    return true;
  })().catch((error: unknown) => {
    console.warn('ImageFlow syncs without pushes from iCloud', error);
    if (pushesRegistered === registering) pushesRegistered = undefined;
    return false;
  });
}

/**
 * Syncs the focused book through the configured remote (ADR 0012): Sync Now for a book that syncs here, and with
 * `start` (Start Syncing) one that does not. Without a backend, Settings opens where it is set up. A book that last
 * synced somewhere else is asked about first.
 */
async function syncDocument(document: DocumentSession, start: boolean, owner = document.window) {
  if (!syncService.configured) { showSettings('sync'); return; }
  try { await document.syncNow({ start }); }
  catch (error) {
    // Only trusted books sync: Start Syncing on one that is not asks once to trust it (ADR 0012, section 2).
    if (error instanceof UntrustedBookError) {
      if (await offerTrust(document, owner)) await document.syncNow({ start, trust: true });
      return;
    }
    if (error instanceof BookDeletedError) { await askRemoved(document, owner); return; }
    if (!(error instanceof SyncElsewhereError)) throw error;
    if (await offerSyncHere(document, owner)) await document.syncNow();
  }
}

/**
 * A book deleted from sync on another Mac (its tombstone) pushes nothing; this asks what becomes of it here (ADR 0012,
 * section 4): Keep Here Only stops syncing it on this Mac, and Sync Again makes it a new book on the remote.
 */
async function askRemoved(document: DocumentSession, owner = document.window) {
  if (document.closing || owner.isDestroyed()) return;
  const { response } = await dialog.showMessageBox(owner, { type: 'question', buttons: ['Keep Here Only', 'Sync Again', 'Cancel'], defaultId: 0, cancelId: 2,
    message: 'This book was deleted from sync on another Mac.',
    detail: 'Keep “' + bookName(document.book.folder) + '” on this Mac only, or sync it again as a new book? Copies on other Macs stay as they are.' });
  if (document.closing) return;
  if (response === 0) await document.stopSyncing();
  else if (response === 1) await syncAgainDocument(document, owner);
}

/** Sync Again through the open book's session, asking once to trust an untrusted book. */
async function syncAgainDocument(document: DocumentSession, owner = document.window) {
  try { await document.syncAgain(); }
  catch (error) {
    if (!(error instanceof UntrustedBookError)) throw error;
    if (await offerTrust(document, owner)) await document.syncAgain({ trust: true });
  }
}

/**
 * Asks once whether an untrusted book is trusted, so it can sync: older or copied books without declared sites, and
 * books from elsewhere. True when the user agreed; the caller trusts it as it starts syncing.
 */
async function offerTrust(document: DocumentSession, owner = document.window) {
  return !document.closing && await askTrust(owner, document.book.folder) && !document.closing;
}
/** The same question for a book, open or not, on the window that asked to sync it. */
async function askTrust(owner: BrowserWindow, folder: string) {
  if (owner.isDestroyed()) return false;
  const { response } = await dialog.showMessageBox(owner, { type: 'question', buttons: ['Trust and Sync', 'Cancel'], defaultId: 0, cancelId: 1,
    message: 'Trust this book and sync it?',
    detail: 'Only books you trust sync. “' + bookName(folder) + '” was not made on this Mac and was not trusted here. ' +
      'Trust it only if you made it or got it from someone you trust: its template may then load maps or data from the sites it declares without asking.' });
  return response === 0;
}

/**
 * A book that last synced with another remote (another backend, or a sync folder before ADR 0012) does not sync by
 * itself: this asks whether it starts here as a new history and saves the answer, rejecting when it cannot. Declining
 * stops syncing it on this Mac, so it is not asked again at every open; Start Syncing asks again. True when the book
 * now syncs here, for the caller to sync it.
 */
async function offerSyncHere(document: DocumentSession, owner = document.window) {
  if (document.closing) return false;
  const here = await askSyncHere(owner, document.book.folder);
  if (document.closing || here === undefined) return false;
  if (!here) { await document.stopSyncing(); return false; }
  // Only a trusted book starts syncing, here too.
  const trust = !await bookTrusted(document.book.folder);
  if (trust && !await offerTrust(document, owner)) { await document.stopSyncing(); return false; }
  await document.startSyncing({ newHistory: true, trust });
  return true;
}
/** The question for a book, open or not, on the window that asked; undefined when it could not be asked. */
async function askSyncHere(owner: BrowserWindow, folder: string) {
  if (owner.isDestroyed()) return undefined;
  const { response } = await dialog.showMessageBox(owner, { type: 'question', buttons: ['Start Syncing Here', 'Don’t Sync'], defaultId: 0, cancelId: 1,
    message: 'This book last synced somewhere else.',
    detail: 'Start syncing “' + bookName(folder) + '” with “' + (syncService.name ?? 'this Mac’s sync') + '”, as a new history? What it synced before stays where it is. ' +
      'If you don’t, it does not sync on this Mac until you choose File → Sync → Start Syncing.' });
  return response === 0;
}

/**
 * Turns on a book that is not open (#307), or syncs one again that was deleted from sync on another Mac (`again`): the
 * questions an open book asks are asked on the window that asked for it, then the book is synced without being opened.
 */
async function startClosed(owner: BrowserWindow, folder: string, again = false) {
  const options: { trust?: boolean; newHistory?: boolean } = {};
  for (;;) {
    try { await (again ? closedSyncs.syncAgain(folder, options) : closedSyncs.start(folder, options)); return; }
    catch (error) {
      if (error instanceof UntrustedBookError && !options.trust) {
        if (!await askTrust(owner, folder)) return;
        options.trust = true;
      } else if (error instanceof SyncElsewhereError && !options.newHistory) {
        // Declining leaves the book as it is: it did not sync here before either.
        if (!await askSyncHere(owner, folder)) return;
        options.newHistory = true;
      } else throw error;
    }
  }
}
/** The first syncs of books turned on in the Sync window while they are closed. */
const closedSyncs = new ClosedBookSyncs({ service: syncService, backend: () => JSON.stringify(settings.value.sync ?? null), lock: acquireProjectLock, device: macName(),
  hold: async (folder) => {
    const release = await acquireProjectLock(folder);
    const done = async () => {
      await SourceStore.release(folder).catch((error) => console.warn('ImageFlow could not release book sources', error));
      await AssetFacts.release(folder).catch((error) => console.warn('ImageFlow could not release asset facts', error));
      await release();
    };
    try {
      // As when a book opens, it waits for no previews; those it wants come when it is open.
      const stopCollecting = backgroundPreviews(await realpath(folder), { wanted: () => {}, problem: () => undefined });
      return { book: await loadProject(folder, cache).finally(stopCollecting), close: done };
    } catch (error) { await done(); throw error; }
  },
  cover: recentCover,
  changed: () => publishSyncBooks(),
  synced: (folder, book) => {
    libraryCache = librarySizes = undefined;
    void recents.refresh(folder, book.project.title, undefined, book.project.bookId).then(() => recents.track(folder, true)).catch((error) => console.warn('ImageFlow could not update recent books', error)).finally(publishRecents);
  } });

async function stopSyncingDocument(document: DocumentSession) {
  const { response } = await dialog.showMessageBox(document.window, { type: 'question', buttons: ['Stop Syncing', 'Cancel'], defaultId: 0, cancelId: 1,
    message: 'Stop syncing this book on this Mac?', detail: 'The book and its copy in “' + (syncService.name ?? 'sync') + '” stay as they are. Other Macs keep syncing.' });
  if (response === 0) await document.stopSyncing();
}

/**
 * The library (ADR 0012, section 5; #283): what the Start window lists of the configured remote, read once per session
 * and backend (Refresh, an action and a changed backend read it again), and each book's row, read as it comes into view.
 */
let libraryCache: { key: string; listing?: Promise<LibraryRemote>; books: Map<string, Promise<LibraryBook>> } | undefined;
/** Covers by book and digest, for the backend they were read from; content-addressed, so kept across refreshes. */
let libraryCovers: { key: string; covers: Map<string, Promise<string | undefined>> } | undefined;
/** Rows read four at a time, so a window full of books does not ask the remote for all of them at once. */
const libraryRows = limited(4);
function libraryState() {
  const key = JSON.stringify(usableBackend(settings.value.sync) ?? null);
  if (libraryCache?.key !== key) libraryCache = { key, books: new Map() };
  if (libraryCovers?.key !== key) libraryCovers = { key, covers: new Map() };
  return libraryCache;
}
async function libraryRemote(refresh = false) {
  if (!syncService.configured) return null;
  const state = libraryState();
  if (refresh) { state.listing = undefined; state.books.clear(); }
  const listing = state.listing ??= syncService.connect().then(({ remote, remoteId, name }) => libraryListing(remote, remoteId, name));
  // A listing that failed is not kept: the next look reads the remote again.
  listing.catch(() => { if (state.listing === listing) state.listing = undefined; });
  return listing;
}
/** A listing that lacks a book which just synced, or has one another Mac deleted, is read again. */
function libraryFollows(document: DocumentSession) {
  const state = document.syncView?.syncing ? undefined : document.syncView?.status?.state;
  const bookId = document.book.project.bookId;
  const cache = libraryCache;
  if (!bookId || !cache?.listing || (state !== 'in-sync' && state !== 'removed')) return;
  void cache.listing.then(({ books }) => {
    const there = books.find((book) => book.bookId === bookId);
    if (libraryCache !== cache || (state === 'removed' ? !there || there.deleted : there)) return;
    libraryCache = undefined;
    publishRecents();
  }, () => {});
}
async function libraryRow(bookId: string) {
  const state = libraryState();
  let book = state.books.get(bookId);
  if (!book) {
    const covers = libraryCovers!.covers;
    book = libraryRows(() => syncService.connect().then(({ remote }) => libraryBook(remote, bookId, covers)));
    state.books.set(bookId, book);
    const kept = book;
    kept.catch(() => { if (state.books.get(bookId) === kept) state.books.delete(bookId); });
  }
  return book;
}
/**
 * What books take up, for the backend they were counted on: kept until a book changes here or its row asks again, and
 * for a few minutes, since another Mac may change it too.
 */
let librarySizes: { key: string; sizes: Map<string, { read: Promise<BookUsage>; at: number }> } | undefined;
const sizesKept = 5 * 60_000;
/** What a book takes up on the remote (#307): two at a time, since over a bucket each is a listing of the whole book. */
const sizeReads = limited(2);
async function librarySize(bookId: string, refresh: boolean) {
  const key = JSON.stringify(usableBackend(settings.value.sync) ?? null);
  if (librarySizes?.key !== key) librarySizes = { key, sizes: new Map() };
  const { sizes } = librarySizes;
  const kept = sizes.get(bookId);
  if (kept && !refresh && Date.now() - kept.at < sizesKept) return kept.read;
  const counted = { read: sizeReads(() => syncService.connect().then(({ remote }) => remote.usage(bookId))), at: Date.now() };
  sizes.set(bookId, counted);
  counted.read.catch(() => { if (sizes.get(bookId) === counted) sizes.delete(bookId); });
  return counted.read;
}
/** How closed books stand with the remote, for their rows in the Sync window; two at a time. */
const statusReads = limited(2);
/** What sync does now with the books that are open or that it is busy with (#307), from this Mac alone. */
async function syncBooks(): Promise<SyncBook[]> {
  const name = syncService.name ?? '';
  const manage = syncService.kind === 'icloud' ? { manage: true as const } : {};
  return (await recents.list()).filter(({ available }) => available).flatMap((entry): SyncBook[] => {
    const session = openSession(entry.path);
    if (session) return [{ id: entry.id, open: true, view: session.syncView ?? null }];
    const closed = closedSyncs.state(entry.path), uploads = syncService.uploadState(entry.path);
    if (!closed && !uploads.uploading && !uploads.full && !uploads.failed) return [];
    const { failed } = closed ?? {};
    return [{ id: entry.id, view: { folder: name, ...(closed?.syncing ? { syncing: true } : {}), ...(closed?.sending ? { sending: closed.sending } : {}),
      ...(uploads.uploading?.total ? { uploading: uploads.uploading } : {}),
      ...(uploads.full ? { storageFull: { message: uploads.full.message, notUploaded: uploads.full.left, ...manage } } : failed?.full ? { storageFull: { message: failed.message, ...manage } } : {}),
      ...(!uploads.uploading && uploads.failed && uploads.failed.left !== 0 ? { uploadFailed: uploads.failed } : {}),
      ...(failed && !failed.full ? { status: unavailableStatus(failed.message, failed.access) } : {}) } }];
  });
}
/** Books downloaded from the library and not opened yet: their first open names the sites their template reaches, and brings their originals. */
const downloadedBooks = new Set<string>();
/** The books being downloaded (#305): the app's, so closing the window one was started in does not end it. */
const downloads = new BookDownloads(() => publishDownloads());
function publishDownloads() {
  const value = downloads.list();
  for (const window of libraryWindows()) window.webContents.send(channels.downloadsChanged, value);
}
/** Books whose Download is asking where to save (or which version): asked once, whichever window asks. */
const choosingDownload = new Set<string>();
/** Tests of a download's progress stand in for a slow remote (`IMAGEFLOW_SYNC_TEST_DOWNLOAD_MS`, development builds only). */
const downloadDelay = app.isPackaged ? 0 : Number(process.env.IMAGEFLOW_SYNC_TEST_DOWNLOAD_MS) || 0;
function slowRemote(remote: SyncRemote, signal: AbortSignal): SyncRemote {
  if (!downloadDelay) return remote;
  return new Proxy(remote, { get(target, name, receiver) {
    const value = Reflect.get(target, name, receiver) as unknown;
    if (typeof value !== 'function' || (name !== 'getBlob' && name !== 'downloadBlob')) return typeof value === 'function' ? value.bind(target) : value;
    return async (...args: unknown[]) => {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, downloadDelay);
        signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
      });
      return (value as (...values: unknown[]) => unknown).apply(target, args);
    };
  } });
}
/**
 * Download (#283): which version when there are several, where to save it (#303), then the download itself, which every
 * window shows with its progress and Cancel. Cancelled, it leaves nothing behind and opens nothing.
 */
async function downloadBook(owner: BrowserWindow, bookId: string) {
  // The Start window opens books; a book downloaded in the Sync window is only listed.
  const opens = owner === startWindow;
  if (downloads.has(bookId) || choosingDownload.has(bookId)) return;
  choosingDownload.add(bookId);
  let destination: string | undefined, tip: Awaited<ReturnType<typeof remoteTips>>[number] | undefined, connection: Awaited<ReturnType<SyncService['connect']>>;
  try {
    connection = await syncService.connect();
    const tips = await remoteTips(connection.remote, bookId);
    if (!tips.length) throw new Error('This book has not fully arrived in “' + connection.name + '” yet. Try again in a moment.');
    // Several versions (Macs changed it at once): which one to download.
    const tipId = tips.length === 1 ? tips[0].commitId : await chooseSyncTip(owner, tips);
    tip = tips.find(({ commitId }) => commitId === tipId);
    if (!tip || owner.isDestroyed()) return;
    destination = await chooseDownload(owner, tip.title);
  } finally { choosingDownload.delete(bookId); }
  if (!destination) return;
  const { remote, remoteId } = connection;
  const chosen = { tip, destination };
  const folder = await downloads.start(bookId, ({ signal, progress }) => cloneFromRemote({ remote: slowRemote(remote, signal), ...chosen, remoteId, progress, signal }));
  if (!folder) return;
  downloadedBooks.add(folder);
  libraryCache = undefined;
  if (quitting) return;
  if (!opens) {
    await recents.remember(folder, chosen.tip.title);
    await recents.track(folder, true);
    return;
  }
  await openDocument(folder);
}
/** Where Download saves a book, asked in a sheet of the window it was chosen in (#303); undefined when cancelled. */
async function chooseDownload(owner: BrowserWindow, title: string) {
  // Only a name: the panel opens where it was last used, so the app points at no folder the user did not choose.
  const choice = await dialog.showSaveDialog(owner, { title: 'Download Book', buttonLabel: 'Download',
    defaultPath: downloadName(title) + '.imageflow', filters: [{ name: 'ImageFlow Book', extensions: ['imageflow'] }] });
  if (choice.canceled || !choice.filePath || owner.isDestroyed()) return undefined;
  const destination = documentPath(choice.filePath), parent = dirname(destination);
  if (insideBook(await realpath(parent).catch(() => parent)) || insideBook(parent)) throw new Error('Choose a place outside every book.');
  return destination;
}
/** The cover the recent books keep of a book, as the bytes a push records (#283): a data URL made in the background, decoded here. */
async function recentCover(folder: string) {
  const url = await recents.coverOf(folder);
  return url?.startsWith('data:image/jpeg;base64,') ? new Uint8Array(Buffer.from(url.slice('data:image/jpeg;base64,'.length), 'base64')) : undefined;
}
/** The open session of the book at `folder`, if any. */
const openSession = (folder: string) => [...documents.values()].find((document) => !document.closing && document.book.folder === folder);
/** The recent books as the library lists them: each with this Mac's sync record of it, read without the remote. */
/**
 * The configured remote's identity for the library's local part: `null` with sync off, undefined when it cannot be read
 * now. The identity read last is used when there is one, so listing the books on this Mac sends no request of its own.
 */
async function configuredRemoteId(): Promise<string | null | undefined> {
  if (!syncService.configured) return null;
  return syncService.knownRemoteId ?? await syncService.connect().then(({ remoteId }) => remoteId, () => undefined);
}
async function libraryLocal(): Promise<RecentDocument[]> {
  const entries = await recents.list();
  const remoteId = await configuredRemoteId();
  const listed = await Promise.all(entries.map(async (entry) => {
    if (!entry.available) return entry;
    const state = await readSyncState(entry.path).catch(() => undefined);
    // As the book would at its next open (`SyncService.startsOnOpen`): one whose sites were not allowed yet does not.
    const starts = !!state && startsWithSetup(state, settings.value.syncSetup) && await bookTrusted(entry.path).catch(() => false);
    const sync = state ? { ...(state.remoteId ? { remoteId: state.remoteId } : {}), ...(state.enabled !== undefined ? { enabled: state.enabled } : {}), ...(starts ? { starts: true as const } : {}) } : undefined;
    // Books that sync with the configured remote stay tracked beyond the most recent ones (`RecentDocuments.track`);
    // while the remote cannot be read, tracking stays as it was.
    const syncs = syncsWithRemote(sync, remoteId);
    if (syncs !== undefined) await recents.track(entry.path, syncs).catch(() => {});
    return { ...entry, ...(sync ? { sync } : {}), ...(await syncExcludedBook(entry.path) ? { syncExcluded: true as const } : {}) };
  }));
  const ids = new Set(listed.map(({ id }) => id));
  // Tracking may have changed which entries are kept; the list follows it.
  return (await recents.list()).filter(({ id }) => ids.has(id)).map((entry) => ({ ...listed.find(({ id }) => id === entry.id)!, syncs: entry.syncs }));
}
/** The title a book has on this Mac or on the remote, for the questions about it. */
async function libraryTitle(bookId: string) {
  const local = (await recents.list()).find((entry) => entry.bookId === bookId);
  if (local) return local.title || bookName(local.path);
  return (await libraryCache?.books.get(bookId)?.catch(() => undefined))?.title || 'Untitled';
}

/**
 * The library's actions (#283), from the Start window and the Sync window. Delete from Sync is asked here, in the main process, every time:
 * the window names a book, never whether it was confirmed.
 */
async function libraryAction(owner: BrowserWindow, request: LibraryAction) {
  if (request.action === 'update') {
    if (updates.state.status === 'ready') updates.restart();
    else { showSettings('general'); updates.check(); }
    return;
  }
  if (request.action === 'cancel-download') { await downloads.cancel(request.bookId); return; }
  if (!syncService.configured) { showSettings('sync'); return; }
  const entry = 'id' in request ? await recents.get(request.id) : undefined;
  const bookId = 'bookId' in request ? request.bookId : entry?.bookId;
  if (request.action === 'download') {
    if (!bookId) throw new Error('Choose a book to download.');
    await downloadBook(owner, bookId);
    return;
  }
  if (request.action === 'delete') {
    if (!bookId) throw new Error('This book has not synced yet, so it is not in sync.');
    const title = entry?.title || (entry && bookName(entry.path)) || await libraryTitle(bookId);
    const local = (await recents.list()).filter((book) => book.available && book.bookId === bookId).map(({ path }) => path);
    // What goes with it: for a copy here, its originals that are not on this Mac (counted from its own files).
    const counts = await Promise.all(local.map((folder) => originalsAway(folder).catch(() => undefined)));
    const away = !counts.length || counts.some((count) => count === undefined) ? undefined : Math.min(...counts.map(Number));
    const { response } = await dialog.showMessageBox(owner, { type: 'warning',
      ...deleteFromSyncQuestion({ title, backend: syncService.name ?? 'sync', here: local.length > 0, away }) });
    if (response !== 0) return;
    const open = [...documents.values()].filter((document) => !document.closing && document.book.project.bookId === bookId);
    const folders = [...new Set([...local, ...open.map((document) => document.book.folder)])];
    await Promise.all(folders.map((folder) => closedSyncs.stop(folder)));
    // Nothing pushes the book by itself while it is deleted, also not when it closes meanwhile.
    for (const document of open) document.deleting = true;
    try { await syncService.deleteBook(bookId, { folders, settle: async () => { await Promise.all(open.map((document) => document.settleSync())); } }); }
    finally { for (const document of open) document.deleting = false; }
    libraryCache = librarySizes = undefined;
    for (const folder of folders) await recents.track(folder, false).catch(() => {});
    for (const document of open) void document.refreshSync().catch((error) => console.warn('ImageFlow could not read the sync status', error));
    return;
  }
  if (!entry) throw new Error('This recent book is no longer listed.');
  const folder = (await documentIdentity(entry.path)).folder;
  const session = openSession(folder);
  if (request.action === 'stop' || request.action === 'keep-here') {
    if (request.action === 'stop') {
      const { response } = await dialog.showMessageBox(owner, { type: 'question', buttons: ['Stop Syncing', 'Cancel'], defaultId: 0, cancelId: 1,
        message: 'Stop syncing “' + (entry.title || bookName(folder)) + '” on this Mac?', detail: 'The book and its copy in “' + (syncService.name ?? 'sync') + '” stay as they are. Other Macs keep syncing.' });
      if (response !== 0) return;
    }
    if (session) await session.stopSyncing();
    else {
      await closedSyncs.stop(folder);
      await syncService.stop(folder);
    }
    await recents.track(folder, false);
    return;
  }
  // Start Syncing and Sync Again ask what they ask (trust, a book that synced elsewhere) on the window they were chosen
  // in. An open book syncs in its window; one that is closed syncs without opening, except Sync Again in the Start
  // window, which opens books.
  if (!session && !(request.action === 'sync-again' && owner === startWindow)) {
    await startClosed(owner, folder, request.action === 'sync-again');
    return;
  }
  const document = session ?? await openDocument(folder);
  if (!document) return;
  await document.whenIdle();
  const asking = session ? owner : document.window;
  if (request.action === 'start') await syncDocument(document, true, asking);
  else if (request.action === 'sync-again') await syncAgainDocument(document, asking);
}

/** System Settings → Apple Account → iCloud, where its storage is managed; the Apple Account pane where that scene is unknown. */
const manageICloudStorage = 'x-apple.systempreferences:com.apple.systempreferences.AppleIDSettings:icloud';
async function syncCommand(document: DocumentSession, action: SyncAction) {
  if (action === 'sync' || action === 'start') await syncDocument(document, action === 'start');
  else if (action === 'download') await document.downloadSyncedOriginals();
  else if (action === 'cancel-download') document.cancelDownload();
  else if (action === 'stop') {
    if (document.bookSync !== 'syncing' && document.bookSync !== 'unavailable' && !document.sendingAhead) throw new Error('This book does not sync on this Mac.');
    await stopSyncingDocument(document);
  }
  else if (action === 'manage-storage') await shell.openExternal(manageICloudStorage);
  else throw new Error('Unknown sync action.');
}

/** The backend changed in Settings: every open book looks at where it syncs now, and the menus follow. */
function syncBackendChanged() {
  // The library reads the new remote.
  libraryCache = undefined;
  librarySizes = undefined;
  cleanUpPlan = undefined;
  void closedSyncs.backendChanged();
  publishSyncBooks();
  publishRecents();
  for (const document of documents.values()) {
    if (!document.closing) void document.refreshSync().catch((error) => console.warn('ImageFlow could not read the sync status', error));
  }
  registerSyncPushes();
  updateMenus();
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
      else if (id === 'import-lightroom') void importFromLightroom(document).catch((error) => report(document.window, error));
      else if (id === 'import-photos') void importFromPhotos(document).catch((error) => report(document.window, error));
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
      registered('export'), registered('export-proof'), { type: 'separator' },
      { label: 'Sync', submenu: [
        ...([['sync-now', 'Sync Now', 'sync'], ['sync-download', 'Download Originals', 'download'], ['sync-start', 'Start Syncing', 'start'],
          ['sync-stop', 'Stop Syncing on This Mac…', 'stop']] as const).flatMap(([id, label, action]) => [
          ...id === 'sync-start' ? [{ type: 'separator' as const }] : [],
          { id, label, enabled: false, click: (_item: Electron.MenuItem, owner?: BaseWindow) => {
            const document = focusedDocument(owner);
            if (document && !document.closing) void syncCommand(document, action).catch((error) => report(document.window, error));
          } }]),
        { type: 'separator' as const },
        { id: 'sync-manage', label: 'Manage Synced Books…', enabled: false, click: () => showSync() },
        { id: 'sync-setup', label: 'Set Up Sync…', click: () => showSettings('sync') },
      ] },
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
      { type: 'separator' }, registered('book-check'),
    ] },
    { label: 'Assets', submenu: [
      registered('import'), registered('import-lightroom'), registered('import-photos'),
      { type: 'separator' }, registered('manage-sources'), registered('copy-assets', 'copy-assets', 'checkbox'),
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
      registered('photos-show-time', undefined, 'checkbox'), registered('photos-show-source', undefined, 'checkbox'),
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
  if (!inBook) { state.editing = true; state.canExport = false; state.canProof = false; }
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
  const standing = document && !document.closing ? document.bookSync : 'unconfigured';
  const syncs = standing === 'syncing' || standing === 'unavailable';
  const syncEnabled: Record<string, boolean> = { 'sync-now': state.document && state.writable && syncs && !sync?.syncing,
    // Originals another Mac is still uploading cannot be downloaded yet.
    'sync-download': !!sync && !sync.syncing && !sync.downloading && (sync.status?.pendingOriginals ?? 0) > (sync.status?.notUploaded ?? 0),
    'sync-start': state.document && state.writable && (standing === 'off' || standing === 'stopped' || standing === 'elsewhere'),
    'sync-stop': (syncs && !sync?.syncing) || !!sync?.sending, 'sync-setup': !syncService.configured, 'sync-manage': syncService.configured };
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


function appWindows() { return [...documents.values()].map((document) => document.window).concat([...markdownWindows.windows(), startWindow, settingsWindow, templatesWindow, syncWindow, ...[...assetsWindows.values()].map(({ window }) => window)].filter((window): window is BrowserWindow => !!window)); }
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
// Where Lightroom Classic installs itself. Settings shows its icon and offers to open it only when it is there.
const lightroomAppPath = '/Applications/Adobe Lightroom Classic/Adobe Lightroom Classic.app';
const photosAppPath = '/System/Applications/Photos.app';
const appIcons = new Map<string, Promise<string | undefined>>();
/**
 * An installed app's own icon as a data URL, read once: Settings' source cards, and the badges of assets from that app.
 * app.getFileIcon with size 'large' crashes Electron on macOS, and 'normal' is 32 px; a Quick Look thumbnail of the
 * bundle is its icon at the card's size for a Retina screen. Undefined where the app is not on this Mac.
 */
function appIcon(path: string) {
  let icon = appIcons.get(path);
  if (!icon) {
    icon = stat(path).then(() => nativeImage.createThumbnailFromPath(path, { width: 88, height: 88 }))
      .then((image) => image.isEmpty() ? undefined : image.toDataURL(), () => undefined);
    appIcons.set(path, icon);
  }
  return icon;
}
async function lightroomApp(): Promise<LightroomState['app']> {
  const installed = await stat(lightroomAppPath).then(() => true, () => false);
  const [running, icon] = await Promise.all([lightroomRunning(), installed ? appIcon(lightroomAppPath) : undefined]);
  return { installed: installed || running, running, ...(icon ? { icon } : {}) };
}
async function lightroomState(): Promise<LightroomState> {
  const connection = lightroom?.connection;
  return { plugin: await pluginStatus(lightroomLocations()), app: await lightroomApp(),
    ...(connection ? { connection: { plugin: connection.plugin.version, ...(connection.catalog.name ? { catalog: connection.catalog.name } : {}) } } : {}) };
}
async function publishLightroom() {
  if (!settingsWindow || settingsWindow.isDestroyed()) return;
  const state = await lightroomState().catch(() => undefined);
  if (state && settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.webContents.send(channels.lightroomChanged, state);
}

/**
 * Adds Lightroom Classic photos to a book (ADR 0011): from Send to ImageFlow in Lightroom, or from Import from
 * Lightroom Classic… here. Both end in the same host step as a file import; photos the book holds already are
 * reported, not added again. The previews follow: Lightroom hands them over while the book is already in use.
 */
async function importLightroomPhotos(document: DocumentSession, { catalog, photos }: SentPhotos) {
  const locators: LightroomLocator[] = photos.map(({ uuid, name }) => ({ provider: 'lightroom', catalog, uuid, ...(name ? { name } : {}) }));
  const count = (total: number) => total + ' photo' + (total === 1 ? '' : 's');
  const result = await document.run(async () => {
    document.notify({ building: true, stage: 'Importing ' + count(photos.length) + '…' });
    try { return await document.importProvided(locators, 'Import from Lightroom Classic'); }
    catch (error) { document.notify({ error: errorMessage(error) }); throw error; }
  });
  if ('error' in result) throw new Error(result.error);
  document.notify({ value: result.value.summary });
  if (!document.window.isDestroyed()) document.window.webContents.send(channels.appNotice, importFeedback(result.value.imported.length, result.value.counts));
}

/**
 * Access to the Photos library was given (ADR 0013): every open book with photos from Photos reads them again, as
 * Allow Access to Photos… does for one book. Photos does not report access it gives.
 */
function photosAccessGiven(except?: DocumentSession) {
  for (const document of documents.values()) {
    if (document === except || document.closing || !sourceEntries(document.book).some((entry) => entry.kind === 'photo' && entry.locator.provider === 'photos')) continue;
    void document.run(async () => { document.retryPreviews(); return document.reload(); })
      .then((result) => document.notify('error' in result ? { error: result.error } : { value: result.value }));
  }
}

/**
 * Import from Photos… (ADR 0013): the system photo picker as a sheet on the book window. The photos picked are linked
 * like photos dragged in from Photos, in the order they were picked.
 */
async function importFromPhotos(document: DocumentSession) {
  const library = photosLibrary();
  const status = library?.status();
  if (!library || status === 'unsupported-build' || status === 'unsupported-system') {
    throw new Error(status === 'unsupported-system' ? 'Photos from Apple Photos need macOS 15.2 or later.' : 'This build of ImageFlow cannot read the Photos library.');
  }
  const before = library.status();
  await requireAccess(library, (access) => askForPhotosAccess(document.window, access), 'photos from it');
  if (before !== 'authorized') photosAccessGiven();
  // The window may have closed while access was asked for; while the picker is open, closing it closes the picker.
  if (document.closing || document.window.isDestroyed()) return;
  const close = () => library.cancelPick();
  document.window.once('close', close);
  let picked: string[];
  try { picked = await library.pick(document.window.getNativeWindowHandle()); }
  finally { if (!document.window.isDestroyed()) document.window.removeListener('close', close); }
  if (document.closing || document.window.isDestroyed()) return;
  if (!picked.length) return;
  const locators = await photosLocators(library, picked);
  if (!locators.length) throw new Error('Only still photos can be linked from Photos.');
  const result = await document.run(async () => {
    document.notify({ building: true, stage: 'Importing ' + locators.length + ' photo' + (locators.length === 1 ? '' : 's') + '…' });
    try { return await document.importProvided(locators, 'Import from Photos'); }
    catch (error) { document.notify({ error: errorMessage(error) }); throw error; }
  });
  if ('error' in result) throw new Error(result.error);
  document.notify({ value: result.value.summary });
  if (!document.window.isDestroyed()) document.window.webContents.send(channels.appNotice, importFeedback(result.value.imported.length, result.value.counts));
}

/** Import Selected from Lightroom Classic…: the photos selected in Lightroom now, after saying how many they are. */
async function importFromLightroom(document: DocumentSession) {
  if (!lightroom?.connection) {
    const answer = await dialog.showMessageBox(document.window, { type: 'info', message: 'Lightroom Classic is not connected',
      detail: 'Open Lightroom Classic with the ImageFlow plugin installed (Settings → Sources), select the photos to add, and choose Import Selected from Lightroom Classic… again.',
      buttons: ['Open Lightroom Classic', 'Lightroom Settings…', 'Cancel'], defaultId: 0, cancelId: 2 });
    if (answer.response === 0) await launchLightroom();
    else if (answer.response === 1) showSettings('sources');
    return;
  }
  const selection = parseResult(selectionResultSchema, await lightroom.request('selection', {}, { timeout: 30_000 }), 'selection');
  if (!selection.photos.length) {
    await dialog.showMessageBox(document.window, { type: 'info', message: 'No photos are selected in Lightroom Classic',
      detail: 'Select the photos to add in Lightroom Classic, then choose Import Selected from Lightroom Classic… again. Videos are left out.', buttons: ['OK'] });
    return;
  }
  const total = selection.photos.length;
  const answer = await dialog.showMessageBox(document.window, { type: 'question',
    message: 'Import ' + (total === 1 ? 'the photo' : total + ' photos') + ' selected in Lightroom Classic?',
    detail: 'Their previews come from Lightroom. Photos the book holds already are not added again.',
    buttons: ['Import', 'Cancel'], defaultId: 0, cancelId: 1 });
  if (answer.response !== 0 || document.closing) return;
  await importLightroomPhotos(document, selection);
}

/**
 * Send to ImageFlow from Lightroom: the photos go into the book in front, else the one used last. Without an open book
 * ImageFlow asks for one; the plugin was answered already, so the question can wait for the user.
 */
async function receiveLightroomPhotos(sent: SentPhotos) {
  if (quitting || preparingQuit) return;
  app.focus({ steal: true });
  let document = focusedDocument() ?? [...documents.values()].filter((open) => !open.closing).at(-1);
  if (!document || document.closing) {
    showStart();
    const owner = startWindow ?? undefined;
    const count = sent.photos.length === 1 ? 'one photo' : sent.photos.length + ' photos';
    const options = { type: 'question' as const, message: 'Open a book for ' + count + ' from Lightroom Classic',
      detail: 'No book is open. Choose the book to add them to.', buttons: ['Open Book…', 'Cancel'], defaultId: 0, cancelId: 1 };
    const answer = owner ? await dialog.showMessageBox(owner, options) : await dialog.showMessageBox(options);
    if (answer.response !== 0) return;
    const choice = owner ? await dialog.showOpenDialog(owner, { title: 'Open ImageFlow Book', properties: ['openFile'], filters: [{ name: 'ImageFlow Book', extensions: ['imageflow'] }] })
      : await dialog.showOpenDialog({ title: 'Open ImageFlow Book', properties: ['openFile'], filters: [{ name: 'ImageFlow Book', extensions: ['imageflow'] }] });
    if (choice.canceled || !choice.filePaths[0]) return;
    document = await openDocument(choice.filePaths[0]);
    if (!document) return;
  }
  focus(document.window);
  if (document.book.readOnly) throw new Error('This book is read-only. Use New Project to make an editable copy, then send the photos again.');
  await importLightroomPhotos(document, sent);
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
    descriptorPath: mcpDescriptorPath(), version: app.getVersion(),
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
        if (name === 'read_library_template') {
          const book = args.project === undefined ? undefined
            : [...documents.values()].find((document) => !document.closing && document.projectSession.handle === args.project);
          if (args.project !== undefined && !book) throw new AuthoringError('PROJECT_CLOSED', 'This book is no longer open. Call list_projects for current handles.');
          return await readLibraryTemplate(library, args as { template: string; path?: string }, book?.book.folder);
        }
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
/**
 * The sync backend's credentials (#281): encrypted with `safeStorage` in their own `0600` file, never in settings.json.
 * Development builds may keep them in memory instead (`IMAGEFLOW_SYNC_CREDENTIALS=memory`), so tests and unsigned
 * builds never wait on a Keychain prompt.
 */
let credentialStore: CredentialStore | undefined;
function syncCredentials() {
  credentialStore ??= !app.isPackaged && process.env.IMAGEFLOW_SYNC_CREDENTIALS === 'memory' ? new MemoryCredentialStore()
    : new FileCredentialStore(join(app.getPath('userData'), 'sync-credentials.json'), {
      available: () => safeStorage.isEncryptionAvailable(), encrypt: (text) => safeStorage.encryptString(text), decrypt: (data) => safeStorage.decryptString(data) });
  return credentialStore;
}

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
  // Whether this build may use iCloud (signed with its entitlements and provisioning profile), asked once: without
  // them iCloud is not offered, and a setting that names it leaves sync off.
  setICloudEntitled(!!(await Promise.resolve().then(() => cloudKit()?.status()).catch(() => undefined))?.entitled);
  configureSourceStore(join(app.getPath('userData'), 'source-cache'));
  configureSourceAccess(join(app.getPath('userData'), 'source-access'));
  configurePersistence(join(app.getPath('userData'), 'persistence'));
  // What a book made from now on starts syncing with (ADR 0012, section 3).
  configureSyncSetup(() => (settings.value.sync ? settings.value.syncSetup : undefined));
  // Sync proxies of photos whose originals are not on this Mac (ADR 0010); kept with the other caches, never in books.
  void configureProxyStore(join(app.getPath('userData'), 'Cache', 'proxies')).catch((error) => console.warn('ImageFlow could not open the sync proxy cache', error));
  // Photos of a Lightroom Classic catalog are read through the plugin; until it connects they are offline.
  lightroom = new LightroomBridge({ file: join(app.getPath('userData'), 'lightroom-bridge.json'), version: app.getVersion() });
  registerProvider(lightroomProvider(lightroom));
  // Photos of the Photos library on this Mac, through PhotoKit (ADR 0013).
  registerProvider(photosProvider(photosLibrary()));
  lightroom.onConnection(() => void publishLightroom());
  lightroom.onSend((sent) => void receiveLightroomPhotos(sent).catch((error) => report(lastDocument?.window ?? startWindow, error)));
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
  // Tests of automatic sync wait less for a book to be idle; a packaged app always waits 30 s.
  const idle = Number(process.env.IMAGEFLOW_SYNC_IDLE_MS);
  if (!app.isPackaged && Number.isFinite(idle) && idle > 0) DocumentSession.autoSyncTiming = { ...DocumentSession.autoSyncTiming, idle };
  const slow = Number(process.env.IMAGEFLOW_SYNC_TEST_SLOW_MS);
  if (!app.isPackaged && Number.isFinite(slow) && slow > 0) DocumentSession.automaticSyncDelay = slow;
  const sending = Number(process.env.IMAGEFLOW_SYNC_TEST_SENDING_MS);
  if (!app.isPackaged && Number.isFinite(sending) && sending > 0) DocumentSession.sendingDelay = sending;
  powerMonitor.on('resume', () => { for (const document of documents.values()) { document.projectSession.inputs.invalidate(); document.autoSync.networkChanged(); } });
  watchNetwork();
  if (process.platform === 'darwin') pushNotifications.on('received-apns-notification', (_event, userInfo) => {
    if (!cloudKitPush(userInfo) || syncService.kind !== 'icloud') return;
    for (const document of documents.values()) document.notified();
  });
  syncService.onUploads(() => { librarySizes = undefined; publishSyncBooks(); });
  // An installation from before #307 syncs on exactly what it synced, and starts nothing else (ADR 0012, section 3).
  await settleSyncSetup(settings, (await booksThatSync()).map(({ path }) => path)).catch((error) => console.warn('ImageFlow could not settle which books sync', error));
  registerSyncPushes();
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
      // Quitting while originals upload is allowed: the books have synced, and what is left resumes when they open again.
      const uploading = pendingUploadsText(syncService.pendingUploads(), bookName);
      if (uploading) {
        const { response } = await dialog.showMessageBox({ type: 'question', buttons: ['Quit', 'Keep Uploading'], defaultId: 0, cancelId: 1,
          message: 'Originals are still uploading.', detail: uploading });
        if (response !== 0) return;
      }
      // A download that is cancelled starts again from nothing.
      const downloading = downloads.list().length;
      if (downloading) {
        const { response } = await dialog.showMessageBox({ type: 'question', buttons: ['Quit', 'Keep Downloading'], defaultId: 0, cancelId: 1,
          message: downloading === 1 ? 'A book is still downloading.' : downloading + ' books are still downloading.',
          detail: 'Quitting cancels the download. Nothing of it stays on this Mac.' });
        if (response !== 0) return;
      }
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
      // Uploads of originals stop cleanly: what is half-sent is never stored, and the next open resumes them. None starts
      // after this, also not for a book whose bounded push on closing (below) names new originals.
      await syncService.shutdown();
      // A download under way leaves nothing behind.
      await downloads.shutdown();
      await closedSyncs.shutdown();
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
  ipcMain.handle(channels.recents, async (event) => libraryOwner(event) ? { value: await libraryLocal() } : { error: 'Request is only available to the start window.' });
  ipcMain.handle(channels.libraryRemote, async (event, refresh?: unknown) => {
    if (!libraryOwner(event)) return { error: 'Request is only available to the start window.' };
    try { return { value: await libraryRemote(refresh === true) }; } catch (error) { return { error: errorMessage(error) }; }
  });
  ipcMain.handle(channels.libraryBook, async (event, bookId: unknown) => {
    if (!libraryOwner(event) || typeof bookId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(bookId)) return { error: 'Request is only available to the start window.' };
    try { return { value: await libraryRow(bookId) }; } catch (error) { return { error: errorMessage(error) }; }
  });
  ipcMain.handle(channels.showSync, (event) => { if (startOwner(event) || settingsOwner(event) || editorOwner(event)) showSync(); });
  const forSync = async <T>(event: IpcMainInvokeEvent, run: () => Promise<T>): Promise<Result<T>> => {
    if (!syncOwner(event) || quitting) return { error: 'Request is only available to the Sync window.' };
    try { return { value: await run() }; } catch (error) { return { error: errorMessage(error) }; }
  };
  ipcMain.handle(channels.syncBooks, (event) => forSync(event, syncBooks));
  ipcMain.handle(channels.syncBookStatus, (event, id: unknown) => forSync(event, async (): Promise<SyncStatus | null> => {
    const entry = await recents.get(String(id));
    const { folder } = await documentIdentity(entry.path);
    return statusReads(async () => {
      const standing = await syncService.standing(folder);
      if (standing.sync === 'syncing' && standing.connection) return describeSync(folder, standing.connection.remote);
      return standing.sync === 'unavailable' ? unavailableStatus(standing.error ?? 'The remote cannot be read.', standing.access) : null;
    });
  }));
  const chosenBook = (bookId: unknown) => {
    if (typeof bookId !== 'string' || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(bookId)) throw new Error('Choose a book.');
    return bookId;
  };
  ipcMain.handle(channels.syncBookSize, (event, bookId: unknown, refresh?: unknown) => forSync(event, async () => librarySize(chosenBook(bookId), refresh === true)));
  ipcMain.handle(channels.syncBookUnused, (event, bookId: unknown) => forSync(event, async () => {
    const id = chosenBook(bookId);
    return sizeReads(async () => await unusedStorage((await syncService.connect()).remote, id) ?? null);
  }));
  ipcMain.handle(channels.manageSyncStorage, (event) => forSync(event, async () => { await shell.openExternal(manageICloudStorage); }));
  ipcMain.handle(channels.libraryAction, async (event, request: unknown) => {
    const owner = libraryOwner(event);
    if (!owner || quitting) return { error: 'Request is only available to the start window.' };
    const { action, bookId, id } = (request ?? {}) as { action?: unknown; bookId?: unknown; id?: unknown };
    const uuid = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
    const valid = ((action === 'download' || action === 'cancel-download' || action === 'update') && uuid(bookId) && id === undefined) || (action === 'delete' && (uuid(bookId) !== uuid(id))) ||
      ((action === 'start' || action === 'stop' || action === 'keep-here' || action === 'sync-again') && uuid(id) && bookId === undefined);
    if (!valid) return { error: 'Unknown library action.' };
    try { await libraryAction(owner, request as LibraryAction); return { value: null }; }
    catch (error) {
      // The library showed something the remote no longer says: it reads the remote again.
      if (error instanceof BookDeletedError || error instanceof BookNotDeletedError || error instanceof BookDeleteError) libraryCache = undefined;
      // A download goes on after its window closed; what it failed with is then said in the Start window, shown again.
      if (owner.isDestroyed() && !quitting) report(startWindow, error);
      return { error: errorMessage(error) };
    } finally { publishRecents(); }
  });
  ipcMain.handle(channels.downloads, (event) => libraryOwner(event) ? downloads.list() : []);
  ipcMain.handle(channels.recentAction, async (event, id: string, action: 'open' | 'locate' | 'remove' | 'reveal') => {
    const owner = action === 'open' || action === 'reveal' ? libraryOwner(event) : startOwner(event);
    if (!owner || typeof id !== 'string') return { error: 'Request is only available to the start window.' };
    try {
      const entry = await recents.get(id);
      if (action === 'reveal') shell.showItemInFolder(entry.path);
      else if (action === 'remove') {
        // A book that syncs here stays listed, so the library never takes it for a book only on the remote (#283); one
        // that cannot be found any more can go, and its remote copy is then offered for download.
        if (isDocument(entry.path)) {
          const state = await readSyncState(entry.path).catch(() => undefined);
          const present = await documentIdentity(entry.path).then(() => true, () => false);
          // Only a book that syncs with the configured remote, as far as can be told: one that synced with another
          // remote, or any book with sync off, can go; with the remote unreadable, removal is not refused on a guess.
          if (present && syncsWithRemote(state, await configuredRemoteId()) === true) throw new Error('“' + (entry.title || bookName(entry.path)) + '” syncs on this Mac, so it stays in the list. Stop syncing it on this Mac first.');
        }
        await recents.remove(id); publishRecents();
      }
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
    if (request.action === 'reveal-leftovers' || request.action === 'trash-leftovers') {
      if (!Array.isArray(request.paths) || !request.paths.length || request.paths.length > 10_000 || !request.paths.every((path) => typeof path === 'string')) throw new Error('Choose files.');
      const { paths } = request;
      const open = markdownWindows.paths(document);
      // Only what is listed now can be named.
      const chosenFiles = (await document.leftovers(open)).filter(({ path }) => paths.includes(path));
      if (!chosenFiles.length) throw new Error('The book uses these files again, or they are gone.');
      if (request.action === 'reveal-leftovers') { for (const { path } of chosenFiles.slice(0, 20)) shell.showItemInFolder(join(document.book.folder, path)); return { summary: document.summary }; }
      const count = chosenFiles.length, names = chosenFiles.slice(0, 5).map(({ path }) => '• ' + path);
      const { response } = await dialog.showMessageBox(owner, { type: 'question', buttons: ['Move to Trash', 'Cancel'], defaultId: 1, cancelId: 1,
        message: count === 1 ? 'Move the file to the Trash?' : 'Move ' + count + ' files to the Trash?',
        detail: names.join('\n') + (count > 5 ? '\n• and ' + (count - 5) + ' more' : '') + '\n\nThe book does not use ' + (count === 1 ? 'it' : 'them') + ', and nothing you can undo does.' +
          (document.syncView ? ' Another Mac that has not synced yet may still use ' + (count === 1 ? 'it' : 'them') + '.' : '') });
      if (response !== 0) return { summary: document.summary };
      const trashed = await document.trashLeftovers(chosenFiles.map(({ path }) => path), open);
      return { summary: document.summary, message: trashed === 1 ? 'Moved 1 file to the Trash.' : 'Moved ' + trashed + ' files to the Trash.' };
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
    if (request.action === 'retry') { document.retryPreviews(); return { summary: activate(await document.reload()) }; }
    if (request.action === 'refresh') {
      // Offered for photos without a file whose source is reachable now; the previews show as they come.
      const count = document.refreshPreviews(chosen.filter(({ key }) => document.book.sources?.[key]?.state === 'available').map(({ id }) => id));
      if (!count) throw new Error('Choose photos whose source is available now.');
      return { summary: document.summary, message: count === 1 ? 'Refreshing the preview from its source…' : 'Refreshing ' + count + ' previews from their source…' };
    }
    if (request.action === 'show-lightroom') {
      if (!lightroom) throw new Error('Lightroom Classic is not available.');
      const locators = chosen.flatMap((entry) => entry.kind === 'photo' && entry.locator.provider === 'lightroom' ? [entry.locator as LightroomLocator] : []);
      return { summary: document.summary, message: await showInLightroom(lightroom, locators) };
    }
    if (request.action === 'show-photos') {
      const locators = chosen.flatMap((entry) => entry.kind === 'photo' && entry.locator.provider === 'photos' ? [entry.locator as PhotosLocator] : []);
      return { summary: document.summary, message: await showInPhotos(photosLibrary(), locators, (url) => shell.openExternal(url)) };
    }
    if (request.action === 'launch') {
      // Offered only where the photo's provider offers it (`SourceProvider.repairs`). Once the plugin connects, the
      // provider's watch reports the photos and the book observes them again: nothing waits here.
      if (!chosen.some(({ key }) => document.book.sources?.[key]?.repairs?.includes('launch'))) throw new Error('These assets cannot be brought back by opening an app.');
      await launchLightroom();
      return { summary: document.summary, message: lightroom?.connection ? undefined : 'Opening Lightroom Classic. Its photos come back once the ImageFlow plugin connects.' };
    }
    if (request.action === 'allow') {
      // Offered where the photo's provider needs a permission (Apple Photos, ADR 0013): macOS asks once, after that only
      // System Settings gives it. With access, the book reads its photos again.
      if (!chosen.some(({ key }) => document.book.sources?.[key]?.repairs?.includes('allow'))) throw new Error('These assets need no permission.');
      const library = photosLibrary();
      let access = library?.status();
      if (access === 'notDetermined') access = await library!.requestAccess();
      if (access && access !== 'authorized' && access !== 'unsupported-build' && access !== 'unsupported-system') access = await askForPhotosAccess(owner, access) === 'granted' ? 'authorized' : access;
      if (access !== 'authorized') return { summary: document.summary };
      photosAccessGiven(document);
      document.retryPreviews();
      return { summary: activate(await document.reload()) };
    }
    // Photos without a file are materialized on the way; one whose source cannot produce it stays as it was.
    const unproduced: string[] = [];
    const collect = (chosenKeys?: readonly string[]) => document.copying(owner, (options) =>
      collectSources(document.book, chosenKeys, { ...options, failed: (photo) => unproduced.push(photo.name) }));
    const unproducedMessage = () => unproduced.length ? (unproduced.length === 1 ? unproduced[0] + ' could not be copied: its source could not produce the original.'
      : unproduced.length + ' photos could not be copied: their source could not produce the originals (' + unproduced.join(', ') + ').') : undefined;
    if (request.action === 'collect') {
      const entries = keys ? chosen : sourceEntries(document.book);
      if (!await confirmCopy(owner, document, entries)) return { summary: document.summary };
      next = await collect(keys); message = unproducedMessage();
    }
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
      if (request.action === 'copy') {
        if (!await confirmCopy(owner, document, chosen)) return { summary: document.summary };
        next = await collect(chosen.filter((entry) => sourceReach(entry) !== 'book').map(({ key }) => key)); message = unproducedMessage();
      }
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
    if (action !== 'sync' && action !== 'download' && action !== 'cancel-download' && action !== 'start' && action !== 'stop' && action !== 'manage-storage') return { error: 'Unknown sync action.' };
    try { await syncCommand(document, action); return { value: undefined }; }
    catch (error) { return { error: errorMessage(error) }; }
  });
  // Not held: it only looks, and what it lists is looked up again before anything is done with it.
  ipcMain.handle(channels.leftoverFiles, async (event) => {
    const document = editorOwner(event) ?? assetsOwner(event);
    if (!document || quitting) return { error: 'Request is only available to an open book.' };
    try { return { value: await document.leftovers(markdownWindows.paths(document)) }; } catch (error) { return { error: errorMessage(error) }; }
  });
  ipcMain.handle(channels.saveCopy, (event) => fromEditor(event, async (document) => {
    const linked = sourceEntries(document.book).some((entry) => sourceReach(entry) !== 'book') ? 'Unchecked: linked files keep their full paths, and photos from other sources stay linked to them.' : undefined;
    // iCloud cannot copy inside the store (#285): a copy of a synced book uploads its originals again when it syncs.
    const icloud = syncService.kind === 'icloud' && !!(await readSyncState(document.book.folder).catch(() => undefined))?.lastSynced
      ? 'The copy syncs as a new book. iCloud cannot copy its originals, so they are uploaded again and count toward your iCloud storage a second time.' : undefined;
    const choice = await showSavePanel<boolean>(document.window, { title: 'Duplicate Book', buttonLabel: 'Duplicate',
      defaultPath: join(app.getPath('documents'), bookName(document.book.folder) + ' Copy.imageflow'), filter: { name: 'ImageFlow Book', extension: 'imageflow' } },
    { label: 'Include all files', value: true, note: [linked, icloud].filter(Boolean).join('\n\n') || undefined });
    if (!choice) return null;
    let folder: string;
    try { folder = await document.copying(document.window, (options) => saveDocumentCopy(document.book, choice.filePath, choice.value, undefined, false, options), 'Duplicating book'); }
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
  // A bucket and its key are saved in Settings → Sync; every open book then looks at the remote again, also when only
  // the key changed (a corrected key clears "Sign-in needed" without a restart).
  registerSyncSettings({ ipcMain, owner: settingsOwner, windowOwner: syncOwner, setUp: showSync, settings, credentials: syncCredentials, cloudKit: async () => cloudKit()?.status(),
    cleanUp: {
      // The plan shown is the one Clean Up deletes from (after reading the tips again), for the remote it was made on.
      plan: async () => {
        const { remote, remoteId } = await syncService.connect();
        const plan = { ...await planCleanUp(remote), remoteId };
        cleanUpPlan = plan;
        return cleanUpSummary(plan);
      },
      // Deleting removes it for every Mac: asked here, in the main process, as Delete from Sync is, never on a window's word.
      run: async (event) => {
        const owner = syncOwner(event);
        const plan = cleanUpPlan;
        if (!owner || !plan) throw new Error('Look for what Clean Up would free first.');
        if (!plan.objects) return { cancelled: true as const };
        const { response } = await dialog.showMessageBox(owner, { type: 'warning', ...cleanUpQuestion(plan, syncService.name ?? 'sync') });
        if (response !== 0) return { cancelled: true as const };
        const { remote, remoteId } = await syncService.connect();
        if (cleanUpPlan !== plan) throw new Error('Look for what Clean Up would free again.');
        cleanUpPlan = undefined;
        if (plan.remoteId !== remoteId) throw new Error('Look for what Clean Up would free again: the remote changed since.');
        return cleanUp(remote, plan);
      },
    },
    forgetKey: async (event, bucket) => {
      const owner = settingsOwner(event);
      if (!owner) return false;
      const { response } = await dialog.showMessageBox(owner, { type: 'question', buttons: ['Stop Using Bucket', 'Cancel'], defaultId: 1, cancelId: 1,
        message: 'Stop syncing through “' + bucket + '”?', detail: 'ImageFlow forgets its access key on this Mac. The books here and in the bucket stay as they are.' });
      return response === 0;
    },
    changed: (value) => { syncBackendChanged(); for (const owner of appWindows()) if (!owner.isDestroyed()) owner.webContents.send(channels.settingsChanged, value); } });
  ipcMain.handle(channels.settings, (event) => appOwner(event) ? { value: settings.value } : { error: 'Request is only available to an app window.' });
  ipcMain.handle(channels.updateSettings, async (event, patch: unknown) => {
    if (!appOwner(event)) return { error: 'Request is only available to an app window.' };
    // A sync backend is set only through Settings → Sync; a window may only turn sync off, with the flag.
    const syncRefused = syncPatchError(patch);
    if (syncRefused) return { error: syncRefused };
    try {
      if (patch && typeof patch === 'object' && 'updateChannel' in patch && patch.updateChannel !== settings.value.updateChannel &&
          ['checking', 'downloading', 'ready'].includes(updates.state.status)) throw new Error('Finish the current update before changing channels.');
      if (patch && typeof patch === 'object' && 'agentAccess' in patch) throw new Error('Change agent access in Settings → Agents.');
      const previousChannel = settings.value.updateChannel;
      const previous = settings.value.sync;
      const value = await settings.update(patch);
      if (JSON.stringify(value.sync) !== JSON.stringify(previous)) {
        // Turned off: the key of a bucket no longer configured is forgotten, as Settings → Sync does.
        await forgetOtherCredentials(syncCredentials(), previous, value.sync).catch((error) => console.warn('ImageFlow could not forget the key of the former sync bucket', error));
        syncBackendChanged();
      }
      nativeTheme.themeSource = value.appearance;
      updates.setAutomatic(value.automaticUpdates);
      if (value.updateChannel !== previousChannel && value.automaticUpdates) updates.check();
      for (const owner of appWindows()) if (!owner.isDestroyed()) owner.webContents.send(channels.settingsChanged, value);
      return { value };
    } catch (error) { return { error: errorMessage(error) }; }
  });
  ipcMain.handle(channels.chooseSyncFolder, async (event) => {
    // The folder backend is for development and tests (`IMAGEFLOW_SYNC_FOLDER=1`): a release does not offer it.
    if (!appOwner(event) || !folderSyncFlag()) return { error: 'Request is only available to an app window.' };
    try {
      const owner = BrowserWindow.fromWebContents(event.sender);
      const current = settings.value.sync?.kind === 'folder' ? settings.value.sync.path : undefined;
      const options: Electron.OpenDialogOptions = { title: 'Sync Folder', buttonLabel: 'Choose', properties: ['openDirectory', 'createDirectory'],
        message: 'Choose the folder this Mac syncs its books through. For development and tests: a folder iCloud Drive or Dropbox manages is not supported.',
        ...(current ? { defaultPath: current } : {}) };
      const choice = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
      const path = choice.filePaths[0];
      if (choice.canceled || !path) return { value: null };
      // A book's own files are no place for the sync of every book (and a sync folder inside one is refused per book).
      if (insideBook(await realpath(path).catch(() => path)) || insideBook(path)) throw new Error('Choose a folder outside every book.');
      const previous = settings.value.sync;
      const next = { kind: 'folder' as const, path };
      const value = await settings.update({ sync: next, ...syncSetupPatch(previous, next) });
      // One backend at a time: a bucket the folder replaces has its key forgotten.
      await forgetOtherCredentials(syncCredentials(), previous, value.sync).catch((error) => console.warn('ImageFlow could not forget the key of the former sync bucket', error));
      if (JSON.stringify(value.sync) !== JSON.stringify(previous)) { syncBackendChanged(); showSync(); }
      for (const window of appWindows()) if (!window.isDestroyed()) window.webContents.send(channels.settingsChanged, value);
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
    if ((appOwner(event) || pickerOwner(event)) && (pane === 'general' || pane === 'sources' || pane === 'agents')) showSettings(pane);
    else if (appOwner(event) && pane === 'sync') showSettings('sync');
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
  // The icons of the apps photos come from, for asset badges and Settings' cards; each falls back to a drawn mark.
  ipcMain.handle(channels.sourceIcons, async (event) => {
    if (!(editorOwner(event) ?? assetsOwner(event) ?? settingsOwner(event))) return { error: 'Request is only available to ImageFlow windows.' };
    const [lightroom, photos] = await Promise.all([appIcon(lightroomAppPath), appIcon(photosAppPath)]);
    return { value: { ...(lightroom ? { lightroom } : {}), ...(photos ? { photos } : {}) } };
  });
  // The Apple Photos card of Settings → Sources (ADR 0013): whether ImageFlow may read the library, and asking for it.
  ipcMain.handle(channels.photosAccess, async (event, request?: 'ask' | 'settings') => {
    if (!settingsOwner(event)) return { error: 'Request is only available to Settings.' };
    try {
      const library = photosLibrary();
      const before = library?.status();
      if (request === 'ask' && before === 'notDetermined') await library!.requestAccess();
      if (request === 'settings') await shell.openExternal(photosPrivacySettings);
      const after = library?.status() ?? 'unsupported-build';
      if (after === 'authorized' && before !== 'authorized') photosAccessGiven();
      return { value: after };
    } catch (error) { return { error: errorMessage(error) }; }
  });
  ipcMain.handle(channels.lightroomLaunch, async (event) => {
    if (!settingsOwner(event)) return { error: 'Request is only available to Settings.' };
    try { await launchLightroom(); return { value: undefined }; }
    catch (error) { return { error: errorMessage(error) }; }
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
    fromEditor(event, (document) => document.exportBook(document.window, id, surface === 'cover' || surface === 'proof' ? surface : undefined)));
  ipcMain.handle(channels.cancel, (event) => {
    // The Assets window cancels its own Copy into Book, never the book window's export.
    const assets = assetsOwner(event);
    if (assets) assets.copyJob?.abort(); else editorOwner(event)?.cancelExport();
  });
  ipcMain.handle(channels.check, (event, id: string, request: AuthoringCheckRequest) => fromEditor(event, (document) => document.checkOpenBook(document.currentBook(id), request)));
  ipcMain.handle(channels.cancelCheck, (event) => { editorOwner(event)?.cancelCheck(); });
  ipcMain.handle(channels.bookMenu, (event, state: BookMenuState) => {
    const document = editorOwner(event);
    if (!document || !state || typeof state.enabled !== 'object' || !state.enabled ||
        typeof state.editing !== 'boolean' || typeof state.writable !== 'boolean' || typeof state.busy !== 'boolean') return;
    const previousLabels = JSON.stringify([document.menuState?.pageLabels, document.menuState?.coverBoxIds, document.menuState?.layoutBoxes]);
    const pageLabels = Object.fromEntries(document.book.project.spreads.flatMap(({ id }) => {
      const label = state.pageLabels?.[id];
      return typeof label === 'string' ? [[id, label.slice(0, 100)]] : [];
    }));
    const coverBoxIds = Array.isArray(state.coverBoxIds) ? state.coverBoxIds.filter((id) => typeof id === 'string') : undefined;
    // The kind of each layout's boxes, as the editor last rendered the template: only what decides whether a box shows its content.
    const layoutBoxes = state.layoutBoxes && typeof state.layoutBoxes === 'object' ? Object.fromEntries(Object.entries(state.layoutBoxes).flatMap(([id, layout]) =>
      layout && typeof layout === 'object' && layout.boxes && typeof layout.boxes === 'object' ? [[id, { boxes: Object.fromEntries(Object.entries(layout.boxes)
        .flatMap(([box, declared]) => declared?.type === 'photo' || declared?.type === 'markdown' ? [[box, { type: declared.type }]] : [])) }]] : [])) : undefined;
    document.menuState = { ...emptyMenuState, ...state,
      pageLabels, coverBoxIds, layoutBoxes, enabled: Object.fromEntries(spreadCommands.map((id) => [id, state.enabled[id] === true])) as BookMenuState['enabled'] };
    if (previousLabels !== JSON.stringify([pageLabels, coverBoxIds, layoutBoxes])) publishAssets(document);
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
      for (const entry of state) await openDocument(entry.folder).catch((error) => console.warn('Could not reopen ' + entry.folder + ':', errorMessage(error)));
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
