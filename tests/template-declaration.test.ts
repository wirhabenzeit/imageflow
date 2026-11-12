import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { closest, declarationWarnings as check } from '../src/declaration-check';
import type { Schema } from '../src/declaration-check';
import { mm, printFormat, pt, resolveFormat } from '../src/format';
import { geometry } from '../src/geometry';
import { p } from '../src/parameters';
import { projectSchema } from '../src/project';
import type { RenderProject } from '../src/project';
import { box, chooseFormat, defineTemplate, normalizeTemplate, runtime, spreadFor, SpreadView, templateSchema } from '../src/template';
import type { RenderContext } from '../src/template';

const declarationWarnings = (declared: unknown) => check(declared, templateSchema as unknown as Schema);

const format = printFormat({
  label: 'Square', trim: { width: mm(200), height: mm(200) }, bleed: { all: mm(3), binding: mm(0) }, safe: mm(12),
  pageCount: { min: 2, max: 20, step: 2 }, ends: 'inside-covers',
});

test('printFormat expands inset shorthands into an ordinary, complete PrintFormat', () => {
  assert.deepEqual(format, {
    label: 'Square', trim: { width: mm(200), height: mm(200) },
    bleed: { top: mm(3), bottom: mm(3), outside: mm(3), binding: mm(0) },
    safe: { top: mm(12), bottom: mm(12), outside: mm(12), binding: mm(12) },
    structure: { delivery: 'pages', ends: 'inside-covers', pageCount: { min: 2, max: 20, step: 2 } },
    output: { container: 'pdf', colorSpace: 'sRGB', transparency: 'allow' },
  });
  const explicit = { top: mm(1), bottom: mm(2), outside: mm(3), binding: mm(4) };
  const custom = printFormat({ label: 'C', trim: { width: mm(100), height: mm(100) }, bleed: explicit, safe: explicit,
    pageCount: { min: 4, max: 40, step: 4 }, output: { transparency: 'forbid', minimumTextSize: pt(6) } });
  assert.deepEqual(custom.bleed, explicit);
  assert.deepEqual(custom.output, { container: 'pdf', colorSpace: 'sRGB', transparency: 'forbid', minimumTextSize: pt(6) });
  assert.equal(custom.structure.ends, 'single-pages');
});

test('box.photos declares explicitly named photo boxes', () => {
  assert.deepEqual(box.photos(['one', 'two'], (id, i) => 'Photo ' + (i + 1) + ' ' + id), {
    one: { type: 'photo', label: 'Photo 1 one', parameters: {} }, two: { type: 'photo', label: 'Photo 2 two', parameters: {} },
  });
});

test('spreads declared as a builder function normalize to the record ImageFlow validates', () => {
  const render = () => null;
  const declared = defineTemplate({ id: 't', version: '1', contract: 1, format, spreads: ({ spread }) => ({ main: spread({ label: 'Main', render }) }) });
  assert.deepEqual(declared, { id: 't', version: '1', contract: 1, format, spreads: { main: { label: 'Main', render } } });
  // A template exported without defineTemplate is normalized when it loads.
  const raw = { id: 't', version: '1', contract: 1, format, spreads: ({ spread }: { spread: <T>(value: T) => T }) => ({ main: spread({ label: 'Main', render }) }) };
  assert.ok(templateSchema.safeParse(normalizeTemplate(raw)).success);
  assert.equal(normalizeTemplate(declared), declared);
});

