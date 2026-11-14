// Host-managed asynchronous rendering (ADR 0006). A layout element whose picture takes time to make, such as a map
// drawn by a WebGL library from remote tiles, renders through <RenderedImage>. The host tells it the element's size,
// the output resolution and a cancellation signal, limits how many run at once, and waits for all of them, with a
// timeout, before a Book check or an export page is final. The result is an image owned by the frame: rendering
// never changes the book's saved content. Thumbnails can reuse pictures from their book window's cache.
import { useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { previewPictureUrl, readPreviewPicture, savePreviewPicture } from './preview-picture';

export type RenderMode = 'preview' | 'check' | 'export';
export type RenderTarget = {
  // The element's size in CSS pixels (96 per inch), as laid out on the page.
  width: number; height: number;
  // Device pixels per CSS pixel: the screen's for previews, the format's target resolution ÷ 96 for export.
  pixelRatio: number;
  mode: RenderMode;
  // Aborted when the element unmounts, its inputs change, or the host gives up on it.
  signal: AbortSignal;
};
export type RenderedPicture = Blob | HTMLCanvasElement | OffscreenCanvas;
export type RenderedImageProps = {
  // Draws the picture for the target. Throw (or reject) to report a failure; the message is shown to the user.
  draw: (target: RenderTarget) => Promise<RenderedPicture>;
  // Everything `draw` depends on, as JSON-like data. The picture is drawn again when it changes.
  inputs: unknown;
  // Names the picture in progress and failure messages, such as 'Map'.
  label?: string;
  alt?: string;
  className?: string;
  style?: CSSProperties;
};

type Settings = { mode: RenderMode; pixelRatio: number; concurrency: number; timeoutMs: number; previewCache?: string; activeSpreads?: ReadonlySet<string> };
export type RenderedImageFailure = { label: string; message: string; spread?: string; element?: string; timedOut: boolean };

let settings: Settings = { mode: 'preview', pixelRatio: 1, concurrency: 2, timeoutMs: 60_000 };
let running = 0;
const queue: (() => void)[] = [];
const pending = new Set<Promise<unknown>>();
const restoring = new Set<Promise<void>>();
const failures = new Map<HTMLElement, RenderedImageFailure>();

/** Set by the render frame before it renders layouts. */
export function configureRenderedImages(next: Partial<Settings>) {
  settings = { ...settings, ...next };
}

const activationListeners = new Set<() => void>();
// Presentation draws pictures only for the current spread and its neighbours. Checks and exports draw all.
export function activateRenderedImageSpreads(spreads: string[]) {
  if (!settings.activeSpreads) return;
  settings.activeSpreads = new Set(spreads);
  for (const listener of activationListeners) listener();
}
function whenActive(node: HTMLElement, signal: AbortSignal) {
  const spread = node.closest<HTMLElement>('[data-spread]')?.dataset.spread;
  const active = () => signal.aborted || !settings.activeSpreads || !spread || settings.activeSpreads.has(spread);
  if (active()) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const check = () => {
      if (!active()) return;
      activationListeners.delete(check); signal.removeEventListener('abort', check); resolve();
    };
    activationListeners.add(check); signal.addEventListener('abort', check, { once: true });
    check();
  });
}

const watchers = new Set<() => void>();
const changed = () => { for (const watcher of watchers) watcher(); };
/** Calls `listener` whenever a picture starts drawing, is drawn, fails or goes; returns a function that stops it. */
export function watchRenderedImages(listener: () => void) {
  watchers.add(listener);
  return () => { watchers.delete(listener); };
}
/** The pictures still drawing and the failures on the page now, without waiting. */
export function renderedImageState() {
  return { pending: pending.size, failures: [...failures].filter(([node]) => node.isConnected).map(([, failure]) => failure) };
}

/** Whether a picture is being drawn now; the purity guards allow the declared rendering work meanwhile. */
export const renderingImages = () => running > 0;

/** Waits until every picture started so far, and any they start, has finished; returns the failures still on the page. */
export async function settleRenderedImages(): Promise<RenderedImageFailure[]> {
  while (pending.size) await Promise.allSettled([...pending]);
  return [...failures].filter(([node]) => node.isConnected).map(([, failure]) => failure);
}

// A replacement thumbnail frame must restore cached pictures before it becomes visible. Cache misses still draw
// progressively: a slow new map must not delay every other page's initial thumbnail.
export async function settleRestoredImages() {
  while (restoring.size) await Promise.allSettled([...restoring]);
}

function restorePicture() {
  let done!: () => void;
  const restored = new Promise<void>((resolve) => { done = resolve; });
  restoring.add(restored);
  return () => { restoring.delete(restored); done(); };
}

// When a picture last started or finished drawing; jobs waiting for this frame wait while it moves (render-budget).
const progress = () => { (globalThis as { imageflowRenderActivity?: number }).imageflowRenderActivity = Date.now(); };

async function slot<T>(work: () => Promise<T>) {
  if (running >= settings.concurrency) await new Promise<void>((resolve) => queue.push(resolve));
  running++;
  progress();
  try { return await work(); }
  finally { running--; progress(); queue.shift()?.(); }
}

async function toBlob(picture: RenderedPicture): Promise<Blob> {
  if (picture instanceof Blob) return picture;
  if ('convertToBlob' in picture) return picture.convertToBlob({ type: 'image/png' });
  return new Promise((resolve, reject) => picture.toBlob((blob) => blob ? resolve(blob) : reject(new Error('The canvas could not be encoded.')), 'image/png'));
}

