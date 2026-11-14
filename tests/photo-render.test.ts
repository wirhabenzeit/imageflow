import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { mm, resolveFormat } from '../src/format';
import { projectSchema } from '../src/project';
import type { RenderProject } from '../src/project';
import { getCrop } from '../src/spread';
import { box, chooseFormat, photoRender, runtime, setLivePlacement, SpreadView, templateSchema } from '../src/template';
import type { PhotoBoxState, PhotoRender, RenderContext } from '../src/template';

const format = { label: 'F', trim: { width: mm(200), height: mm(100) },
  bleed: { top: mm(0), bottom: mm(0), outside: mm(0), binding: mm(0) }, safe: { top: mm(5), bottom: mm(5), outside: mm(5), binding: mm(5) },
  structure: { delivery: 'pages', ends: 'inside-covers', pageCount: { min: 2, max: 20, step: 2 } },
  output: { container: 'pdf', colorSpace: 'sRGB', transparency: 'allow' } };
const photos = {
  wide: { src: 'imageflow://render/b/photo/wide', width: 6000, height: 2000, caption: 'Wide', altText: 'A wide view' },
  tall: { src: 'imageflow://render/b/photo/tall', width: 2000, height: 3000, title: 'Tall' },
};
type Received = { photo: PhotoRender; box: PhotoBoxState };

function renderBox(options: { mode?: 'edit' | 'export'; assigned?: string; crops?: object; callback?: unknown; rect?: boolean; lazy?: boolean } = {}) {
  const received: Received[] = [];
  const { mode = 'export', assigned = 'wide', crops, rect = true } = options;
  const callback = 'callback' in options ? options.callback : (photo: PhotoRender, state: PhotoBoxState): ReactNode => {
    received.push({ photo, box: state });
    return createElement('svg', { className: 'art' }, createElement('image', { href: photo.src, ...photo.image }));
  };
  const template = chooseFormat(templateSchema.parse({ id: 'pr', version: '1', contract: 1, format, parameters: {},
    spreads: { main: { label: 'Main', boxes: { hero: box.photo('Hero', { tilt: { type: 'number', label: 'Tilt', default: 2, min: -10, max: 10 } }) },
      render: (ctx: RenderContext) => createElement(runtime.Spread, {},
        createElement(ctx.PhotoBox, { id: 'hero', ...(rect ? { rect: { x: 0, y: 0, width: 100, height: 50 } } : {}) }, callback as never)) } } }));
  const project = projectSchema.parse({ schemaVersion: 1, title: 'P', template: { id: 'pr', version: '1' },
    spreads: [{ id: 'one', definition: 'main', boxes: { hero: { ...(assigned ? { photo: assigned } : {}), ...(crops ? { crops } : {}), params: { tilt: -4 } } } }] });
  const book = { project, photos: structuredClone(photos), texts: {}, files: {}, problems: [], mode, template: { script: '', assets: {} } } as RenderProject;
  const html = renderToStaticMarkup(createElement(SpreadView, { book, template, format: resolveFormat(template.format), spread: project.spreads[0],
    page: { left: 1, right: 2 }, index: { pages: 2, anchors: [] }, positions: {}, renderPhotos: true, lazyPhotos: !!options.lazy }));
  return { html, received };
}

