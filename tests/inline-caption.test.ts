import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { markedEdits, numberOccurrences } from '../src/edit-targets';
import { mm, pageSequence, printFormat, resolveFormat } from '../src/format';
import { captionElsewhere, captionPhoto, printedCaption, saveInlineCaption } from '../src/inline-caption';
import { captionParameter, textProblem } from '../src/inline-text';
import { layoutFootprint } from '../src/layouts';
import { p } from '../src/parameters';
import { projectSchema } from '../src/project';
import type { RenderProject, RenderView, SpreadState } from '../src/project';
import { bookIndex, chooseFormat, normalizeTemplate, Spread, SpreadView, templateSchema } from '../src/template';
import type { RenderContext } from '../src/template';
import { textAssignments } from '../src/text-assignments';

// UI-019: a photo's caption printed with ctx.Caption is typed on the page and saved with the photo.
const format = printFormat({ label: 'Book', trim: { width: mm(200), height: mm(240) }, bleed: { all: mm(3), binding: mm(0) },
  safe: { all: mm(10), binding: mm(18) }, pageCount: { min: 2, max: 100, step: 2 }, ends: 'inside-covers' });
const showCaption = p.boolean({ label: 'Show caption', default: false, shows: 'caption' });
const template = chooseFormat(templateSchema.parse(normalizeTemplate({ id: 'captions', version: '1', contract: 1, format,
  spreads: ({ spread }: { spread: <T>(x: T) => T }) => ({
    switched: spread({ label: 'Switched', boxes: { hero: { type: 'photo', label: 'Photo', parameters: { showCaption } } },
      render: (ctx: RenderContext) => createElement(Spread, null, createElement(ctx.PhotoBox, { id: 'hero' }),
        createElement(ctx.Caption, { box: 'hero', as: 'figcaption', className: 'caption' })) }),
    always: spread({ label: 'Always', boxes: { hero: { type: 'photo', label: 'Photo' }, story: { type: 'markdown', label: 'Story' } },
      render: (ctx: RenderContext) => createElement(Spread, null, createElement(ctx.Caption, { box: 'hero', placeholder: 'Say where' })) }),
    wrong: spread({ label: 'Wrong', boxes: { story: { type: 'markdown', label: 'Story' } },
      render: (ctx: RenderContext) => createElement(Spread, null, createElement(ctx.Caption, { box: 'story' })) }),
  }) })));
const sheet = (definition: string, params: Record<string, boolean> = {}, photo: string | null = 'photo'): SpreadState =>
  ({ id: 's', definition, params: {}, boxes: { hero: { ...(photo ? { photo } : {}), params } }, elements: {} });
const book = (spread: SpreadState, caption: string | undefined, mode: RenderProject['mode'] = 'edit', view?: RenderView): RenderProject => ({
  project: projectSchema.parse({ schemaVersion: 2, title: 'Captions', template: { id: 'captions', version: '1' }, spreads: [spread] }),
  mode, ...(view ? { view } : {}), template: { script: '', assets: {} }, texts: {}, files: {},
  photos: { photo: { width: 300, height: 200, ...(caption === undefined ? {} : { caption }), src: 'photo.jpg' } },
});
const markup = (input: RenderProject) => {
  const sequence = pageSequence(input.project.spreads.map((spread) => layoutFootprint(spread, template.spreads)), format);
  return renderToStaticMarkup(createElement(SpreadView, { book: input, template, format: resolveFormat(format),
    spread: input.project.spreads[0], page: sequence.spreads[0].page, index: bookIndex(input, template, sequence),
    positions: textAssignments(input, template).positions, renderPhotos: false }));
};

test('ctx.Caption prints the photo’s caption, marked with its box, only while Show caption is on', () => {
  const on = markup(book(sheet('switched', { showCaption: true }), 'At the pass'));
  assert.match(on, /<figcaption data-caption="hero" class="caption"[^>]*>At the pass<\/figcaption>/);
  assert.doesNotMatch(markup(book(sheet('switched'), 'At the pass')), /data-caption/, 'the switch is off by default');
  assert.doesNotMatch(markup(book(sheet('switched', { showCaption: true }, null), 'At the pass')), /data-caption/, 'an empty box has no photo to own a caption');
  assert.match(markup(book(sheet('always'), 'Line one\nLine two')), /<p data-caption="hero"[^>]*>Line one\nLine two<\/p>/, 'a box without a switch always prints it');
  assert.throws(() => markup(book({ ...sheet('wrong'), boxes: {} }, undefined)), /photo box story/);
});

test('an empty caption invites a click on the editing canvas only', () => {
  const canvas = markup(book(sheet('switched', { showCaption: true }), ''));
  assert.match(canvas, /data-caption="hero" data-empty=""[^>]*><span class="if-text-placeholder">Add caption<\/span>/);
  assert.match(markup(book(sheet('always'), '  ')), /<span class="if-text-placeholder">Say where<\/span>/, 'whitespace is empty too');
  for (const [mode, view] of [['edit', 'thumbnail'], ['edit', 'layout-preview'], ['export', undefined]] as const) {
    const html = markup(book(sheet('switched', { showCaption: true }), undefined, mode, view));
    assert.match(html, /<figcaption data-caption="hero" class="caption"><\/figcaption>/, (view ?? mode) + ' shows an empty node');
    assert.doesNotMatch(html, /Add caption/);
  }
});