// Libraries also reject with plain objects or events that carry a message.
const messageOf = (error: unknown) => error instanceof Error ? error.message
  : error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string' ? (error as { message: string }).message : String(error);

/**
 * An image drawn asynchronously by template code, at the element's size and the output's resolution. Until it is
 * ready the box shows a quiet placeholder; a failure shows on the page and is a Book check error, so a missing
 * picture never becomes an incomplete print silently.
 */
export function RenderedImage({ draw, inputs, label = 'Picture', alt = '', className, style }: RenderedImageProps) {
  const wrapper = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  // Drawn again when the inputs, the output settings or the box's size change; each drawing keeps the `draw` and
  // settings of the render that started it, so a queued or slow drawing never mixes old and new values.
  const [size, setSize] = useState('');
  const drawnSize = useRef('');
  const { mode, pixelRatio, timeoutMs, previewCache } = settings;
  const key = JSON.stringify([inputs ?? null, mode, pixelRatio, size]);
  useLayoutEffect(() => {
    const node = wrapper.current!;
    const observer = new ResizeObserver(() => {
      const next = node.offsetWidth + 'x' + node.offsetHeight;
      if (next !== drawnSize.current) setSize(next);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const node = wrapper.current!;
    const img = image.current!;
    const controller = new AbortController();
    const width = node.offsetWidth;
    const height = node.offsetHeight;
    drawnSize.current = width + 'x' + height;
    let url: string | undefined;
    node.dataset.rendered = 'pending';
    img.style.display = 'none';
    failures.delete(node);
    const fail = (message: string, timedOut: boolean) => {
      if (controller.signal.aborted && !timedOut) return;
      node.dataset.rendered = 'failed';
      node.title = message;
      failures.set(node, { label, message, timedOut, spread: node.closest<HTMLElement>('[data-spread]')?.dataset.spread,
        element: node.closest<HTMLElement>('[data-element]')?.dataset.element });
    };
    const restored = previewCache && mode === 'preview' ? restorePicture() : () => {};
    const task = (async () => {
      await whenActive(node, controller.signal);
      if (controller.signal.aborted) return;
      if (!width || !height) throw new Error('the element has no size on the page.');
      const spread = node.closest<HTMLElement>('[data-spread]');
      const pictureIndex = spread ? [...spread.querySelectorAll('.if-rendered-image')].indexOf(node) : 0;
      const cacheUrl = mode === 'preview' && previewCache ? await previewPictureUrl(previewCache,
        [spread?.dataset.layout ?? spread?.dataset.spread, pictureIndex, draw.toString(), inputs ?? null, width, height, pixelRatio]) : undefined;
      const cached = cacheUrl ? await readPreviewPicture(cacheUrl, controller.signal) : undefined;
      if (controller.signal.aborted) return;
      if (!cached) restored();
      const blob = cached ?? await slot(async () => {
        controller.signal.throwIfAborted();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(Object.assign(new Error(label + ' did not finish rendering within ' +
            Math.round(timeoutMs / 1000) + ' s.'), { timedOut: true })); }, timeoutMs);
        });
        try { return await Promise.race([draw({ width, height, pixelRatio, mode, signal: controller.signal }).then(toBlob), timeout]); }
        finally { clearTimeout(timer); }
      });
      if (controller.signal.aborted) return;
      url = URL.createObjectURL(blob);
      img.src = url;
      await img.decode();
      if (controller.signal.aborted) return;
      // The picture covers the box, cropped to its proportions, so its resolution is the lower of the two axes. It
      // must have the pixels asked for on both; a small or stretched picture would print blurred.
      const ratio = Math.min(img.naturalWidth / width, img.naturalHeight / height);
      if (ratio < pixelRatio * 0.98) {
        const needed = Math.floor(width * pixelRatio) + ' × ' + Math.floor(height * pixelRatio);
        throw new Error('the picture is ' + img.naturalWidth + ' × ' + img.naturalHeight + ' px, but the box needs at least ' + needed +
          ' px' + (mode === 'export' ? ' (' + Math.round(pixelRatio * 96) + ' ppi)' : '') + '.');
      }
      node.dataset.ppi = String(Math.round(ratio * 96));
      if (cacheUrl && !cached) await savePreviewPicture(cacheUrl, blob);
      if (controller.signal.aborted) return;
      img.style.display = 'block';
      node.dataset.rendered = 'ready';
      node.removeAttribute('title');
    })().catch((error) => {
      const timedOut = !!(error as { timedOut?: boolean })?.timedOut;
      fail(timedOut ? messageOf(error) : label + ' could not be rendered: ' + messageOf(error), timedOut);
    }).finally(restored);
    pending.add(task);
    changed();
    void task.finally(() => { pending.delete(task); changed(); });
    return () => {
      controller.abort();
      restored();
      failures.delete(node);
      if (url) URL.revokeObjectURL(url);
      changed();
    };
  }, [key]);
  return <div ref={wrapper} className={'if-rendered-image' + (className ? ' ' + className : '')} style={style} data-rendered="pending"
    data-rendered-label={label}>
    <img ref={image} alt={alt} style={{ display: 'none', width: '100%', height: '100%', objectFit: 'cover' }} />
  </div>;
}