test('a render callback receives the host crop, rendition, resolution, metadata and the resolved box', () => {
  const { html, received } = renderBox({ crops: { main: { centerX: .25, centerY: .5, zoom: 2 } } });
  assert.equal(received.length, 1);
  const [{ photo, box: state }] = received;
  const size = { width: 100 * 96 / 25.4, height: 50 * 96 / 25.4 };
  const crop = getCrop(photos.wide, { centerX: .25, centerY: .5, zoom: 2 }, size.width / size.height);
  assert.deepEqual(photo.crop, crop);
  assert.deepEqual(photo.box, size);
  assert.deepEqual(photo.placement, { centerX: .25, centerY: .5, zoom: 2 });
  assert.deepEqual(photo.pixels, { width: 6000, height: 2000 });
  // The whole photo sits so the visible part fills the box exactly.
  assert.ok(Math.abs(photo.image.width * crop.width - size.width) < 1e-9 && Math.abs(photo.image.height * crop.height - size.height) < 1e-9);
  assert.ok(Math.abs(photo.image.x + crop.x * photo.image.width) < 1e-9 && Math.abs(photo.image.y + crop.y * photo.image.height) < 1e-9);
  assert.equal(photo.style.width, 100 / crop.width + '%');
  assert.equal(photo.style.left, -100 * crop.x / crop.width + '%');
  assert.ok(Math.abs(photo.ppi - 6000 * crop.width / size.width * 96) < 1e-6);
  assert.equal(photo.alt, 'A wide view');
  assert.deepEqual(photo.metadata, { width: 6000, height: 2000, caption: 'Wide', altText: 'A wide view' });
  // Export loads a rendition sized for the crop at print resolution (300 ppi by default), rounded up to 16 px.
  assert.match(photo.src, /\/photo\/wide\/\d+$/);
  const width = Number(photo.src.split('/').at(-1));
  assert.ok(width >= photo.image.width / 96 * 300 && width < photo.image.width / 96 * 300 + 16);
  assert.deepEqual(state, { id: 'hero', uid: 'if-3-one-hero', params: { tilt: -4 }, photo: { width: 6000, height: 2000, caption: 'Wide', altText: 'A wide view' } });
  assert.match(html, /data-photo-render="custom"/);
  assert.match(html, /<svg class="art"><image href="imageflow:\/\/render\/b\/photo\/wide\/\d+"/);
  assert.doesNotMatch(html, /<img/);
});

test('the default PhotoBox and the callback share one crop; edit mode uses the preview rendition', () => {
  const edit = renderBox({ mode: 'edit', assigned: 'tall' });
  assert.equal(edit.received[0].photo.src, photos.tall.src);
  assert.equal(edit.received[0].photo.alt, 'Tall');
  const direct = photoRender({ ...photos.tall }, { centerX: .5, centerY: .5, zoom: 1 }, edit.received[0].photo.box, photos.tall.src);
  assert.deepEqual(edit.received[0].photo.crop, direct.crop);
  // Without a callback the existing renderer is unchanged.
  const plain = renderBox({ mode: 'edit', callback: undefined });
  assert.equal(plain.received.length, 0);
  assert.match(plain.html, /<img src="imageflow:\/\/render\/b\/photo\/wide" alt="A wide view"\/>/);
  assert.doesNotMatch(plain.html, /data-photo-render/);
});

test('empty, missing, unmeasured and lazy boxes do not call the callback and keep platform placeholders', () => {
  const empty = renderBox({ mode: 'edit', assigned: '' });
  assert.equal(empty.received.length, 0);
  assert.match(empty.html, /Drop a photo/);
  const missing = renderBox({ mode: 'edit', assigned: 'gone' });
  assert.equal(missing.received.length, 0);
  assert.match(missing.html, /Missing photo/);
  // Without a rect the box is measured before paint; a static render has no measurement yet.
  const unmeasured = renderBox({ rect: false });
  assert.equal(unmeasured.received.length, 0);
  assert.match(unmeasured.html, /data-pending=""/);
  // The lazy book view draws the photo once the spread comes near the screen.
  const lazy = renderBox({ mode: 'edit', lazy: true });
  assert.equal(lazy.received.length, 0);
  assert.match(lazy.html, /data-pending=""/);
});

test('crop gestures reach the callback in the editor only, and a non-function child is a clear error', () => {
  setLivePlacement('one', 'hero', { centerX: .9, centerY: .5, zoom: 3 });
  try {
    assert.deepEqual(renderBox({ mode: 'edit' }).received[0].photo.placement, { centerX: .9, centerY: .5, zoom: 3 });
    // Export always draws the saved crop.
    assert.deepEqual(renderBox({ mode: 'export' }).received[0].photo.placement, { centerX: .5, centerY: .5, zoom: 1 });
  } finally {
    setLivePlacement('', '', undefined);
  }
  assert.deepEqual(renderBox({ mode: 'edit' }).received[0].photo.placement, { centerX: .5, centerY: .5, zoom: 1 });
  assert.throws(() => renderBox({ callback: 'not a function' }), /PhotoBox hero: children must be a render function/);
});