test('caption marks are edit targets without fields, numbered among themselves', () => {
  const node = (attributes: Record<string, string>) => ({ dataset: attributes }) as unknown as HTMLElement;
  assert.deepEqual(markedEdits(node({ caption: 'hero' })), []);
  assert.deepEqual(markedEdits(node({ edit: 'heading  boxes.hero.showCaption' })), ['heading', 'boxes.hero.showCaption']);
  const targets = numberOccurrences([{ edits: [] }, { edits: ['heading'] }, { edits: [] }, { edits: [], page: 'left' as const }]);
  assert.deepEqual(targets.map(({ occurrence }) => occurrence), [0, 0, 1, 0]);
  assert.equal(textProblem(captionParameter, 'Any length and\nline breaks'), '');
});

const files = (caption?: string, params: Record<string, boolean> = {}) => ({
  photoIndex: { photo: { path: 'photos/photo.jpg', ...(caption === undefined ? {} : { caption }) } } as Record<string, { path: string; caption?: string }>,
  project: projectSchema.parse({ schemaVersion: 2, title: 'Captions', template: { id: 'captions', version: '1' }, spreads: [sheet('switched', params)] }),
});
const at = { spread: 's', box: 'hero', layout: 'switched' };
const parameters = { showCaption };

test('a typed caption is printed caption first: the book’s own, even empty, else its provider’s', () => {
  assert.equal(printedCaption({ photoIndex: files().photoIndex, photoProvided: { photo: { caption: 'From Photos' } } }, 'photo'), 'From Photos');
  assert.equal(printedCaption({ photoIndex: files('').photoIndex, photoProvided: { photo: { caption: 'From Photos' } } }, 'photo'), '');
  assert.equal(printedCaption(files('Own'), 'photo'), 'Own');
  assert.equal(printedCaption(files(), 'missing'), '');
  assert.equal(captionPhoto(files().project, at), 'photo');
  assert.equal(captionPhoto(files().project, { ...at, layout: 'always' }), undefined, 'another layout is another box');
});

test('a finished caption saves to the photo as Edit Caption… does, and never over newer text', () => {
  const first = files();
  assert.equal(saveInlineCaption(first, first, at, parameters, 'photo', '', 'At the pass'), true);
  assert.equal(first.photoIndex.photo.caption, 'At the pass');
  assert.equal(first.project.spreads[0].boxes.hero.params.showCaption, true, 'the first caption switches Show caption on (UI-014)');
  const off = files('Before', { showCaption: false });
  assert.equal(saveInlineCaption(off, off, at, parameters, 'photo', 'Before', 'After'), true);
  assert.equal(off.project.spreads[0].boxes.hero.params.showCaption, false, 'a switch the user turned off stays off');
  const changed = files('Newer');
  assert.equal(saveInlineCaption(changed, changed, at, parameters, 'photo', 'Older', 'Typed'), false);
  assert.equal(changed.photoIndex.photo.caption, 'Newer');
  const replaced = files();
  replaced.project.spreads[0].boxes.hero.photo = 'other';
  assert.equal(saveInlineCaption(replaced, replaced, at, parameters, 'photo', '', 'Typed'), false, 'the box shows another photo by now');
  const relaid = files();
  relaid.project.spreads[0].definition = 'always';
  assert.equal(saveInlineCaption(relaid, relaid, at, parameters, 'photo', '', 'Typed'), false, 'the spread shows another layout by now');
  const provided = files();
  assert.equal(saveInlineCaption(provided, { ...provided, photoProvided: { photo: { caption: 'From Photos' } } }, at, parameters, 'photo', 'From Photos', 'Mine'), true);
  assert.equal(provided.photoIndex.photo.caption, 'Mine');
  assert.equal(provided.project.spreads[0].boxes.hero.params.showCaption, undefined, 'a provider’s caption was a caption already');
});

test('the hint says where else the photo, and so its caption, is placed', () => {
  const usage = (...places: { spread: string; pages: string; cover?: true }[]) => ({ photo: { photo: places }, text: {} });
  assert.equal(captionElsewhere(usage({ spread: 's', pages: '4–5' }), 'photo', 's'), undefined);
  assert.equal(captionElsewhere(usage({ spread: 's', pages: '4–5' }, { spread: 't', pages: '12' }), 'photo', 's'), 'Also on p. 12');
  assert.equal(captionElsewhere(usage({ spread: 't', pages: '6–7' }, { spread: 'u', pages: '12' }, { spread: 'cover', pages: 'Cover', cover: true }), 'photo', 's'),
    'Also on pp. 6–7, p. 12 and the cover');
  assert.equal(captionElsewhere(usage(...['2', '3', '4', '5', '6'].map((pages) => ({ spread: pages, pages }))), 'photo', 's'),
    'Also on p. 2, p. 3, p. 4 and 2 more places');
  assert.equal(captionElsewhere({ photo: {}, text: {} }, 'photo', 's'), undefined);
});
