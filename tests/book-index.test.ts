import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { mm, pageSequence, resolveFormat } from '../src/format';
import { projectSchema } from '../src/project';
import type { RenderProject } from '../src/project';
import { bookContext, bookIndex, chooseFormat, editorContext, runtime, SpreadView, templateSchema } from '../src/template';
import type { BookSpread, RenderContext } from '../src/template';

const format = (facingPages = true) => ({
  label: 'Index test', trim: { width: mm(100), height: mm(100) },
  bleed: facingPages ? { top: mm(3), bottom: mm(3), outside: mm(3), binding: mm(0) } : { top: mm(3), bottom: mm(3), left: mm(3), right: mm(3) },
  safe: facingPages ? { top: mm(5), bottom: mm(5), outside: mm(5), binding: mm(5) } : { top: mm(5), bottom: mm(5), left: mm(5), right: mm(5) },
  structure: facingPages ? { delivery: 'pages', ends: 'single-pages', pageCount: { min: 2, max: 40, step: 2 } }
    : { facingPages: false, pageCount: { min: 1, max: 40, step: 1 } },
  output: { container: 'pdf', colorSpace: 'sRGB', transparency: 'allow' },
});
const photo = (label: string) => ({ type: 'photo', label });
const photos = {
  a: { src: '/photo/a', width: 3000, height: 2000, credit: 'Ann', caption: 'Lake' },
  b: { src: '/photo/b', width: 2000, height: 3000, credit: 'Ben' },
};
const seen: BookSpread[][] = [];
function setup(spreads: object[], facingPages = true) {
  const render = (ctx: RenderContext) => { seen.push(ctx.book.spreads as BookSpread[]); return createElement(runtime.Spread, {}); };
  const template = chooseFormat(templateSchema.parse({
    id: 'index', version: '1', contract: 1, format: format(facingPages), parameters: {},
    spreads: facingPages ? {
      opening: { label: 'Opening', span: 'right', boxes: { hero: photo('Hero') }, render },
      pair: { label: 'Pair', boxes: { hero: photo('Hero'), second: photo('Second'), story: { type: 'markdown', label: 'Story', flowOrder: 1 } }, render },
      single: { label: 'Single', boxes: { hero: photo('Hero') }, render },
      closing: { label: 'Closing', span: 'left', render },
    } : { month: { label: 'Month', boxes: { hero: photo('Hero') }, render } },
  }));
  const project = projectSchema.parse({ schemaVersion: 1, title: 'Index', template: { id: 'index', version: '1' }, spreads });
  const book = { project, photos: structuredClone(photos), texts: {}, files: {}, problems: [], mode: 'export', template: { script: '', assets: {} } } as RenderProject;
  const sequence = pageSequence(project.spreads.map(({ definition }) => template.spreads[definition]?.span ?? 'spread'), template.format);
  return { template, book, sequence, index: bookIndex(book, template, sequence) };
}

test('the book index lists spreads in order with pages and active photo assignments', () => {
  const { index } = setup([
    { id: 'start', definition: 'opening', boxes: { hero: { photo: 'a' } } },
    // The same photo twice, an empty box, a missing photo and content kept from another layout.
    { id: 'one', definition: 'pair', boxes: { hero: { photo: 'a' }, second: { photo: 'gone' }, kept: { photo: 'b' } } },
    { id: 'two', definition: 'single', boxes: { second: { photo: 'b' } } },
    { id: 'end', definition: 'closing', boxes: { hero: { photo: 'b' } } },
  ]);
  assert.deepEqual(index.spreads, [
    { id: 'start', layout: 'opening', page: { right: 1 }, photos: [{ box: 'hero', photoId: 'a', photo: { width: 3000, height: 2000, credit: 'Ann', caption: 'Lake' } }] },
    { id: 'one', layout: 'pair', page: { left: 2, right: 3 }, photos: [
      { box: 'hero', photoId: 'a', photo: { width: 3000, height: 2000, credit: 'Ann', caption: 'Lake' } },
      { box: 'second', photoId: 'gone', photo: null },
    ] },
    { id: 'two', layout: 'single', page: { left: 4, right: 5 }, photos: [{ box: 'hero', photoId: null, photo: null }] },
    { id: 'end', layout: 'closing', page: { left: 6 }, photos: [] },
  ]);
});