test('unknown declaration properties are reported with the property they probably meant', () => {
  assert.equal(closest('paramters', ['parameters', 'spreads']), 'parameters');
  assert.equal(closest('Label', ['label']), 'label');
  assert.equal(closest('colour', ['label', 'default']), undefined);
  const warnings = declarationWarnings({
    id: 't', version: '1', contract: 1, paramters: {}, format: { ...format, trim: { ...format.trim, widht: mm(1) } },
    spreads: {
      main: {
        label: 'Main', render: () => null, boxs: {},
        parameters: { heading: { type: 'string', label: 'H', default: '', mutliline: true, maxLength: 9 }, size: { type: 'number', label: 'S', default: 1, maxLength: 3 } },
        elements: { map: { label: 'Map', editor: { parameters: [], component: () => null, presentaton: 'dialog' } } },
      },
    },
  });
  assert.deepEqual(warnings.map(({ path, details }) => [path, details.didYouMean]), [
    ['paramters', 'parameters'], ['format.trim.widht', 'width'],
    ['spreads.main.boxs', 'boxes'], ['spreads.main.parameters.heading.mutliline', 'multiline'], ['spreads.main.parameters.size.maxLength', undefined],
    ['spreads.main.elements.map.editor.presentaton', 'presentation'],
  ]);
  assert.ok(warnings.every(({ code }) => code === 'declaration-unknown-property'));
  assert.match(warnings[0].message, /^Template: ImageFlow does not know property paramters and ignores it\.$/);
  assert.equal(warnings[0].suggestion, 'Rename paramters to parameters.');
  // Known keys come from the schema, per parameter type.
  assert.match(warnings[4].suggestion, /Known here: label, min, max, step, unit, type, default\./);
  // A valid declaration has no findings, whatever extra data render functions close over.
  assert.deepEqual(declarationWarnings(defineTemplate({ id: 't', version: '1', contract: 1, formats: { a: format }, defaultFormat: 'a',
    parameters: { accent: p.color({ label: 'A', default: '#000000' }) }, spreads: { main: { label: 'Main', render: () => null } } })), []);
});

test('spreads typed with spreadFor() must match the template\'s document parameters', () => {
  const accent = p.color({ label: 'Accent', default: '#000000' });
  const typed = spreadFor({ accent, paper: p.enum({ label: 'Paper', default: 'warm', options: ['warm', 'white'] }) });
  const warnings = declarationWarnings({
    id: 't', version: '1', contract: 1, format,
    parameters: { accent, paper: p.enum({ label: 'Paper', default: 'white', options: ['warm', 'white'] }) },
    spreads: { main: typed({ label: 'Main', render: () => null }) },
  });
  assert.deepEqual(warnings.map(({ code, details }) => [code, details.parameter]), [['declaration-document-mismatch', 'paper']]);
  const missing = declarationWarnings({ id: 't', version: '1', contract: 1, format, spreads: { main: typed({ label: 'Main', render: () => null }) } });
  assert.deepEqual(missing.map(({ details }) => details.parameter), ['accent', 'paper']);
  assert.match(missing[0].message, /ctx\.document\.accent is undefined/);
  // The same object passed to both is never reported.
  const document = { accent };
  assert.deepEqual(declarationWarnings({ id: 't', version: '1', contract: 1, format, parameters: document,
    spreads: { main: spreadFor(document)({ label: 'Main', render: () => null }) } }), []);
});

function renderSpread(render: (ctx: RenderContext) => unknown, mode: 'edit' | 'export', params: Record<string, string> = {}) {
  const template = chooseFormat(templateSchema.parse(defineTemplate({
    id: 'text', version: '1', contract: 1, format,
    parameters: { title: p.string({ label: 'Book title', default: 'Atlas' }) },
    spreads: ({ spread }) => ({ main: spread({
      label: 'Main', parameters: { heading: p.string({ label: 'Heading', default: '', placeholder: 'Add a heading' }), note: p.string({ label: 'Note', default: '' }) },
      boxes: { hero: box.photo('Hero', { credit: p.string({ label: 'Credit', default: 'Me' }) }), story: box.markdown('Story') },
      elements: { note: { label: 'Note' } },
      render: render as never,
    }) }),
  })));
  const project = projectSchema.parse({ schemaVersion: 1, title: 'Text', template: { id: 'text', version: '1' }, spreads: [{ id: 'one', definition: 'main', params }] });
  const book = { project, photos: {}, texts: {}, files: {}, problems: [], mode, template: { script: '', assets: {} } } as RenderProject;
  const resolved = resolveFormat(template.format);
  return renderToStaticMarkup(createElement(SpreadView, { book, template, format: resolved, spread: project.spreads[0],
    page: { left: 1, right: 2 }, index: { pages: 2, anchors: [] }, positions: {}, renderPhotos: false }));
}

