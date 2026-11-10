// Electron entry point for rerunning the format and flow spikes inside Electron 45.
// SPIKE_TASK=pdf   export ../pdf-format/out/*.html with printToPDF and test raster capture, then quit.
// SPIKE_TASK=flow  open one window for the Playwright-driven text-flow harness.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');

const out = path.join(__dirname, 'out');

async function ready(contents) {
  await contents.executeJavaScript(`(async () => {
    await document.fonts.ready;
    await Promise.all([...document.fonts].map((f) => f.load().catch(() => {})));
    await Promise.all([...document.images].map((img) => img.decode().catch(() => {})));
  })()`);
}

const pdfOptions = { preferCSSPageSize: true, printBackground: true, margins: { marginType: 'none' } };

let shared = null;
async function exportPdf(htmlFile, pdfFile) {
  // One window for all exports: new renderer processes are not allowed in the spike's sandboxed shell.
  shared ??= new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  const win = shared;
  try {
    await win.loadFile(htmlFile);
  } catch (error) {
    // loadFile rejects when a subresource load is aborted; the document itself may still be fine.
    console.log('load warning', path.basename(htmlFile), error.code);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  await ready(win.webContents);
  await fs.writeFile(pdfFile, await win.webContents.printToPDF(pdfOptions));
}

// Raster capture of the Saal spread (594 × 300 mm) at 300 dpi = 7016 × 3543 px.
async function captureSpread(htmlFile, file, method) {
  const width = 7016;
  const height = 3543;
  const scale = 300 / 96;
  const win = new BrowserWindow({
    show: false,
    useContentSize: true,
    width: method === 'zoom' ? width : Math.ceil(width / scale),
    height: method === 'zoom' ? height : Math.ceil(height / scale),
    webPreferences: { offscreen: true, sandbox: true },
  });
  await win.loadFile(htmlFile);
  if (method === 'zoom') {
    win.webContents.setZoomFactor(scale);
  } else {
    win.webContents.enableDeviceEmulation({
      screenPosition: 'desktop', screenSize: { width: 2246, height: 1134 }, viewPosition: { x: 0, y: 0 },
      deviceScaleFactor: scale, viewSize: { width: 2246, height: 1134 }, scale: 1,
    });
  }
  await ready(win.webContents);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const image = await win.webContents.capturePage();
  await fs.writeFile(file, image.toJPEG(95));
  const size = image.getSize();
  win.destroy();
  return size;
}

async function pdfTask() {
  const source = path.join(__dirname, '..', 'pdf-format', 'out');
  await fs.mkdir(path.join(out, 'pdf'), { recursive: true });
  const names = (await fs.readdir(source)).filter((name) => name.endsWith('.html'));
  for (const name of names) {
    await exportPdf(path.join(source, name), path.join(out, 'pdf', name.replace(/\.html$/, '.pdf')));
    console.log('pdf', name);
  }
  const captures = {};
  for (const method of ['zoom', 'emulation']) {
    captures[method] = await captureSpread(path.join(source, 'geometry-saal-spread.html'), path.join(out, `saal-spread-${method}.jpg`), method);
  }
  await fs.writeFile(path.join(out, 'electron.json'), JSON.stringify({ versions: process.versions, captures }, null, 2));
  console.log('versions', process.versions.electron, process.versions.chrome, 'captures', JSON.stringify(captures));
}

// Used by the flow harness: print the current state of the harness window.
globalThis.printWindow = async (file) => {
  const [win] = BrowserWindow.getAllWindows();
  await fs.writeFile(file, await win.webContents.printToPDF(pdfOptions));
};
globalThis.versions = process.versions;

app.whenReady().then(async () => {
  if (process.env.SPIKE_TASK === 'pdf') {
    try {
      await pdfTask();
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    }
    app.quit();
    return;
  }
  const win = new BrowserWindow({ show: false, useContentSize: true, width: 2300, height: 1200, webPreferences: { sandbox: true } });
  win.loadURL('about:blank');
});