test('single-page formats, unknown layouts and reordering give defined results', () => {
  assert.deepEqual(setup([{ id: 'jan', definition: 'month', boxes: { hero: { photo: 'b' } } }, { id: 'feb', definition: 'month' }], false).index.spreads
    ?.map(({ id, page, photos: placed }) => [id, page, placed.map(({ photoId }) => photoId)]), [['jan', { number: 1 }, ['b']], ['feb', { number: 2 }, [null]]]);
  const spreads = [{ id: 'x', definition: 'single', boxes: { hero: { photo: 'a' } } }, { id: 'y', definition: 'pair', boxes: { hero: { photo: 'b' } } }];
  const before = setup(spreads).index.spreads!;
  const after = setup([...spreads].reverse()).index.spreads!;
  assert.deepEqual(before.map(({ id, page }) => [id, page]), [['x', { left: 1, right: 2 }], ['y', { left: 3, right: 4 }]]);
  assert.deepEqual(after.map(({ id, page }) => [id, page]), [['y', { left: 1, right: 2 }], ['x', { left: 3, right: 4 }]]);
  // Switching layout changes which boxes are listed, from the same saved content.
  assert.deepEqual(setup([{ id: 'x', definition: 'pair', boxes: { hero: { photo: 'a' }, second: { photo: 'b' } } }]).index.spreads![0].photos.map(({ photoId }) => photoId), ['a', 'b']);
  assert.deepEqual(setup([{ id: 'x', definition: 'single', boxes: { hero: { photo: 'a' }, second: { photo: 'b' } } }]).index.spreads![0].photos.map(({ photoId }) => photoId), ['a']);
});

test('every spread, and the editor context, read the same frozen index, which cannot change the book', () => {
  const { template, book, sequence, index } = setup([
    { id: 'one', definition: 'pair', boxes: { hero: { photo: 'a' } } },
    { id: 'two', definition: 'single', boxes: { hero: { photo: 'b' } } },
  ]);
  seen.length = 0;
  for (const [i, spread] of book.project.spreads.entries()) {
    renderToStaticMarkup(createElement(SpreadView, { book, template, format: resolveFormat(template.format), spread,
      page: sequence.spreads[i].page, index, positions: {}, renderPhotos: false }));
  }
  assert.equal(seen.length, 2);
  assert.equal(seen[0], seen[1]);
  assert.ok(Object.isFrozen(seen[0]) && Object.isFrozen(seen[0][0].photos[0].photo));
  assert.throws(() => { (seen[0][0].photos[0].photo as { credit?: string }).credit = 'Changed'; }, TypeError);
  assert.throws(() => { (seen[0] as BookSpread[]).push(seen[0][0]); }, TypeError);
  assert.equal(book.photos.a.credit, 'Ann');
  // The index carries no photo URLs.
  assert.equal(JSON.stringify(index.spreads).includes('/photo/'), false);
  const opened = editorContext(book, template, 'two')!;
  assert.deepEqual(opened.context.book.spreads, index.spreads);
  // An assignment the editor sees changes the editor context's key, so open editors refresh.
  const changed = structuredClone(book.project);
  changed.spreads[0].boxes.hero = { photo: 'b', params: {} };
  assert.notEqual(editorContext({ ...book, project: changed }, template, 'two')!.key, opened.key);
  // Repeated derivation from the same input gives the same index.
  assert.deepEqual(bookIndex(book, template, sequence).spreads, index.spreads);
  assert.deepEqual(bookContext({ pages: 0, anchors: [] }, 'one').spreads, []);
});