test('rect places platform components; style wins over it', () => {
  const html = renderSpread((ctx) => createElement(runtime.Spread, null,
    createElement(ctx.PhotoBox, { id: 'hero', rect: ctx.geometry.page('left', 'bleed') }),
    createElement(ctx.MarkdownBox, { id: 'story', rect: { x: 10, y: 20, width: 30, height: 40 }, style: { height: 'auto', fontSize: '9pt' } }),
    createElement(ctx.Element, { id: 'note', rect: ctx.geometry.inset(ctx.geometry.page('right', 'safe'), 5) })), 'export');
  assert.match(html, /data-box="hero"[^>]*style="position:absolute;left:-3mm;top:-3mm;width:203mm;height:206mm"/);
  assert.match(html, /data-box="story"[^>]*style="position:absolute;left:10mm;top:20mm;width:30mm;height:auto;font-size:9pt"/);
  assert.match(html, /data-element="note"[^>]*style="position:absolute;left:217mm;top:17mm;width:166mm;height:166mm"/);
});

test('ctx.geometry applies the spread format to the geometry helpers', () => {
  let bound: RenderContext['geometry'] | undefined;
  renderSpread((ctx) => { bound = ctx.geometry; return null; }, 'export');
  const resolved = resolveFormat(format);
  assert.deepEqual(bound!.page('right', 'safe'), geometry.page(resolved, 'right', 'safe'));
  assert.deepEqual(bound!.spread('bleed'), geometry.spread(resolved, 'bleed'));
  assert.deepEqual(bound!.design({ width: 100, height: 100 }).left(10, 10, 50, 50), geometry.design(resolved, { width: 100, height: 100 }).left(10, 10, 50, 50));
});

test('ctx.Text shows a string parameter, marks it for editing and shows a placeholder only in the editor', () => {
  const layout = (ctx: RenderContext) => createElement(runtime.Spread, null,
    createElement(ctx.Text, { parameter: 'heading', as: 'h1', rect: { x: 0, y: 0, width: 10, height: 10 }, className: 'title' }),
    createElement(ctx.Text, { parameter: 'note', placeholder: 'Write a note' }),
    createElement(ctx.Text, { parameter: 'document.title', as: 'span' }),
    createElement(ctx.Text, { parameter: 'boxes.hero.credit', as: 'figcaption' }));
  const edit = renderSpread(layout, 'edit');
  assert.match(edit, /<h1 data-edit="heading" data-empty="" class="title" style="position:absolute;left:0mm;top:0mm;width:10mm;height:10mm"><span class="if-text-placeholder">Add a heading<\/span><\/h1>/);
  assert.match(edit, /<p data-edit="note" data-empty=""><span class="if-text-placeholder">Write a note<\/span><\/p>/);
  assert.match(edit, /<span data-edit="document.title">Atlas<\/span>/);
  assert.match(edit, /<figcaption data-edit="boxes.hero.credit">Me<\/figcaption>/);
  const exported = renderSpread(layout, 'export', { heading: 'North <cape>' });
  assert.match(exported, /<h1 data-edit="heading" class="title" style="[^"]*">North &lt;cape&gt;<\/h1>/);
  assert.match(exported, /<p data-edit="note"><\/p>/);
  assert.throws(() => renderSpread((ctx) => createElement(ctx.Text, { parameter: 'missing' }), 'export'), /does not declare/);
});
