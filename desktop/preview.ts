import { BrowserWindow } from 'electron';
import sharp from 'sharp';
import { desktopScheme } from '../src/desktop';
import type { RenderStatus } from '../src/desktop';
import { maxPreviewEdge, parsePreviewRequest, PreviewError } from '../src/preview';
import type { PreviewMetadata, PreviewRequest } from '../src/preview';
import type { InspectionRequest } from '../src/inspection';

type ReadyStatus = Extract<RenderStatus, { state: 'ready' }>;
export type BookPreview = PreviewMetadata & {
  bytes: Uint8Array;
  mimeType: 'image/png' | 'image/jpeg';
  status: ReadyStatus;
};

type RenderResult = { status: RenderStatus; preview: Window['imageflowPreview'] };
const renderTimeoutMs = 60_000;

async function withRenderedBook<T>(
  url: string, query: URLSearchParams, signal: AbortSignal | undefined,
  useRender: (window: BrowserWindow, status: ReadyStatus, preview: PreviewMetadata | undefined) => T | Promise<T>,
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
    width: maxPreviewEdge, height: maxPreviewEdge,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('will-redirect', (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const lifecycle = new AbortController();
  const stop = setTimeout(() => lifecycle.abort(new PreviewError('render-timeout', 'Timed out rendering the book.')), renderTimeoutMs);
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
      throw new PreviewError(preview?.state === 'error' ? preview.code : 'render-failed', status.message, { template: status.template });
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
    clearTimeout(stop);
    runSignal.removeEventListener('abort', abort);
    if (!window.isDestroyed()) window.destroy();
  }
}

export function checkBookRender(url: string, signal?: AbortSignal, inspect?: InspectionRequest) {
  const query = new URLSearchParams({ view: 'check' });
  if (inspect) query.set('inspect', JSON.stringify(inspect));
  return withRenderedBook(url, query, signal, (_window, status) => status);
}

export async function captureBookPreview(url: string, request: PreviewRequest, signal?: AbortSignal, inspect?: InspectionRequest): Promise<BookPreview> {
  const options = parsePreviewRequest(request);
  const query = new URLSearchParams({ view: 'artwork', request: JSON.stringify(options) });
  if (inspect) query.set('inspect', JSON.stringify(inspect));
  return withRenderedBook(url, query, signal, async (window, status, metadata) => {
    if (!metadata) throw new PreviewError('preview-capture-failed', 'The renderer did not produce the requested artwork.');
    const { width, height } = metadata;
    const [availableWidth, availableHeight] = window.getContentSize();
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
        Math.max(width, height) > options.maxEdge || width > availableWidth || height > availableHeight) {
      throw new PreviewError('preview-capture-failed', 'The rendered artwork does not fit the preview dimensions.');
    }
    try {
      const image = await window.webContents.capturePage({ x: 0, y: 0, width, height }, { stayHidden: true });
      if (image.isEmpty()) throw new Error('The capture returned no pixels.');
      // Normalize the encoded dimensions on displays with a device scale factor other than one.
      const raster = sharp(image.toPNG()).resize(width, height, { fit: 'fill' });
      const jpeg = options.format === 'jpeg';
      const bytes = await (jpeg ? raster.jpeg({ quality: 90, chromaSubsampling: '4:4:4' }) : raster.png()).toBuffer();
      return { ...metadata, status, bytes, mimeType: jpeg ? 'image/jpeg' : 'image/png' };
    } catch (error) {
      throw new PreviewError('preview-capture-failed', 'ImageFlow could not capture the rendered artwork.', { cause: error });
    }
  });
}
