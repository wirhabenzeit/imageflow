import { BrowserWindow } from 'electron';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream } from 'pdf-lib';
import type { PDFObject } from 'pdf-lib';
import { formatSchema, pdfPoints, resolveFormat } from '../src/format';
import { parseDocument } from '../src/project';
import type { ExportMode, RenderStatus } from '../src/desktop';

const name = PDFName.of;

function preflightPage(page: PDFDict, resources: PDFDict | undefined, fontNames: string[], forbidTransparency: boolean) {
  const visited = new Set<PDFObject>();
  const errors = new Set<string>();
  function walk(object: PDFObject | undefined) {
    if (!object || visited.has(object)) return;
    visited.add(object);
    if (object instanceof PDFArray) {
      for (let i = 0; i < object.size(); i++) walk(object.lookup(i));
      return;
    }
    const dict = object instanceof PDFRawStream ? object.dict : object;
    if (!(dict instanceof PDFDict)) return;
    const value = (key: string) => dict.get(name(key));
    if (value('Type') === name('Font')) {
      const font = (value('BaseFont')?.toString() ?? '/unnamed').slice(1).replace(/^[A-Z]{6}\+/, '');
      if (value('Subtype') === name('Type3')) errors.add('Type 3 font ' + font);
      else if (!fontNames.includes(font)) errors.add('font outside the template bundle: ' + font);
      const descriptor = dict.lookup(name('FontDescriptor'));
      if (value('Subtype') !== name('Type0') && value('Subtype') !== name('Type3') &&
          (!(descriptor instanceof PDFDict) || !['FontFile', 'FontFile2', 'FontFile3'].some((key) => descriptor.has(name(key))))) {
        errors.add('unembedded font ' + font);
      }
    }
    if (forbidTransparency && (value('S') === name('Transparency') ||
        (value('SMask') !== undefined && value('SMask') !== name('None')) ||
        (value('BM') !== undefined && value('BM') !== name('Normal') && value('BM') !== name('Compatible')) ||
        ['CA', 'ca'].some((key) => {
          const alpha = value(key);
          return alpha instanceof PDFNumber && alpha.asNumber() < 1;
        }))) errors.add('transparency is forbidden by the format');
    for (const key of dict.keys()) walk(dict.lookup(key));
  }
  walk(resources);
  walk(page.lookup(name('Group')));
  return [...errors];
}

export async function printBook(url: string, mode: ExportMode, fontNames: string[], signal: AbortSignal, progress: (message: string) => void) {
  signal.throwIfAborted();
  const window = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  const destroy = () => { if (!window.isDestroyed()) window.destroy(); };
  signal.addEventListener('abort', destroy, { once: true });
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  try {
    progress('Rendering spreads and preparing photos…');
    try {
      await window.loadURL(url);
    } catch (error) {
      signal.throwIfAborted();
      // A subresource can abort the load while the document is still usable.
      if (window.webContents.getURL() !== url) throw error;
    }
    const status: RenderStatus = await window.webContents.executeJavaScript(`
      new Promise((resolve) => {
        const start = Date.now();
        function check() {
          if (window.imageflowRenderStatus) resolve(window.imageflowRenderStatus);
          else if (Date.now() - start > 90000) resolve({ state: 'error', message: 'Timed out rendering the book.' });
          else setTimeout(check, 50);
        }
        check();
      })
    `);
    if (status.state === 'error') throw new Error(status.message);
    if (mode === 'print' && status.errors.length) throw new Error(status.errors.join('\n'));
    const format = parseDocument(formatSchema, status.template.format, 'Print format');
    const { outputWidth, height, trim, bleed } = resolveFormat(format);
    progress('Printing PDF…');
    const pdf = await PDFDocument.load(await window.webContents.printToPDF({
      pageSize: { width: outputWidth / 25.4, height: height / 25.4 },
      preferCSSPageSize: true, printBackground: true, margins: { top: 0, bottom: 0, left: 0, right: 0 },
    }), { updateMetadata: false });
    if (pdf.getPageCount() !== status.units.length) throw new Error('Chromium did not produce the expected number of PDF pages.');
    progress('Checking PDF…');
    const widthPt = pdfPoints(outputWidth);
    const heightPt = pdfPoints(height);
    const issues = new Set<string>();
    for (const [index, page] of pdf.getPages().entries()) {
      const { side, spread } = status.units[index];
      const actual = page.getMediaBox();
      if (Math.abs(actual.width - widthPt) > 0.5 || Math.abs(actual.height - heightPt) > 0.5) {
        throw new Error('Chromium produced an unexpected size on PDF page ' + (index + 1) + '.');
      }
      const leftBleed = side === 'right' ? bleed.binding : bleed.outside;
      page.setMediaBox(0, 0, widthPt, heightPt);
      page.setCropBox(0, 0, widthPt, heightPt);
      page.setBleedBox(0, 0, widthPt, heightPt);
      page.setTrimBox(pdfPoints(leftBleed), pdfPoints(bleed.bottom), pdfPoints(trim.width * (side === 'spread' ? 2 : 1)), pdfPoints(trim.height));
      if (mode === 'print') {
        for (const issue of preflightPage(page.node, page.node.Resources(), fontNames, format.output.transparency === 'forbid')) {
          issues.add('Spread ' + spread + ' · ' + issue + '.');
        }
      }
    }
    if (issues.size) throw new Error([...issues].join('\n'));
    signal.throwIfAborted();
    const bytes = await pdf.save();
    const limit = format.output.maximumFileSize?.pages;
    if (mode === 'print' && limit && bytes.length > limit) throw new Error('The PDF exceeds the format’s file size limit.');
    return bytes;
  } finally {
    signal.removeEventListener('abort', destroy);
    destroy();
  }
}

export async function saveProof(path: string, bytes: Uint8Array, signal: AbortSignal) {
  const staging = await mkdtemp(join(dirname(path), '.imageflow-'));
  try {
    const file = join(staging, 'book.pdf');
    await writeFile(file, bytes, { signal });
    signal.throwIfAborted();
    await rename(file, path);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
