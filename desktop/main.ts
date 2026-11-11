import { app, BrowserWindow, dialog, ipcMain, Menu, net, powerMonitor, protocol } from 'electron';
import type { IpcMainInvokeEvent, MenuItemConstructorOptions } from 'electron';
import { randomUUID } from 'node:crypto';
import { watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { channels, desktopScheme, editorURL, renderOrigin } from '../src/desktop';
import type { Command, ExportMode, ImportRequest, OpenAction, ProjectChange, ProjectSummary, Result, McpSettings } from '../src/desktop';
import { identifier } from '../src/project';
import type { ProjectFiles, RenderProject } from '../src/project';
import { printBook, saveProof } from './export';
import { assetTypes, importIntoProject, loadProject, projectSummary, readProjectManifest, renderData } from './project';
import type { OpenProject } from './project';
import { photoExtensions, photoFile } from './photos';
import { bundledFontNames } from './fonts';
import { isProjectInputPath } from './revisions';
import type { ProjectInputIndex } from './revisions';
import { checkProject } from './check';
import { checkTemplateTypes } from './typecheck';
import type { CheckDraft } from './check';
import { captureBookPreview, checkBookRender } from './preview';
import { ProjectSession } from './project-session';
import { createAuthoringService, AuthoringError } from './authoring-service';
import { createMcpConnection } from './mcp-connection';
import { AuthoringQueue } from './authoring-queue';
import { authoringErrorResult } from './authoring-errors';
import { ImportReceipts } from './import-receipts';
import { acquireProjectLock, CommittedProjectSaveError } from './persistence';
import type { ProjectLock } from './persistence';
import type { AuthoringCheckRequest } from '../src/authoring-check';

let window: BrowserWindow | null = null;
let active: { id: string; book: OpenProject } | undefined;
let busy = false;
let projectSession: ProjectSession | undefined;
let unlockProject: ProjectLock | undefined;
let mcpConnection: Awaited<ReturnType<typeof createMcpConnection>> | undefined;
let mcpClients: { name: string }[] = [];
let mcpCalls = 0;
let mcpQueue: AuthoringQueue | undefined;
let closingProject: Promise<void> | undefined;
let closing = false;
let quitting = false;
let quitReady = false;
let quitCleanup: Promise<void> | undefined;
let connectionSettingsQueue = Promise.resolve();
const agentLeases = new Map<string, (allowed: boolean) => void>();
let exportJob: AbortController | undefined;
let checkJob: AbortController | undefined;
const checkJobs = new Set<AbortController>();
let watcher: FSWatcher | undefined;
let reloadTimer: ReturnType<typeof setTimeout> | undefined;
const observedChanges = new Set<string>();
const importedWrites = new ImportReceipts();
let cache: string;
const sessions = new Map<string, { book: OpenProject; mode: RenderProject['mode'] }>();
// `npm run dev` serves the editor and render pages from a Vite dev server for hot reloading. The custom protocol
// proxies those requests, so origins, IPC checks, and frame messaging match the built app.
const devServer = app.isPackaged ? undefined : process.env.IMAGEFLOW_DEV_SERVER;
const devState = devServer ? process.env.IMAGEFLOW_DEV_STATE : undefined;
// In dev mode the samples come from the repository, so New Project uses the starter as it is now.
const devSample = devServer ? process.env.IMAGEFLOW_DEV_SAMPLE : undefined;
const csp = devServer
  ? "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self' " +
    devServer + ' ' + devServer.replace(/^http/, 'ws') + "; img-src 'self' data:"
  : "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; img-src 'self' data:";
if (app.isPackaged) process.env.ESBUILD_BINARY_PATH = join(process.resourcesPath, 'esbuild');
const viewPath = /^\/render\/([a-f0-9-]{36})(?:\/(.*))?$/;

if (!app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', () => { if (window) { window.show(); window.focus(); } });

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
  if (host === 'editor' && pathname === '/') {
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

function editorOwner(event: IpcMainInvokeEvent) {
  const owner = window;
  if (owner && event.sender === owner.webContents && event.senderFrame === owner.webContents.mainFrame &&
      event.senderFrame.url === editorURL) return owner;
  return undefined;
}
function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'ImageFlow could not complete the request.';
}

async function fromEditor<T>(event: IpcMainInvokeEvent, run: (owner: BrowserWindow) => Promise<T>): Promise<Result<T>> {
  const owner = editorOwner(event);
  if (!owner) return { error: 'Request is only available to the editor.' };
  if (closing || quitting) return { error: 'ImageFlow is closing this project.' };
  if (busy) return { error: 'ImageFlow is finishing another project operation.' };
  busy = true;
  try {
    return { value: await run(owner) };
  } catch (error) {
    if (error instanceof CommittedProjectSaveError && !owner.isDestroyed()) owner.webContents.send(channels.changed, { error: error.message });
    return { error: errorMessage(error) };
  } finally {
    busy = false;
  }
}

function activate(book: OpenProject, external = false): ProjectSummary {
  if (closing) throw new AuthoringError('PROJECT_CLOSED', 'The project window closed.');
  if (!projectSession || projectSession.book.folder !== book.folder) {
    projectSession?.close();
    projectSession = new ProjectSession(book);
  }
  else if (external) projectSession.adoptExternal(book);
  else projectSession.book = book;
  const previous = active;
  const id = randomUUID();
  active = { id, book };
  // The editor keeps its last ready frames while newer candidates render. Those frames still request lazy photos.
  const retained = new Set([id, previous?.id]);
  for (const frame of window?.webContents.mainFrame.framesInSubtree ?? []) {
    const url = frame.url;
    if (url.startsWith(renderOrigin + '/')) retained.add(viewPath.exec(new URL(url).pathname)?.[1]);
  }
  for (const [sessionId, { mode }] of sessions) {
    if (mode === 'edit' && !retained.has(sessionId)) sessions.delete(sessionId);
  }
  sessions.set(id, { book, mode: 'edit' });
  return { ...projectSummary(book, id), handle: projectSession.handle, history: projectSession.history };
}

function stopWatch() {
  clearTimeout(reloadTimer);
  watcher?.close();
  watcher = undefined;
  observedChanges.clear();
  importedWrites.clear();
}

async function fingerprint(path: string) {
  try {
    const info = await stat(path, { bigint: true });
    return [info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');
  } catch {
    return '';
  }
}

function watchProject(book: OpenProject) {
  stopWatch();
  if (book.readOnly) return;
  const folder = book.folder;
  const inputs = projectSession?.inputs;
  let checkingChanges = false;
  // After a failed reload the editor shows an error, so a revert to the bytes it last loaded must still reload.
  let reloadFailed = false;
  function scheduleReload(delay = 220) {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(reload, delay);
  }
  function reload() {
    const current = active;
    const owner = window;
    if (current?.book.folder !== folder || !owner || !observedChanges.size) return;
    if (busy || checkingChanges) {
      scheduleReload(250);
      return;
    }
    const runningWatcher = watcher;
    const watching = () => !owner.isDestroyed() && watcher === runningWatcher;
    const notify = (change: ProjectChange) => {
      if (watching()) owner.webContents.send(channels.changed, change);
    };
    const files = [...observedChanges];
    observedChanges.clear();
    checkingChanges = true;
    void (async () => {
      const external = await Promise.all(files.map(async (file) => {
        if (file === 'project.json' || file === 'photos.json') {
          // The event may arrive after an in-app save or manual reload already adopted these exact bytes.
          const source = await readProjectManifest(folder, file).catch(() => undefined);
          return !source || !current.book.manifests[file].equals(source);
        }
        const imported = importedWrites.get(file);
        return !imported || await fingerprint(join(folder, file)) !== imported;
      }));
      if (!watching()) return;
      // Comparing receipts must not block edits. Recheck the events if an edit started or changed the active book.
      if (busy || active !== current) {
        for (const file of files) observedChanges.add(file);
        scheduleReload(250);
        return;
      }
      for (const [i, file] of files.entries()) {
        if (!external[i]) {
          const receipt = importedWrites.get(file);
          if (receipt) {
            importedWrites.consume(file, receipt);
            if (observedChanges.has(file)) importedWrites.observe(file);
          }
        }
      }
      if (!external.some(Boolean) && !reloadFailed) return;
      busy = true;
      try {
        notify({ building: true });
        const next = await loadProject(folder, cache).then((book) => ({ book }), (error: unknown) => ({ error: errorMessage(error) }));
        if (!watching() || active !== current) return;
        if (observedChanges.size) {
          // A newer edit arrived during the build. The debounced reload will read it and resolve the building state.
          for (const [i, file] of files.entries()) if (external[i]) observedChanges.add(file);
          return;
        }
        for (const [i, file] of files.entries()) if (external[i]) importedWrites.delete(file);
        reloadFailed = 'error' in next;
        notify('error' in next ? { error: next.error } : { value: activate(next.book, true) });
      } finally {
        busy = false;
      }
    })().catch((error: unknown) => {
      notify({ error: errorMessage(error) });
    }).finally(() => { checkingChanges = false; });
  }
  try {
    const installed = watch(folder, { recursive: true }, (_event, file) => {
      if (watcher !== installed || projectSession?.inputs !== inputs) return;
      if (!file) {
        inputs?.invalidate();
        observedChanges.add('template');
        scheduleReload();
        return;
      }
      if (!isProjectInputPath(file)) return;
      inputs?.invalidate(file);
      importedWrites.observe(file);
      observedChanges.add(file);
      scheduleReload();
    });
    watcher = installed;
    installed.on('error', (error) => {
      if (watcher !== installed) return;
      inputs?.invalidate();
      window?.webContents.send(channels.changed, { error: 'Project watcher stopped. ' + error.message });
      stopWatch();
    });
  } catch (error) {
    inputs?.invalidate();
    window?.webContents.send(channels.changed, { error: 'Project watcher could not start. ' + errorMessage(error) });
  }
}

function sampleFolder(starter = false) {
  const name = starter ? 'starter' : 'whitewall';
  if (devSample) return join(devSample, name);
  return app.isPackaged ? join(process.resourcesPath, 'sample', name) : join(app.getAppPath(), 'sample', name);
}

async function createProject(owner: BrowserWindow) {
  const { canceled, filePath } = await dialog.showSaveDialog(owner, {
    title: 'New Project Folder', defaultPath: join(app.getPath('documents'), 'Untitled Photobook'),
    buttonLabel: 'Create Project',
  });
  if (canceled || !filePath) return null;
  const folder = join(await realpath(dirname(filePath)), basename(filePath));
  await mkdir(folder);
  const release = await acquireProjectLock(folder);
  try {
    await cp(sampleFolder(true), folder, { recursive: true, filter: (path) => basename(path) !== '.imageflow' });
    const path = join(folder, 'project.json');
    const draft = JSON.parse(await readFile(path, 'utf8'));
    draft.title = basename(folder);
    await writeFile(path, JSON.stringify(draft, null, 2) + '\n');
    return { book: await loadProject(folder, cache), release, keepLock: false };
  } catch (error) {
    await release();
    await rm(folder, { recursive: true, force: true });
    throw error;
  }
}

async function loadOwnedProject(folder: string, readOnly = false) {
  const path = await realpath(folder);
  const keepLock = !!unlockProject && (path === projectSession?.book.folder || await unlockProject.tryRelocate(path));
  const release = !readOnly && !keepLock ? await acquireProjectLock(path) : undefined;
  try {
    const book = await loadProject(path, cache, readOnly);
    return { book, release, keepLock };
  } catch (error) {
    await release?.();
    throw error;
  }
}

async function openProject(owner: BrowserWindow, action: OpenAction): Promise<ProjectSummary | null> {
  let loaded: Awaited<ReturnType<typeof loadOwnedProject>>;
  if (action === 'new') {
    const created = await createProject(owner);
    if (!created) return null;
    loaded = created;
  } else if (action === 'sample') loaded = await loadOwnedProject(sampleFolder(), true);
  else if (action === 'reload' && active) loaded = await loadOwnedProject(active.book.folder, active.book.readOnly);
  else if (action === 'open') {
    const choice = await dialog.showOpenDialog(owner, { title: 'Open ImageFlow Project', properties: ['openDirectory'] });
    if (choice.canceled || !choice.filePaths[0]) return null;
    loaded = await loadOwnedProject(choice.filePaths[0]);
  } else throw new Error('Choose a project folder first.');
  if (owner.isDestroyed()) { await loaded.release?.(); return null; }
  if (!loaded.keepLock) {
    try { await unlockProject?.(); }
    catch (error) { console.warn('ImageFlow preserved the previous project lock after cleanup failed:', errorMessage(error)); }
    unlockProject = loaded.release;
  }
  if (action !== 'reload') {
    projectSession?.close();
    projectSession = new ProjectSession(loaded.book);
  }
  const summary = activate(loaded.book, action === 'reload');
  if (action !== 'reload' || !watcher) watchProject(loaded.book);
  if (devState) await writeFile(devState, JSON.stringify({ folder: loaded.book.folder, readOnly: loaded.book.readOnly })).catch(() => {});
  return summary;
}

// In dev mode the main process restarts when its code changes; reopen the project that was open before.
async function restoreDevProject() {
  if (!devState) return;
  try {
    const { folder, readOnly } = JSON.parse(await readFile(devState, 'utf8')) as { folder: string; readOnly: boolean };
    const { book, release } = await loadOwnedProject(folder, readOnly);
    unlockProject = release;
    activate(book);
    watchProject(book);
  } catch {
    // Nothing to restore, or the project moved.
  }
}

function currentBook(id: string) {
  if (!active || active.id !== id) throw new Error('The project changed. Try again using the current project.');
  return active.book;
}

async function importFiles(owner: BrowserWindow, id: string, request: ImportRequest, base?: OpenProject) {
  const current = currentBook(id);
  const book = base ?? current;
  if (book.readOnly) throw new Error('Create a project to import files.');
  if (request.kind !== 'photo' && request.kind !== 'markdown' && request.kind !== 'file') throw new Error('Unknown import type.');
  if (request.kind === 'file' && (!Array.isArray(request.accept) || !request.accept.length ||
      !request.accept.every((ext) => typeof ext === 'string' && /^\.[a-z0-9]{1,10}$/.test(ext)) || request.folder)) {
    throw new Error('Invalid file import.');
  }
  if (request.target && (!identifier.safeParse(request.target.box).success || !identifier.safeParse(request.target.spread).success)) {
    throw new Error('Invalid import target.');
  }
  let paths = request.paths;
  if (!paths) {
    const photo = request.kind === 'photo';
    const file = request.kind === 'file';
    const extensions = photo ? [...photoExtensions] : file ? request.accept! : ['.md'];
    const choice = await dialog.showOpenDialog(owner, {
      title: photo ? 'Import Photos' : file ? 'Choose File' : 'Import Markdown',
      properties: request.folder ? ['openDirectory'] : file ? ['openFile'] : ['openFile', 'multiSelections'],
      filters: [{ name: photo ? 'Photos' : file ? request.accept!.join(', ') : 'Markdown', extensions: extensions.map((ext) => ext.slice(1)) }],
    });
    if (choice.canceled) return null;
    paths = choice.filePaths;
  }
  const files: string[] = [];
  for (const path of paths) {
    if ((await stat(path)).isDirectory()) {
      const entries = await readdir(path, { recursive: true, withFileTypes: true });
      files.push(...entries.filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
        .map((entry) => join(entry.parentPath, entry.name)));
    } else files.push(path);
  }
  const destination = join(book.folder, request.kind === 'photo' ? 'photos' : request.kind === 'file' ? 'files' : 'texts');
  const createdDirectory = !await fingerprint(destination);
  const { book: next, imported, copied } = await importIntoProject(book, request, [...new Set(files)]);
  for (const file of createdDirectory ? [destination, ...copied] : copied) {
    const path = relative(book.folder, file);
    importedWrites.set(path, await fingerprint(file), observedChanges.has(path));
  }
  if (owner.isDestroyed()) return null;
  projectSession!.adoptExternal(book);
  projectSession!.record(next, 'Import sources', !!request.target);
  return { summary: activate(next), imported };
}

async function exportBook(owner: BrowserWindow, projectId: string, mode: ExportMode) {
  const book = currentBook(projectId);
  if (mode !== 'proof' && mode !== 'print') throw new Error('Unknown export mode.');
  const proof = mode === 'proof';
  const fileName = book.project.title.replace(/[^\p{L}\p{N} _-]/gu, '-').slice(0, 80) + (proof ? ' - Proof.pdf' : '.pdf');
  const { canceled, filePath } = await dialog.showSaveDialog(owner, {
    title: proof ? 'Export Proof PDF' : 'Export Print PDF', defaultPath: join(app.getPath('documents'), fileName),
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (canceled || !filePath || owner.isDestroyed()) return null;
  const id = randomUUID();
  const job = new AbortController();
  exportJob = job;
  sessions.set(id, { book, mode: 'export' });
  const progress = (stage: string) => { if (!owner.isDestroyed()) owner.webContents.send(channels.progress, stage); };
  try {
    const fonts = mode === 'print' ? bundledFontNames(book.assets.files) : [];
    const { bytes, warnings, errors } = await printBook(renderOrigin + '/render/' + id, mode, fonts, job.signal, progress);
    progress('Saving PDF…');
    await saveProof(filePath, bytes, job.signal);
    return { warnings, errors };
  } catch (error) {
    if (job.signal.aborted) return null;
    throw error;
  } finally {
    exportJob = undefined;
    sessions.delete(id);
  }
}

async function checkOpenBook(book: OpenProject, request: AuthoringCheckRequest, externalSignal?: AbortSignal,
  inputs: ProjectInputIndex | undefined = projectSession?.book.folder === book.folder ? projectSession.inputs : undefined, draft?: CheckDraft) {
  const renditions = projectSession?.inputs === inputs ? projectSession?.renditions : undefined;
  const job = new AbortController();
  const timeout = setTimeout(() => job.abort(new Error('The authoring check timed out.')), 90_000);
  checkJobs.add(job);
  if (!externalSignal) checkJob = job;
  try {
    return await checkProject(book, cache, request, async (snapshot, preview, signal, inspect) => {
      const id = randomUUID();
      sessions.set(id, { book: snapshot, mode: 'export' });
      try {
        const url = renderOrigin + '/render/' + id;
        if (preview) {
          const image = await captureBookPreview(url, preview, signal, inspect);
          return { status: image.status, preview: image };
        }
        return { status: await checkBookRender(url, signal, inspect) };
      } finally {
        sessions.delete(id);
      }
    }, externalSignal ? AbortSignal.any([job.signal, externalSignal]) : job.signal, inputs, renditions, draft,
    (folder, signal) => checkTemplateTypes(folder, signal, app.getAppPath()));
  } finally {
    clearTimeout(timeout);
    if (checkJob === job) checkJob = undefined;
    checkJobs.delete(job);
  }
}

function mcpSettings(): McpSettings {
  return { enabled: !!mcpConnection, clients: mcpClients, ...(mcpConnection ? {
    config: { command: 'node', args: [join(app.getAppPath(), 'mcp-bridge.cjs'), '--connection', mcpConnection.descriptorPath] },
  } : {}) };
}

function publishMcpSettings() {
  if (window && !window.isDestroyed()) window.webContents.send(channels.mcpChanged, mcpSettings());
}

async function disableMcp() {
  const connection = mcpConnection;
  const queue = mcpQueue;
  mcpConnection = undefined;
  mcpQueue = undefined;
  mcpClients = [];
  queue?.close();
  await connection?.close();
  await queue?.whenIdle();
  publishMcpSettings();
}

async function agentLease(signal: AbortSignal) {
  const owner = window;
  if (!owner || owner.isDestroyed()) throw new AuthoringError('PROJECT_CLOSED', 'Open a book in ImageFlow first.');
  const id = randomUUID();
  const allowed = await new Promise<boolean>((resolve) => {
    const finish = (allowed: boolean) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      agentLeases.delete(id);
      resolve(allowed);
    };
    const abort = () => finish(false);
    const timer = setTimeout(() => finish(false), 3000);
    agentLeases.set(id, finish);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) return finish(false);
    owner.webContents.send(channels.agentLease, id);
  });
  signal.throwIfAborted();
  if (!allowed) throw new AuthoringError('EDIT_IN_PROGRESS', 'Finish or close the active editor in ImageFlow, then retry. No changes were made.');
}

async function enableMcp() {
  const owner = window;
  if (!owner || owner.isDestroyed() || closing || quitting) throw new Error('Open ImageFlow before enabling the connection.');
  const queue = new AuthoringQueue({ ready: () => !busy && !closing && !quitting, maxPending: 32 });
  const service = createAuthoringService({
    session: () => projectSession, cache, docs: join(app.getAppPath(), 'docs', 'template-api.md'),
    check: checkOpenBook,
    changed: (book) => {
      const summary = activate(book);
      window?.webContents.send(channels.changed, { value: summary });
    },
    recovery: (message) => { window?.webContents.send(channels.changed, { error: message }); },
    import: async (request, paths, base) => {
      if (!window || !active) throw new AuthoringError('PROJECT_CLOSED', 'The project closed before import.');
      const result = await importFiles(window, active.id, { ...request, paths }, base);
      if (!result) throw new AuthoringError('PROJECT_CLOSED', 'The project closed before import completed.');
      return { imported: result.imported };
    },
  });
  const connection = await createMcpConnection({
    descriptorPath: join(app.getPath('userData'), 'mcp-connection.json'),
    onClientsChanged: (clients) => { mcpClients = clients; publishMcpSettings(); },
    onCall: async (name, args, signal) => {
      mcpCalls++;
      let requestSignal = signal;
      try {
        return await queue.run(async (queuedSignal) => {
          requestSignal = queuedSignal;
          const mutation = name === 'apply_project_changes' || name === 'import_sources';
          let locked = false;
          try {
            if (mutation) await agentLease(queuedSignal);
            queuedSignal.throwIfAborted();
            if (mutation) {
              // Allow already-enqueued UI saves to finish before claiming the writer.
              if (busy) throw new AuthoringError('EDIT_IN_PROGRESS', 'An editor operation started. Let it finish, then retry.');
              busy = true;
              locked = true;
            }
            return await service(name, args, queuedSignal);
          } finally {
            if (mutation) {
              if (locked) busy = false;
              if (window && !window.isDestroyed()) window.webContents.send(channels.agentRelease);
            }
          }
        }, signal);
      } catch (error) {
        return authoringErrorResult(error, requestSignal);
      } finally {
        mcpCalls--;
      }
    },
  });
  if (owner !== window || owner.isDestroyed() || closing || quitting) { queue.close(); await connection.close(); return; }
  mcpConnection = connection;
  mcpQueue = queue;
  publishMcpSettings();
}

function menuCommand(label: string, accelerator: string | undefined, command: Command): MenuItemConstructorOptions {
  return { label, accelerator, click: () => window?.webContents.send(channels.command, command) };
}

function createWindow() {
  closing = false;
  closingProject = undefined;
  // Automated checks set IMAGEFLOW_HIDE_WINDOW so test runs do not flash windows on screen.
  const hidden = !!process.env.IMAGEFLOW_HIDE_WINDOW;
  const editor = new BrowserWindow({
    width: 1520, height: 950, minWidth: 940, minHeight: 650, show: !hidden,
    webPreferences: {
      sandbox: true, contextIsolation: true, nodeIntegration: false, preload: join(__dirname, 'preload.cjs'),
      backgroundThrottling: !hidden,
    },
  });
  window = editor;
  editor.webContents.on('will-frame-navigate', (event) => {
    const url = new URL(event.url);
    const match = viewPath.exec(url.pathname);
    if (event.isMainFrame || url.protocol !== desktopScheme + ':' || url.host !== 'render' || !match ||
        match[1] !== active?.id || match[2]) event.preventDefault();
  });
  editor.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  editor.on('closed', () => {
    closing = true;
    stopWatch();
    exportJob?.abort();
    for (const job of checkJobs) job.abort();
    window = null;
    const disconnect = disableMcp().catch((error) => console.error('ImageFlow could not disconnect its agent connection', error));
    for (const reply of agentLeases.values()) reply(false);
    // A save with a published journal must finish before another app can obtain this folder's lock.
    closingProject = (async () => {
      // An enable request may still be creating its private socket before publishing mcpConnection.
      await connectionSettingsQueue;
      await disconnect;
      while (busy || mcpCalls) await new Promise((resolve) => setTimeout(resolve, 10));
      const release = unlockProject;
      unlockProject = undefined;
      try { await release?.(); }
      finally {
        for (const [id, { mode }] of sessions) if (mode === 'edit') sessions.delete(id);
        active = undefined;
        projectSession?.close();
        projectSession = undefined;
      }
    })().catch((error) => console.error('ImageFlow could not close its project', error));
  });
  void editor.loadURL(editorURL).catch((error: unknown) => console.error('ImageFlow could not open', error));
}

void app.whenReady().then(async () => {
  cache = await mkdtemp(join(app.getPath('temp'), 'imageflow-cache-'));
  powerMonitor.on('resume', () => { projectSession?.inputs.invalidate(); });
  if (!app.isPackaged && process.env.IMAGEFLOW_BENCHMARK === '1') {
    Object.defineProperty(globalThis, 'imageflowBenchmarkInputs', { value: () => projectSession?.inputs.metrics });
  }
  app.on('before-quit', () => { quitting = true; });
  app.on('will-quit', (event) => {
    if (quitReady) return;
    event.preventDefault();
    quitCleanup ??= (async () => {
      await closingProject;
      await rm(cache, { recursive: true, force: true });
    })().catch((error) => console.error('ImageFlow could not finish cleanup', error)).finally(() => {
      quitReady = true;
      app.quit();
    });
  });
  protocol.handle(desktopScheme, async (request) => {
    try {
      return await serve(request);
    } catch (error) {
      console.error('ImageFlow could not serve a project resource', error);
      return new Response(null, { status: 404 });
    }
  });
  ipcMain.handle(channels.open, (event, action: OpenAction) => fromEditor(event, (owner) => openProject(owner, action)));
  ipcMain.handle(channels.save, (event, id: string, files: ProjectFiles, label?: string) =>
    fromEditor(event, async () => {
      currentBook(id);
      return activate(await projectSession!.save(files, typeof label === 'string' ? label : 'Project edit'));
    }));
  ipcMain.handle(channels.history, (event, id: string, direction: 'undo' | 'redo') => fromEditor(event, async () => {
    currentBook(id);
    if (direction !== 'undo' && direction !== 'redo') throw new Error('Unknown history action.');
    return activate(await projectSession!.undo(direction));
  }));
  ipcMain.handle(channels.mcp, async (event, enabled?: boolean) => {
    if (!editorOwner(event)) return { error: 'Request is only available to the editor.' };
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
  ipcMain.on(channels.agentLeaseReply, (event, id: string, allowed: boolean) => {
    if (event.sender === window?.webContents && event.senderFrame === window.webContents.mainFrame) agentLeases.get(id)?.(allowed === true);
  });
  ipcMain.handle(channels.import, (event, id: string, request: ImportRequest) =>
    fromEditor(event, (owner) => importFiles(owner, id, request)));
  ipcMain.handle(channels.export, (event, id: string, mode: ExportMode) =>
    fromEditor(event, (owner) => exportBook(owner, id, mode)));
  ipcMain.handle(channels.cancel, (event) => { if (editorOwner(event)) exportJob?.abort(); });
  ipcMain.handle(channels.check, (event, id: string, request: AuthoringCheckRequest) =>
    fromEditor(event, () => checkOpenBook(currentBook(id), request)));
  ipcMain.handle(channels.cancelCheck, (event) => { if (editorOwner(event)) checkJob?.abort(); });
  app.setAboutPanelOptions({ applicationName: 'ImageFlow', applicationVersion: app.getVersion() });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { label: 'File', submenu: [
      menuCommand('New Project…', 'Cmd+N', 'new'),
      menuCommand('Open Project Folder…', 'Cmd+O', 'open'),
      menuCommand('Open Sample Project', undefined, 'sample'),
      menuCommand('Reload Project', 'Cmd+R', 'reload'),
      { type: 'separator' },
      menuCommand('Import Photos…', 'Cmd+I', 'import-photos'),
      menuCommand('Import Photo Folder…', 'Cmd+Shift+I', 'import-folder'),
      menuCommand('Import Markdown…', undefined, 'import-texts'),
      { type: 'separator' },
      menuCommand('Export Proof PDF…', 'Cmd+Shift+E', 'export'),
      menuCommand('Export Print PDF…', undefined, 'print'),
      { type: 'separator' },
      { role: 'close' },
    ] },
    { label: 'Edit', submenu: [
      menuCommand('Undo Project Edit', 'Cmd+Z', 'undo'),
      menuCommand('Redo Project Edit', 'Cmd+Shift+Z', 'redo'),
      { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
    ] },
    { role: 'windowMenu' },
  ]));
  await restoreDevProject();
  createWindow();
  app.on('activate', () => {
    if (!window && !quitting) void (closingProject ?? Promise.resolve()).then(() => { if (!window && !quitting) createWindow(); });
  });
});
