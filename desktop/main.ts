import { app, BrowserWindow, dialog, Menu, net, protocol } from 'electron';
import { copyFile, mkdtemp, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ExportError, readBookForm, withBookPdf } from '../server/book-export';
import { desktopCommandEvent, desktopScheme } from '../src/desktop';
import type { DesktopCommand } from '../src/desktop';

const editorOrigin = desktopScheme + '://editor';
const editorURL = editorOrigin + '/';
const csp = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'";
let window: BrowserWindow | null = null;
let exporting = false;

protocol.registerSchemesAsPrivileged([
  { scheme: desktopScheme, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

async function saveBook(request: Request) {
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });
  const origin = request.headers.get('origin');
  const owner = window;
  if (!owner || owner.webContents.getURL() !== editorURL || (origin && origin !== editorOrigin)) {
    return new Response(null, { status: 403 });
  }
  if (exporting) return Response.json({ error: 'A book export is already in progress.' }, { status: 409 });

  exporting = true;
  try {
    if (!request.body) throw new ExportError(400, 'The book upload is empty.');
    const form = await readBookForm(
      request.headers.get('content-type'), request.headers.get('content-length'), request.body,
    );
    const { canceled, filePath } = await dialog.showSaveDialog(owner, {
      title: 'Export PDF',
      defaultPath: join(app.getPath('documents'), 'senja-photobook.pdf'),
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (canceled || !filePath) return new Response(null, { status: 204 });

    const renderer = join(process.resourcesPath, 'senja-export');
    await withBookPdf(form, renderer, async (output) => {
      const staging = await mkdtemp(join(dirname(filePath), '.imageflow-'));
      try {
        const stagedPdf = join(staging, 'book.pdf');
        await copyFile(output, stagedPdf);
        await rename(stagedPdf, filePath);
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    });
    return new Response(null, { status: 200 });
  } catch (error) {
    if (error instanceof ExportError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    console.error('ImageFlow PDF export failed', error);
    return Response.json({ error: 'The PDF could not be exported. Check the destination and try again.' }, { status: 500 });
  } finally {
    exporting = false;
  }
}

async function serveEditor(request: Request) {
  const { host, pathname } = new URL(request.url);
  if (host !== 'editor') return new Response(null, { status: 404 });
  if (pathname === '/api/book') return saveBook(request);
  if (request.method !== 'GET') return new Response(null, { status: 405 });
  if (pathname !== '/' && !/^\/assets\/[\w.-]+\.[a-z0-9]+$/i.test(pathname)) {
    return new Response(null, { status: 404 });
  }
  const file = join(app.getAppPath(), 'dist', pathname === '/' ? 'index.html' : pathname);
  const response = await net.fetch(pathToFileURL(file).href);
  if (pathname !== '/') return response;
  const headers = new Headers(response.headers);
  headers.set('Content-Security-Policy', csp);
  return new Response(response.body, { status: response.status, headers });
}

function menuCommand(label: string, accelerator: string, command: DesktopCommand): Electron.MenuItemConstructorOptions {
  return {
    label,
    accelerator,
    click: () => {
      const contents = window?.webContents;
      if (!contents || contents.getURL() !== editorURL || contents.isLoadingMainFrame()) return;
      // Chromium requires a user gesture to open a file picker from a native menu.
      const script = `window.dispatchEvent(new CustomEvent(${JSON.stringify(desktopCommandEvent)}, { detail: ${JSON.stringify(command)} }))`;
      void contents.executeJavaScript(script, true).catch((error: unknown) => {
        console.error('ImageFlow menu command failed', error);
      });
    },
  };
}

function createWindow() {
  const editor = new BrowserWindow({
    width: 1440,
    height: 950,
    minWidth: 960,
    minHeight: 640,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  window = editor;
  editor.webContents.on('will-navigate', (event) => event.preventDefault());
  editor.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  editor.on('closed', () => { window = null; });
  void editor.loadURL(editorURL).catch((error: unknown) => console.error('ImageFlow could not open', error));
}

void app.whenReady().then(() => {
  protocol.handle(desktopScheme, serveEditor);
  app.setAboutPanelOptions({ applicationName: 'ImageFlow', applicationVersion: app.getVersion() });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    {
      label: 'File',
      submenu: [
        menuCommand('Import Photos…', 'Cmd+O', 'import-photos'),
        menuCommand('Import Folder…', 'Cmd+Shift+O', 'import-folder'),
        { type: 'separator' },
        menuCommand('Export PDF…', 'Cmd+Shift+E', 'export-pdf'),
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [menuCommand('Toggle Preview', 'Cmd+Shift+P', 'preview'), { role: 'togglefullscreen' }],
    },
    { role: 'windowMenu' },
  ]));
  createWindow();
  app.on('activate', () => { if (!window) createWindow(); });
});
