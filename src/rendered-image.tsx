// Host-managed asynchronous rendering (ADR 0006). A layout element whose picture takes time to make, such as a map
// drawn by a WebGL library from remote tiles, renders through <RenderedImage>. The host tells it the element's size,
// the output resolution and a cancellation signal, limits how many run at once, and waits for all of them, with a
// timeout, before a Book check or an export page is final. The result is an image owned by the frame: rendering
// never changes the book's saved content. The book view and thumbnails reuse pictures from their book window's cache.
import { useLayoutEffect, useRef, useState } from 'react';
import { onPage, pageOf } from './page-scope';
import type { PageSide } from './project';
import type { CSSProperties, ReactNode } from 'react';
import { previewPictureUrl, readPreviewPicture, savePreviewPicture } from './preview-picture';
import { renameIds } from './svg-ids';

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
// A raster picture (a canvas, or a PNG or JPEG Blob) or a vector one (SVG markup, an <svg> element, or an
// image/svg+xml Blob).
export type RenderedPicture = Blob | HTMLCanvasElement | OffscreenCanvas | SVGSVGElement | string;
export type RenderedImageProps = {
  // Draws the picture for the target. Throw (or reject) to report a failure; the message is shown to the user.
  draw: (target: RenderTarget) => Promise<RenderedPicture>;
  // What `draw` makes. 'vector': SVG, drawn once for every view and resolution (its target's pixelRatio is 1), and an
  // error if it returns pixels. 'raster': pixels by intent, such as satellite imagery. Undeclared, either is accepted,
  // and a raster result is a Book check warning, since a drawn picture prints better as vectors.
  output?: 'vector' | 'raster';
  // Everything `draw` depends on, as JSON-like data. The picture is drawn again when it changes.
  inputs: unknown;
  // Names the picture in progress and failure messages, such as 'Map'.
  label?: string;
  alt?: string;
  className?: string;
  style?: CSSProperties;
  // The Inspector's layout previews draw a picture only for the spread's own layout. Another layout shows the same
  // picture if it was drawn already, else the picture last drawn in that layout for another spread, else `standIn` if
  // given; a layout the book has not drawn yet is drawn once. 'draw' always draws it there.
  layoutPreview?: 'stand-in' | 'draw';
  standIn?: ReactNode;
};

type Settings = { mode: RenderMode; pixelRatio: number; concurrency: number; timeoutMs: number; previewCache?: string; activeSpreads?: ReadonlySet<string>;
  // The cache scope of each template file's pictures, and the template's hash for a picture of no known file.
  pictureScopes?: Record<string, string>; templateHash?: string;
  // Layout previews: a picture not in the cache shows a stand-in instead of being drawn.
  standIns?: boolean };
export type RenderedImageFailure = { label: string; message: string; spread?: string; element?: string; page?: PageSide; timedOut: boolean };
// Something worth changing about a picture that was drawn: it is pixels without saying so, or has far more of them
// than the output asks for.
export type RenderedImageNote = { label: string; code: 'rendered-image-raster' | 'rendered-image-oversized'; message: string;
  spread?: string; element?: string; page?: PageSide; details?: Record<string, number> };

