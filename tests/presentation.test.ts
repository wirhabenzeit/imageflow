import assert from 'node:assert/strict';
import { test } from 'node:test';
import { panPresentation, presentationFit, presentationMaxZoom, presentationUnits, presentationPage, presentationPhotoSource, presentsCover, zoomPresentationAt } from '../src/presentation-model';
import { commandState, emptyMenuState } from '../src/commands';
import { mm, printFormat } from '../src/format';
import { chooseFormat, templateInfo, templateSchema } from '../src/template';
import { newSpread } from '../src/editing';
const base = { label: 'F', trim: { width: mm(100), height: mm(120) }, bleed: mm(3), safe: mm(5), pageCount: { min: 2, max: 100, step: 2 as const } };
test('presentation photo renditions are screen-sized and bounded', () => {
  const source = 'imageflow://render/render/id/proof-photo/photo';
  assert.equal(presentationPhotoSource(source, 350, true), source + '/384');
  assert.equal(presentationPhotoSource(source, 9000, true), source + '/1024');
  assert.equal(presentationPhotoSource(source, 350, false), source + '/512');
  assert.equal(presentationPhotoSource(source, 2600, false), source + '/3072');
  assert.equal(presentationPhotoSource(source, 20000, false), source + '/8192');
});
const template = (format: ReturnType<typeof printFormat>) => templateInfo(chooseFormat(templateSchema.parse({ id: 't', version: '1', contract: 1, format,
  spreads: { full: { label: 'Full', span: 'spread', render: () => null }, cover: { label: 'Cover', span: 'right', render: () => null }, back: { label: 'Back', span: 'left', render: () => null }, page: { label: 'Page', span: 'page', render: () => null } } })));

test('presentation centres single covers and keeps spreads together regardless of PDF delivery', () => {
  const book = template(printFormat({ ...base, ends: 'single-pages' }));
  const spreads = [newSpread('cover'), newSpread('full'), newSpread('back')];
  assert.deepEqual(presentationUnits(spreads, book).map(({ side, pages }) => [side, pages]), [['right', [1]], ['spread', [2, 3]], ['left', [4]]]);
  const pages = presentationUnits(spreads, book, true);
  assert.deepEqual(pages.map(({ side, pages }) => [side, pages]), [['right', [1]], ['left', [2]], ['right', [3]], ['left', [4]]]);
  assert.equal(presentationPage(pages, 3), 2);
  assert.equal(presentationPage(pages, 99), -1);
});
test('without facing pages, the F option cannot split a page', () => {
  const book = template(printFormat({ ...base, facingPages: false }));
  const spreads = [newSpread('page'), newSpread('page')];
  assert.deepEqual(presentationUnits(spreads, book, true), presentationUnits(spreads, book));
  assert.deepEqual(presentationUnits(spreads, book).map(({ pages }) => pages), [[1], [2]]);
});
test('presentation is available read-only and its typing shortcuts are not registered globally', () => {
  for (const id of ['presentation', 'presentation-start'] as const) {
    const state = commandState(id, { ...emptyMenuState, document: true, writable: false });
    assert.equal(state.enabled, true);
    assert.equal(state.registerAccelerator, false);
  }
  assert.equal(commandState('delete-spread', emptyMenuState).registerAccelerator, false);
});

test('inside-cover delivery keeps its spread intact, and an empty book has no presentation units', () => {
  const book = template(printFormat({ ...base, ends: 'inside-covers', delivery: 'spreads' }));
  assert.deepEqual(presentationUnits([newSpread('full')], book).map(({ side, pages }) => [side, pages]), [['spread', [1, 2]]]);
  assert.deepEqual(presentationUnits([], book), []);
});
test('the cover opens the presentation once it has a layout of the format, also from the Cover view', () => {
  const info = { formatId: 'square', coverFormats: { square: {} as never }, coverLayouts: { wrap: { formats: ['square'] }, other: { formats: ['a3'] } } as never };
  const cover = { definition: 'wrap', params: {}, boxes: {}, elements: {} };
  assert.equal(presentsCover(cover, info), true);
  assert.equal(presentsCover(undefined, info), false);
  assert.equal(presentsCover({ ...cover, definition: 'other' }, info), false, 'a layout of another format');
  assert.equal(presentsCover(cover, { ...info, coverFormats: {} }), false, 'a format without an exterior cover');
  for (const id of ['presentation', 'presentation-start'] as const) {
    assert.equal(commandState(id, { ...emptyMenuState, document: true, view: 'cover' }).enabled, true);
  }
});

test('presentation zoom keeps the pinched point in place, clamps to 1x-8x and pans within the screen', () => {
  const size = { width: 1000, height: 600 };
  const zoomed = zoomPresentationAt(presentationFit, 2, { x: 250, y: 150 }, size);
  assert.deepEqual(zoomed, { scale: 2, x: -250, y: -150 });
  // The point under the pointer stays there: 250 = -250 + 2 * 250.
  assert.equal(zoomed.x + zoomed.scale * 250, 250);
  assert.equal(zoomPresentationAt(zoomed, 100, { x: 0, y: 0 }, size).scale, presentationMaxZoom);
  // Zooming out to, or below, the whole spread snaps back to it.
  assert.equal(zoomPresentationAt(zoomed, .4, { x: 500, y: 300 }, size), presentationFit);
  assert.equal(zoomPresentationAt(zoomed, .505, { x: 500, y: 300 }, size), presentationFit);
  // Zooming out near an edge keeps the screen covered rather than showing empty space.
  assert.deepEqual(zoomPresentationAt({ scale: 4, x: 0, y: 0 }, .5, { x: 1000, y: 600 }, size), { scale: 2, x: 0, y: 0 });
  // A scroll moves the view over the enlarged spread, never past its edges, and does nothing while it is whole.
  assert.deepEqual(panPresentation(zoomed, 100, -40, size), { scale: 2, x: -350, y: -110 });
  assert.deepEqual(panPresentation(zoomed, 5000, -5000, size), { scale: 2, x: -1000, y: 0 });
  assert.equal(panPresentation(presentationFit, 100, 100, size), presentationFit);
});