test('freezing the index leaves nested photo metadata in the render input writable', () => {
  const { book, template, sequence } = setup([{ id: 'one', definition: 'single', boxes: { hero: { photo: 'a' } } }]);
  (book.photos.a as { captured?: object }).captured = { dateTime: '2026-07-01T10:00:00', offset: null };
  const index = bookIndex(book, template, sequence);
  assert.ok(Object.isFrozen(index.spreads![0].photos[0].photo!.captured));
  assert.ok(!Object.isFrozen((book.photos.a as { captured?: object }).captured));
});

test('render reads its own spread ID and layout, to find itself in the book index', () => {
  const ids: string[] = [];
  const template = chooseFormat(templateSchema.parse({
    id: 'index', version: '1', contract: 1, format: format(), parameters: {},
    spreads: { pair: { label: 'Pair', render: (ctx: RenderContext) => {
      ids.push(ctx.spread + ':' + ctx.layout + ':' + ctx.book.spreads.filter(({ id }) => id !== ctx.spread).length);
      return createElement(runtime.Spread, {});
    } } },
  }));
  const project = projectSchema.parse({ schemaVersion: 1, title: 'Index', template: { id: 'index', version: '1' }, spreads: [
    { id: 'one', definition: 'pair' }, { id: 'two', definition: 'pair' }] });
  const book = { project, photos: {}, texts: {}, files: {}, problems: [], mode: 'export', template: { script: '', assets: {} } } as unknown as RenderProject;
  const sequence = pageSequence(project.spreads.map(() => 'spread' as const), template.format);
  const index = bookIndex(book, template, sequence);
  const formatted = resolveFormat(template.format);
  for (const [i, spread] of project.spreads.entries()) {
    renderToStaticMarkup(createElement(SpreadView, { book, template, format: formatted, spread, page: sequence.spreads[i].page, index, positions: {}, renderPhotos: false }));
  }
  // A layout preview renders the selected spread under the previewed layout's ID and keeps the book's spread ID.
  renderToStaticMarkup(createElement(SpreadView, { book, template, format: formatted, spread: { ...project.spreads[0], id: 'pair' },
    page: sequence.spreads[0].page, index, positions: {}, renderPhotos: false, bookSpread: 'one' }));
  assert.deepEqual(ids, ['one:pair:1', 'two:pair:1', 'one:pair:1']);
});

test('credits are collected once per ID from every spread, with their pages, from saved values including elements', () => {
  const render = () => createElement(runtime.Spread, {});
  const mapCredits = ({ elements }: { elements: Record<string, { params: Record<string, unknown> }> }) => [
    { id: 'osm', text: '© OpenStreetMap contributors' },
    ...(elements.map.params.style === 'contours' ? [{ id: 'terrain', text: 'Elevation © Mapterhorn' }] : []),
  ];
  const template = chooseFormat(templateSchema.parse({
    id: 'credits', version: '1', contract: 1, format: format(), parameters: {},
    spreads: {
      opening: { label: 'Opening', span: 'right', render },
      map: { label: 'Map', elements: { map: { label: 'Map', parameters: { style: { type: 'enum', label: 'Style', default: 'plain', options: ['plain', 'contours'] } } } },
        credits: mapCredits, render },
      closing: { label: 'Closing', span: 'left', render },
    },
  }));
  const project = projectSchema.parse({ schemaVersion: 1, title: 'Credits', template: { id: 'credits', version: '1' }, spreads: [
    { id: 'o', definition: 'opening' }, { id: 'm1', definition: 'map' },
    { id: 'm2', definition: 'map', elements: { map: { params: { style: 'contours' } } } }, { id: 'c', definition: 'closing' }] });
  const book = { project, photos: {}, texts: {}, files: {}, problems: [], mode: 'export', template: { script: '', assets: {} } } as RenderProject;
  const sequence = pageSequence(project.spreads.map(({ definition }) => template.spreads[definition]?.span ?? 'spread'), template.format);
  const index = bookIndex(book, template, sequence);
  assert.deepEqual(index.credits, [
    { id: 'osm', text: '© OpenStreetMap contributors', pages: [2, 3, 4, 5], spreads: ['m1', 'm2'] },
    { id: 'terrain', text: 'Elevation © Mapterhorn', pages: [4, 5], spreads: ['m2'] },
  ]);
  assert.equal(bookContext(index, 'c').credits, index.credits, 'every spread reads the same credits');
  assert.ok(Object.isFrozen(index.credits) && Object.isFrozen(index.credits![0].pages));
  // A declaration that is not a list of credits names the layout and the spread.
  const broken = chooseFormat(templateSchema.parse({ ...template, format: format(), spreads: { ...template.spreads, map: { ...template.spreads.map, credits: () => [{ id: '' }] } } }));
  assert.throws(() => bookIndex(book, broken, sequence), /Map declares invalid credits/);
});