let settings: Settings = { mode: 'preview', pixelRatio: 1, concurrency: 2, timeoutMs: 60_000 };
let running = 0;
const queue: (() => void)[] = [];
const pending = new Set<Promise<unknown>>();
const restoring = new Set<Promise<void>>();
const failures = new Map<HTMLElement, RenderedImageFailure>();
const notes = new Map<HTMLElement, RenderedImageNote[]>();

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
const isActive = (node: HTMLElement) => {
  const spread = node.closest<HTMLElement>('[data-spread]')?.dataset.spread;
  return !settings.activeSpreads || !spread || settings.activeSpreads.has(spread);
};
function whenActive(node: HTMLElement, signal: AbortSignal) {
  const active = () => signal.aborted || isActive(node);
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

/** The notes of the pictures on the page now, for the Book check. */
export const renderedImageNotes = () => [...notes].filter(([node]) => node.isConnected).flatMap(([, list]) => list);

// A replacement book or thumbnail frame must restore cached pictures before it becomes visible. Cache misses still draw
// progressively: a slow new map must not delay every other page.
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

export const svgType = 'image/svg+xml';
let vectorCopies = 0;

/**
 * An SVG picture as an element of the page, so it prints as vectors and its text uses the template's fonts. Its ids
 * are made unique, because one page may show the same picture twice; it fills the box and is cropped like a raster
 * picture unless it sets its own preserveAspectRatio.
 */
export function vectorPicture(text: string, document: Document) {
  const parsed = new DOMParser().parseFromString(text, svgType);
  const root = parsed.documentElement;
  if (parsed.querySelector('parsererror') || root.localName !== 'svg' || root.namespaceURI !== 'http://www.w3.org/2000/svg') {
    throw new Error('the SVG picture is not well-formed SVG.');
  }
  // Scripts would run in the render frame outside the declared drawing work; a picture never needs them.
  for (const node of [root, ...root.querySelectorAll('*')]) {
    if (node.localName === 'script' || node.localName === 'foreignObject') { node.remove(); continue; }
    for (const { name } of [...node.attributes]) if (/^on/i.test(name)) node.removeAttribute(name);
  }
  if (!root.getAttribute('viewBox')) throw new Error('the SVG picture has no viewBox, so it cannot be scaled to the box.');
  if (!root.hasAttribute('preserveAspectRatio')) root.setAttribute('preserveAspectRatio', 'xMidYMid slice');
  root.setAttribute('width', '100%');
  root.setAttribute('height', '100%');
  root.classList.add('if-rendered-vector');
  const svg = document.importNode(root, true);
  renameIds(svg, '.v' + ++vectorCopies);
  return svg;
}

async function toBlob(picture: RenderedPicture): Promise<Blob> {
  if (picture instanceof Blob) return picture;
  if (typeof picture === 'string') return new Blob([picture], { type: svgType });
  if (!('toBlob' in picture) && !('convertToBlob' in picture)) return new Blob([new XMLSerializer().serializeToString(picture)], { type: svgType });
  if ('convertToBlob' in picture) return picture.convertToBlob({ type: 'image/png' });
  return new Promise((resolve, reject) => picture.toBlob((blob) => blob ? resolve(blob) : reject(new Error('The canvas could not be encoded.')), 'image/png'));
}

/**
 * Calls `expire` once `ms` of drawing time has passed, and returns a function that stops it. Drawing time advances
 * with the window's animation frames, which MapLibre needs to draw a map: while the window is hidden, minimised or on
 * another Space the browser delivers none, and that time is not held against the picture. A long pause between two
 * frames, such as a busy main thread, counts as at most a quarter of a second.
 */
export function frameTimer(expire: () => void, ms: number) {
  let elapsed = 0, last = performance.now(), frame = 0;
  const tick = (now: number) => {
    elapsed += Math.min(Math.max(0, now - last), 250);
    last = now;
    if (elapsed >= ms) { frame = 0; expire(); return; }
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
  return () => { if (frame) cancelAnimationFrame(frame); frame = 0; };
}

/**
 * Pictures layered in one box, such as shaded relief under a map's lines, may fail together: their messages are
 * stacked one above the other instead of printed over each other. Each failed picture learns its line and the count.
 */
function arrangeFailures(parent: HTMLElement | null) {
  if (!parent) return;
  const failed = [...parent.children].filter((child): child is HTMLElement => child instanceof HTMLElement &&
    child.classList.contains('if-rendered-image') && child.dataset.rendered === 'failed');
  failed.forEach((picture, line) => {
    picture.style.setProperty('--if-failure-line', String(line));
    picture.style.setProperty('--if-failure-lines', String(failed.length));
  });
}

/**
 * The copy of a picture the preview cache keeps. Only screens show it, never a check or an export, so pixels are kept
 * as WebP: a canvas arrives as PNG, which for shaded relief or imagery is about thirteen times larger at the same look
 * (a 3652 × 1860 relief: 9.1 MB as PNG, 0.7 MB as WebP). Vectors, and pictures already compressed, stay as they are.
 */
export async function screenCopy(blob: Blob): Promise<Blob> {
  if (blob.type !== 'image/png' && blob.type !== 'image/bmp') return blob;
  try {
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
    bitmap.close();
    const webp = await canvas.convertToBlob({ type: 'image/webp', quality: .9 });
    return webp.type === 'image/webp' && webp.size < blob.size ? webp : blob;
  } catch { return blob; }
}

// Libraries also reject with plain objects or events that carry a message.
const messageOf = (error: unknown) => error instanceof Error ? error.message
  : error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string' ? (error as { message: string }).message : String(error);

/**
 * An image drawn asynchronously by template code, at the element's size and the output's resolution. Until it is
 * ready the box shows a quiet placeholder; a failure shows on the page and is a Book check error, so a missing
 * picture never becomes an incomplete print silently.
 */
// `pictureModule`: the template file that places the picture, set by the bundle (desktop/picture-scopes.ts); not API.
export function RenderedImage({ draw, inputs, output, label = 'Picture', alt = '', className, style, layoutPreview, standIn, pictureModule }:
  RenderedImageProps & { pictureModule?: string }) {
  const [standing, setStanding] = useState(false);
  // Pictures are cached by their source file and its imports (picture-scopes.ts), so other template edits keep them.
  const scope = (pictureModule !== undefined ? settings.pictureScopes?.[pictureModule] : undefined) ?? settings.templateHash ?? '';
  const wrapper = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const vector = useRef<HTMLDivElement>(null);
  // The object URL of the raster picture on show; it is released when another picture replaces it or the box goes.
  const shown = useRef<string>(undefined);
  useLayoutEffect(() => () => { if (shown.current) URL.revokeObjectURL(shown.current); }, []);
  // Drawn again when the inputs, the output settings or the box's size change; each drawing keeps the `draw` and
  // settings of the render that started it, so a queued or slow drawing never mixes old and new values.
  const [size, setSize] = useState('');
  const drawnSize = useRef('');
  const { mode, timeoutMs, previewCache } = settings;
  // A declared vector picture is the same at every resolution: it is drawn for a pixel ratio of 1, once for all views.
  const pixelRatio = output === 'vector' ? 1 : settings.pixelRatio;
  const key = JSON.stringify([inputs ?? null, mode, pixelRatio, size, output ?? '', scope]);
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
    const vectorBox = vector.current!;
    // The picture shown so far stays until a new one replaces it, so a redraw never blanks the box.
    node.dataset.rendered = 'pending';
    arrangeFailures(node.parentElement);
    failures.delete(node);
    notes.delete(node);
    const where = () => ({ ...onPage(pageOf(node)), spread: node.closest<HTMLElement>('[data-spread]')?.dataset.spread, element: node.closest<HTMLElement>('[data-element]')?.dataset.element });
    const found: RenderedImageNote[] = [];
    // In a check or export, a raster picture with far more pixels than the output asks for is scaled down to what it
    // asks for, so it cannot bloat the PDF, and the check says so.
    const fit = async (blob: Blob) => {
      if (blob.type === svgType || mode === 'preview') return blob;
      const bitmap = await createImageBitmap(blob);
      const excess = Math.min(bitmap.width / width, bitmap.height / height) / pixelRatio;
      if (!(excess > 1.25)) { bitmap.close(); return blob; }
      const canvas = new OffscreenCanvas(Math.ceil(bitmap.width / excess), Math.ceil(bitmap.height / excess));
      const context = canvas.getContext('2d')!;
      context.imageSmoothingQuality = 'high';
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      found.push({ label, code: 'rendered-image-oversized', ...where(),
        message: label + ' is drawn at ' + (Math.round(excess * 10) / 10) + '× the resolution the output asks for' +
          (mode === 'export' ? ' (' + Math.round(excess * pixelRatio * 96) + ' instead of ' + Math.round(pixelRatio * 96) + ' ppi)' : '') +
          '; ImageFlow scales it down.',
        details: { excess: Math.round(excess * 100) / 100 } });
      return canvas.convertToBlob({ type: blob.type === 'image/jpeg' ? 'image/jpeg' : 'image/png', quality: .92 });
    };
    const fail = (message: string, timedOut: boolean) => {
      if (controller.signal.aborted && !timedOut) return;
      // On screen the last picture drawn here stays under the message, such as the map before a slow redraw; a check
      // or an export shows none, so a stale picture is never taken for the requested one.
      if (mode !== 'preview') {
        img.style.display = 'none';
        vectorBox.style.display = 'none';
      }
      node.dataset.rendered = 'failed';
      node.title = message;
      failures.set(node, { label, message, timedOut, spread: node.closest<HTMLElement>('[data-spread]')?.dataset.spread,
        element: node.closest<HTMLElement>('[data-element]')?.dataset.element, ...onPage(pageOf(node)) });
      arrangeFailures(node.parentElement);
    };
    // Shows a picture in the box; false when the drawing was replaced meanwhile. `check` is false for a stale picture
    // shown only until the new one is drawn.
    const show = async (blob: Blob, check: boolean) => {
      if (blob.type === svgType) {
        // Vectors have no resolution to check: they print sharp at any size.
        const svg = vectorPicture(await blob.text(), node.ownerDocument);
        if (controller.signal.aborted) return false;
        vectorBox.replaceChildren(svg);
        vectorBox.style.display = 'block';
        img.style.display = 'none';
        node.dataset.vector = '';
        delete node.dataset.ppi;
        return true;
      }
      const next = URL.createObjectURL(blob);
      // Loaded in the image on the page: Chromium keeps showing the picture it had until the new one has loaded. Its
      // load event, not decode(): decode() may never settle in a frame that is still hidden, such as a presentation
      // frame being prepared in a visible window.
      const decoded = img;
      const loaded = new Promise<void>((resolve, reject) => {
        decoded.addEventListener('load', () => resolve(), { once: true });
        decoded.addEventListener('error', () => reject(new Error('the picture could not be loaded.')), { once: true });
      });
      decoded.src = next;
      const old = shown.current;
      shown.current = next;
      try { await loaded; } finally { if (old) URL.revokeObjectURL(old); }
      if (controller.signal.aborted) return false;
      // The picture covers the box, cropped to its proportions, so its resolution is the lower of the two axes. It
      // must have the pixels asked for on both; a small or stretched picture would print blurred.
      const ratio = Math.min(decoded.naturalWidth / width, decoded.naturalHeight / height);
      if (check && ratio < pixelRatio * 0.98) {
        const needed = Math.floor(width * pixelRatio) + ' × ' + Math.floor(height * pixelRatio);
        throw new Error('the picture is ' + decoded.naturalWidth + ' × ' + decoded.naturalHeight + ' px, but the box needs at least ' + needed +
          ' px' + (mode === 'export' ? ' (' + Math.round(pixelRatio * 96) + ' ppi)' : '') + '.');
      }
      img.style.display = 'block';
      vectorBox.style.display = 'none';
      vectorBox.replaceChildren();
      delete node.dataset.vector;
      node.dataset.ppi = String(Math.round(ratio * 96));
      return true;
    };
    // Only pictures that draw now hold a frame back; one waiting for its slide in a presentation must not.
    const restored = previewCache && mode === 'preview' && isActive(node) ? restorePicture() : () => {};
    const task = (async () => {
      await whenActive(node, controller.signal);
      if (controller.signal.aborted) return;
      if (!width || !height) throw new Error('the element has no size on the page.');
      const spread = node.closest<HTMLElement>('[data-spread]');
      // Counted, and keyed, within the layout the picture is in: a split sheet's page, so the Inspector's preview of
      // that page layout finds the picture the book view drew.
      const layout = node.closest<HTMLElement>('[data-layout]') ?? spread;
      const pictureIndex = layout ? [...layout.querySelectorAll('.if-rendered-image')].indexOf(node) : 0;
      const cacheUrl = mode === 'preview' && previewCache ? await previewPictureUrl(previewCache,
        [scope, layout?.dataset.layout ?? spread?.dataset.spread, pictureIndex, draw.toString(), inputs ?? null, width, height, pixelRatio]) : undefined;
      // The last picture this place showed, whatever its inputs: a replacement frame shows it while it draws the new one.
      const placeUrl = mode === 'preview' && previewCache ? await previewPictureUrl(previewCache.replace(/\/picture\/$/, '/place/'),
        ['place', spread?.dataset.spread, spread?.dataset.layout, pictureIndex, width, height, pixelRatio]) : undefined;
      // A vector picture does not depend on the pixel ratio, so the book view and its thumbnails share one: whichever
      // draws it first saves it under this key too.
      const vectorUrl = mode === 'preview' && previewCache ? await previewPictureUrl(previewCache,
        ['vector', scope, layout?.dataset.layout ?? spread?.dataset.spread, pictureIndex, draw.toString(), inputs ?? null, width, height]) : undefined;
      const shared = async () => {
        const found = vectorUrl ? await readPreviewPicture(vectorUrl, controller.signal) : undefined;
        return found?.type === svgType ? found : undefined;
      };
      // A layout preview also takes the picture the book view drew at its own resolution: sharper than it needs, and free.
      const drawnElsewhere = async () => {
        if (!settings.standIns || !previewCache || mode !== 'preview' || output === 'vector') return undefined;
        for (const ratio of [2, 1]) {
          if (ratio === pixelRatio) continue;
          const url = await previewPictureUrl(previewCache, [scope, layout?.dataset.layout ?? spread?.dataset.spread, pictureIndex, draw.toString(), inputs ?? null, width, height, ratio]);
          const found = await readPreviewPicture(url, controller.signal);
          if (found) return found;
        }
        return undefined;
      };
      const cached = (cacheUrl ? await readPreviewPicture(cacheUrl, controller.signal) : undefined) ?? await shared() ?? await drawnElsewhere();
      if (controller.signal.aborted) return;
      // The picture last drawn in this layout and place, for any spread: what the layout looks like with a real map.
      const latestUrl = mode === 'preview' && previewCache ? await previewPictureUrl(previewCache,
        ['latest', scope, layout?.dataset.layout ?? spread?.dataset.spread, pictureIndex]) : undefined;
      // A layout preview shows what a layout would look like; drawing a map for each one cost about a second per
      // selected spread. Another layout than the spread's own shows the picture last drawn in that layout, from another
      // spread, or the template's stand-in; only a layout the book has not drawn yet is drawn, once.
      if (!cached && settings.standIns && layoutPreview !== 'draw' && !node.closest('[data-current-layout]')) {
        const latest = latestUrl ? await readPreviewPicture(latestUrl, controller.signal) : undefined;
        if (controller.signal.aborted) return;
        if (latest && await show(latest, false).catch(() => false)) {
          node.dataset.rendered = 'ready';
          return;
        }
        if (standIn !== undefined) {
          setStanding(true);
          img.style.display = 'none';
          vectorBox.style.display = 'none';
          node.dataset.rendered = 'ready';
          node.dataset.standIn = '';
          return;
        }
      }
      if (!cached && placeUrl && img.style.display === 'none' && vectorBox.style.display === 'none') {
        const stale = await readPreviewPicture(placeUrl, controller.signal);
        if (stale && !controller.signal.aborted) await show(stale, false).catch(() => false);
        if (controller.signal.aborted) return;
      }
      if (!cached) restored();
      const blob = cached ?? await slot(async () => {
        controller.signal.throwIfAborted();
        let stop = () => {};
        const timeout = new Promise<never>((_, reject) => {
          const expire = () => { controller.abort(); reject(Object.assign(new Error(label + ' did not finish rendering within ' +
            Math.round(timeoutMs / 1000) + ' s.'), { timedOut: true })); };
          // In the editor and the presentation, only time the window draws counts (frameTimer).
          stop = previewCache && mode === 'preview' ? frameTimer(expire, timeoutMs) : (() => {
            const timer = setTimeout(expire, timeoutMs);
            return () => clearTimeout(timer);
          })();
        });
        const started = import.meta.env.IMAGEFLOW_PROFILE ? performance.now() : 0;
        // A draw that returns its canvas directly, not a promise of it, works too (and one that throws fails the picture).
        try { return await Promise.race([Promise.resolve().then(() => draw({ width, height, pixelRatio, mode, signal: controller.signal })).then(toBlob), timeout]); }
        finally {
          stop();
          // Profiling builds time every picture actually drawn, that is, every miss of the preview cache.
          if (import.meta.env.IMAGEFLOW_PROFILE) performance.measure('imageflow.picture.' + label + ' ' + (spread?.dataset.spread ?? '') + '#' + pictureIndex, { start: started, end: performance.now() });
        }
      });
      if (controller.signal.aborted) return;
      if (output === 'vector' && blob.type !== svgType) throw new Error('it is declared output="vector", but draw returned pixels (' + (blob.type || 'a canvas') + ').');
      if (!output && blob.type !== svgType && mode !== 'preview') {
        found.push({ label, code: 'rendered-image-raster', ...where(),
          message: label + ' is drawn as pixels, so it prints at a fixed resolution and its text is not the book’s.' });
      }
      const shownBlob = await fit(blob);
      if (controller.signal.aborted) return;
      if (!await show(shownBlob, true)) return;
      setStanding(false);
      delete node.dataset.standIn;
      if (found.length) notes.set(node, found);
      const saved = cacheUrl || placeUrl ? await screenCopy(blob) : blob;
      if (cacheUrl && !cached) await savePreviewPicture(cacheUrl, saved);
      if (vectorUrl && !cached && blob.type === svgType) await savePreviewPicture(vectorUrl, saved);
      if (placeUrl) await savePreviewPicture(placeUrl, saved);
      if (latestUrl && !cached) await savePreviewPicture(latestUrl, saved);
      if (controller.signal.aborted) return;
      node.dataset.rendered = 'ready';
      node.removeAttribute('title');
      arrangeFailures(node.parentElement);
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
      notes.delete(node);
      arrangeFailures(node.parentElement);
      changed();
    };
  }, [key]);
  return <div ref={wrapper} className={'if-rendered-image' + (className ? ' ' + className : '')} style={style} data-rendered="pending"
    data-rendered-label={label}>
    <img ref={image} alt={alt} style={{ display: 'none', width: '100%', height: '100%', objectFit: 'cover' }} />
    <div ref={vector} role={alt ? 'img' : undefined} aria-label={alt || undefined} style={{ display: 'none', width: '100%', height: '100%' }} />
    {standing && <div className="if-rendered-stand-in" style={{ width: '100%', height: '100%' }}>{standIn}</div>}
  </div>;
}
