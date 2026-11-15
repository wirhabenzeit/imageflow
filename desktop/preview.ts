import { BrowserWindow } from 'electron';
import sharp from 'sharp';
import { desktopScheme } from '../src/desktop';
import type { RenderStatus } from '../src/desktop';
import { maxPreviewEdge, parsePreviewRequest, PreviewError } from '../src/preview';
import type { PreviewMetadata, PreviewRequest } from '../src/preview';
import type { InspectionRequest } from '../src/inspection';
import { renderIdleMs } from '../src/render-budget';
import { formatSentinel, makeSentinel, sentinelMatches, sentinelSamples, sentinelStrip, sentinelWidth } from '../src/capture-sentinel';
import type { Rgb, Sentinel } from '../src/capture-sentinel';

type ReadyStatus = Extract<RenderStatus, { state: 'ready' }>;
export type BookPreview = PreviewMetadata & {
  bytes: Uint8Array;
  mimeType: 'image/png' | 'image/jpeg';
  status: ReadyStatus;
};

type RenderResult = { status: RenderStatus; preview: Window['imageflowPreview'] };

async function withRenderedBook<T>(
  url: string, query: URLSearchParams, signal: AbortSignal | undefined,
  useRender: (window: BrowserWindow, status: ReadyStatus, preview: PreviewMetadata | undefined) => T | Promise<T>,
  onActivity?: () => void,
) {
  signal?.throwIfAborted();
  const address = URL.parse(url);
  if (!address || address.protocol !== desktopScheme + ':' || address.host !== 'render' ||
      address.username || address.password || !/^\/render\/[a-f0-9-]{36}$/.test(address.pathname)) {
    throw new PreviewError('render-failed', 'The render session URL is invalid.');
  }
  address.search = query.toString();
  address.hash = '';
  const window = new BrowserWindow({
    show: false, frame: false, useContentSize: true, enableLargerThanScreen: true,
    // Room below the largest artwork for the capture sentinel (capture-sentinel.ts).
    width: maxPreviewEdge, height: maxPreviewEdge + sentinelStrip.height * 2,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('will-redirect', (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const lifecycle = new AbortController();
  // No fixed deadline: the render may take as long as its pictures need, each within its own timeout, and times out
  // only when nothing has started or finished drawing for longer than one picture may take (render-budget).
  const idleMs = renderIdleMs(query.get('view') === 'check' ? 'check' : 'preview');
  let last = Date.now();
  const stop = setInterval(() => {
    if (Date.now() - last > idleMs) {
      lifecycle.abort(new PreviewError('render-timeout', 'Timed out rendering the book: nothing finished drawing for ' + idleMs / 1000 + ' s.'));
    } else if (!window.isDestroyed()) {
      void window.webContents.executeJavaScript('globalThis.imageflowRenderActivity || 0').then((at: unknown) => {
        if (typeof at === 'number' && at > last) { last = at; onActivity?.(); }
      }, () => {});
    }
  }, 1000);
  window.webContents.once('render-process-gone', () => {
    lifecycle.abort(new PreviewError('render-failed', 'The book renderer stopped before it was ready.'));
  });
  const runSignal = signal ? AbortSignal.any([signal, lifecycle.signal]) : lifecycle.signal;
  let abort = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(runSignal.reason);
    runSignal.addEventListener('abort', abort, { once: true });
  });
  const render = async () => {
    runSignal.throwIfAborted();
    try {
      await window.loadURL(address.href);
    } catch (error) {
      if (runSignal.aborted) throw error;
      // An aborted subresource can still leave a renderable document.
      if (window.webContents.getURL() !== address.href) throw error;
    }
    runSignal.throwIfAborted();
    const { status, preview }: RenderResult = await window.webContents.executeJavaScript(`
      new Promise((resolve) => {
        function check() {
          if (window.imageflowRenderStatus) resolve({ status: window.imageflowRenderStatus, preview: window.imageflowPreview });
          else setTimeout(check, 50);
        }
        check();
      })
    `);
    runSignal.throwIfAborted();
    if (status.state === 'error') {
      throw new PreviewError(preview?.state === 'error' ? preview.code : 'render-failed', status.message,
        { template: status.template, failure: { layoutFailures: status.layoutFailures, declarationIssues: status.declarationIssues, stack: status.stack } });
    }
    return useRender(window, status, preview?.state === 'ready' ? preview.metadata : undefined);
  };
  try {
    const value = await Promise.race([cancelled, render()]);
    runSignal.throwIfAborted();
    return value;
  } catch (error) {
    if (runSignal.aborted) throw error;
    if (error instanceof PreviewError) throw error;
    throw new PreviewError('render-failed', 'The book renderer stopped before it was ready.', { cause: error });
  } finally {
    clearInterval(stop);
    runSignal.removeEventListener('abort', abort);
    if (!window.isDestroyed()) window.destroy();
  }
}

export function checkBookRender(url: string, signal?: AbortSignal, inspect?: InspectionRequest, onActivity?: () => void) {
  const query = new URLSearchParams({ view: 'check' });
  if (inspect) query.set('inspect', JSON.stringify(inspect));
  return withRenderedBook(url, query, signal, (_window, status) => status, onActivity);
}

// How often a capture without the sentinel is retried before the preview fails, and how long to wait between.
const captureAttempts = 8;
const captureRetryMs = 250;

/**
 * Checks, in the page, that the artwork frame of this request is the one on screen: placed at the origin at the size
 * of its metadata, not covered by other content, and with its pictures loaded. Returns a problem, or ''.
 */
function artworkOnScreen(window: BrowserWindow, sentinel: string, width: number, height: number): Promise<string> {
  return window.webContents.executeJavaScript(`(() => {
    const frame = [...document.querySelectorAll('[data-preview-artwork]')].at(-1);
    if (!frame || frame.dataset.previewArtwork !== ${JSON.stringify(sentinel)}) return 'the artwork for this request is not in the page';
    const box = frame.getBoundingClientRect();
    if (Math.round(box.left) !== 0 || Math.round(box.top) !== 0 || Math.round(box.width) !== ${width} || Math.round(box.height) !== ${height})
      return 'the artwork is not placed at the capture area';
    for (const [x, y] of [[1, 1], [${width} - 2, 1], [${width} / 2, ${height} / 2], [1, ${height} - 2], [${width} - 2, ${height} - 2]]) {
      const top = document.elementFromPoint(x, y);
      if (top && top !== frame && !frame.contains(top)) return 'other content covers the artwork';
    }
    if ([...frame.querySelectorAll('img[src]')].some((img) => !img.complete)) return 'pictures in the artwork are still loading';
    return '';
  })()`);
}

const nextFrame = (window: BrowserWindow) => window.webContents.executeJavaScript(
  `new Promise((resolve) => { requestAnimationFrame(() => requestAnimationFrame(resolve)); setTimeout(resolve, ${captureRetryMs}); })`);

/** Captures the artwork and the sentinel below it in one frame: the artwork's pixels, or undefined without the sentinel. */
async function captureArtwork(window: BrowserWindow, sentinel: Sentinel, width: number, height: number) {
  const area = { x: 0, y: 0, width: Math.max(width, sentinelWidth), height: height + sentinelStrip.height };
  const image = await window.webContents.capturePage(area, { stayHidden: true });
  if (image.isEmpty()) return undefined;
  const png = image.toPNG();
  const { width: pixelsX, height: pixelsY } = await sharp(png).metadata();
  if (!pixelsX || !pixelsY) return undefined;
  const scaleX = pixelsX / area.width, scaleY = pixelsY / area.height;
  const samples = await Promise.all(sentinelSamples(height).map(async ({ x, y }) => {
    const data = await sharp(png).extract({ left: Math.min(pixelsX - 1, Math.floor(x * scaleX)), top: Math.min(pixelsY - 1, Math.floor(y * scaleY)),
      width: 1, height: 1 }).removeAlpha().raw().toBuffer();
    return [data[0], data[1], data[2]] as Rgb;
  }));
  if (!sentinelMatches(samples, sentinel)) return undefined;
  // Normalize the encoded dimensions on displays with a device scale factor other than one.
  return sharp(png).extract({ left: 0, top: 0, width: Math.min(pixelsX, Math.round(width * scaleX)), height: Math.min(pixelsY, Math.round(height * scaleY)) })
    .resize(width, height, { fit: 'fill' });
}

export async function captureBookPreview(url: string, request: PreviewRequest, signal?: AbortSignal, inspect?: InspectionRequest,
  onActivity?: () => void): Promise<BookPreview> {
  const options = parsePreviewRequest(request);
  const sentinel = makeSentinel();
  const marker = formatSentinel(sentinel);
  const query = new URLSearchParams({ view: 'artwork', request: JSON.stringify(options), sentinel: marker });
  if (inspect) query.set('inspect', JSON.stringify(inspect));
  return withRenderedBook(url, query, signal, async (window, status, metadata) => {
    if (!metadata) throw new PreviewError('preview-capture-failed', 'The renderer did not produce the requested artwork.');
    const { width, height } = metadata;
    const [availableWidth, availableHeight] = window.getContentSize();
    const longest = Math.max(width, height);
    const wrongEdge = 'kind' in metadata ? longest > options.maxEdge : longest !== options.maxEdge;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
        wrongEdge || width > availableWidth || height + sentinelStrip.height > availableHeight) {
      throw new PreviewError('preview-capture-failed', 'The rendered artwork does not fit the preview dimensions.');
    }
    let problem = 'the artwork was not painted';
    try {
      await window.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
      for (let attempt = 0; attempt < captureAttempts; attempt++) {
        signal?.throwIfAborted();
        // A ready layout can precede its compositor paint in a hidden window, especially on Linux and after heavy GPU
        // work such as large maps. Ask for a fresh paint, and accept only a frame that shows this request's sentinel.
        window.webContents.invalidate();
        await nextFrame(window);
        problem = await artworkOnScreen(window, marker, width, height);
        if (problem) continue;
        const raster = await captureArtwork(window, sentinel, width, height);
        if (!raster) { problem = 'the captured frame was painted before the artwork'; continue; }
        const jpeg = options.format === 'jpeg';
        const bytes = await (jpeg ? raster.jpeg({ quality: 90, chromaSubsampling: '4:4:4' }) : raster.png()).toBuffer();
        return { ...metadata, status, bytes, mimeType: jpeg ? 'image/jpeg' : 'image/png' };
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new PreviewError('preview-capture-failed', 'ImageFlow could not capture the rendered artwork.', { cause: error });
    }
    // Never return pixels that may show another spread, or an unpainted page, under this request's metadata.
    throw new PreviewError('preview-capture-failed', 'ImageFlow could not capture the requested artwork: ' + problem +
      '. No image was returned, because it might not show what was requested. Try again.');
  }, onActivity);
}