test('credits read box parameters and photos, credit one page by side, reject spaced IDs and report conflicts', () => {
  const render = () => createElement(runtime.Spread, {});
  type Context = { boxes: Record<string, { params: Record<string, unknown>; photo?: { credit?: string } | null }> };
  const template = chooseFormat(templateSchema.parse({
    id: 'credits', version: '1', contract: 1, format: format(), parameters: {},
    spreads: {
      opening: { label: 'Opening', span: 'right', render },
      photo: { label: 'Photo', boxes: { hero: photo('Hero'), note: { type: 'markdown', label: 'Note', flowOrder: 1,
        parameters: { source: { type: 'string', label: 'Source', default: '' } } } },
        credits: ({ boxes }: Context) => [
          ...(boxes.hero.photo?.credit ? [{ id: 'photo-' + boxes.hero.photo.credit, text: 'Photo ' + boxes.hero.photo.credit, side: 'right' }] : []),
          ...(boxes.note.params.source ? [{ id: 'source', text: String(boxes.note.params.source) }] : []),
        ], render },
    },
  }));
  const project = projectSchema.parse({ schemaVersion: 1, title: 'Credits', template: { id: 'credits', version: '1' }, spreads: [
    { id: 'o', definition: 'opening' },
    { id: 'p1', definition: 'photo', boxes: { hero: { photo: 'a' }, note: { params: { source: 'Atlas' } } } },
    { id: 'p2', definition: 'photo', boxes: { hero: { photo: 'b' }, note: { params: { source: 'Other atlas' } } } },
    { id: 'p3', definition: 'photo' }] });
  const book = { project, photos: structuredClone(photos), texts: {}, files: {}, problems: [], mode: 'export', template: { script: '', assets: {} } } as RenderProject;
  const sequence = pageSequence(project.spreads.map(({ definition }) => template.spreads[definition]?.span ?? 'spread'), template.format);
  const index = bookIndex(book, template, sequence);
  assert.deepEqual(index.credits, [
    { id: 'photo-Ann', text: 'Photo Ann', pages: [3], spreads: ['p1'] },
    { id: 'source', text: 'Atlas', pages: [2, 3, 4, 5], spreads: ['p1', 'p2'] },
    { id: 'photo-Ben', text: 'Photo Ben', pages: [5], spreads: ['p2'] },
  ]);
  assert.deepEqual(index.creditConflicts, [{ id: 'source', spread: 'p2', text: 'Other atlas', kept: { text: 'Atlas' } }]);
  const spaced = chooseFormat(templateSchema.parse({ ...template, format: format(), spreads: { ...template.spreads, photo: { ...template.spreads.photo, credits: () => [{ id: 'two words', text: 'x' }] } } }));
  assert.throws(() => bookIndex(book, spaced, sequence), /id must not contain whitespace/);
});
