import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mm, resolveFormat } from '../src/format';
import type { PrintFormat } from '../src/format';
import { geometry } from '../src/geometry';
import { capabilities, runtimeExports } from '../src/runtime-exports';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { projectSchema } from '../src/project';
import type { RenderProject } from '../src/project';
import { box, chooseFormat, issue, runtime, SpreadView, templateIssueSchema, templateSchema } from '../src/template';
import type { RenderContext } from '../src/template';

// Asymmetric insets and a binding bleed, so a helper that mirrors or ignores them fails.
const format = resolveFormat({
  label: 'Asymmetric', trim: { width: mm(200), height: mm(150) },
  bleed: { top: mm(3), bottom: mm(5), outside: mm(4), binding: mm(2) },
  safe: { top: mm(10), bottom: mm(12), outside: mm(8), binding: mm(15) },
  structure: { delivery: 'pages', ends: 'single-pages', pageCount: { min: 2, max: 20, step: 2 } },
  output: { container: 'pdf', colorSpace: 'sRGB', transparency: 'allow' },
} as PrintFormat);

test('page and spread areas follow trim, asymmetric safe insets and outer bleed', () => {
  assert.deepEqual(geometry.page(format, 'left'), { x: 0, y: 0, width: 200, height: 150 });
  assert.deepEqual(geometry.page(format, 'right'), { x: 200, y: 0, width: 200, height: 150 });
  // Safe insets mirror: outside on the left page's left edge, binding next to the fold.
  assert.deepEqual(geometry.page(format, 'left', 'safe'), { x: 8, y: 10, width: 177, height: 128 });
  assert.deepEqual(geometry.page(format, 'right', 'safe'), { x: 215, y: 10, width: 177, height: 128 });
  // Bleed extends the outer edges only; the binding bleed shows the facing page.
  assert.deepEqual(geometry.page(format, 'left', 'bleed'), { x: -4, y: -3, width: 204, height: 158 });
  assert.deepEqual(geometry.page(format, 'right', 'bleed'), { x: 200, y: -3, width: 204, height: 158 });
  assert.deepEqual(geometry.spread(format), { x: 0, y: 0, width: 400, height: 150 });
  assert.deepEqual(geometry.spread(format, 'safe'), { x: 8, y: 10, width: 384, height: 128 });
  assert.deepEqual(geometry.spread(format, 'bleed'), { x: -4, y: -3, width: 408, height: 158 });
  assert.equal(geometry.spread(format, 'bleed').width, format.spreadWidth);
});

test('insets, grids and design coordinates are explicit millimetre arithmetic', () => {
  const area = { x: 10, y: 20, width: 100, height: 60 };
  assert.deepEqual(geometry.inset(area, 5), { x: 15, y: 25, width: 90, height: 50 });
  assert.deepEqual(geometry.inset(area, { left: 10, bottom: 20 }), { x: 20, y: 20, width: 90, height: 40 });
  const cells = geometry.grid(area, { columns: 3, rows: 2, columnGap: 5, rowGap: 10 });
  assert.equal(cells.length, 6);
  assert.deepEqual(cells[0], { x: 10, y: 20, width: 30, height: 25 });
  assert.deepEqual(cells[4], { x: 45, y: 55, width: 30, height: 25 });
  assert.deepEqual(geometry.grid(area, { columns: 2, gap: 10 }).map(({ x, width, height }) => [x, width, height]), [[10, 45, 60], [65, 45, 60]]);
  // A 100 × 100 design canvas on a 200 × 150 trim: x scales by 2, y by 1.5; the right page starts at the trim width.
  const design = geometry.design(format, { width: 100, height: 100 });
  assert.deepEqual(design.left(10, 10, 50, 20), { x: 20, y: 15, width: 100, height: 30 });
  assert.deepEqual(design.right(10, 10, 50, 20), { x: 220, y: 15, width: 100, height: 30 });
  assert.equal(design.width(5), 10);
  assert.equal(design.height(4), 6);
  assert.equal(design.scaleX, 2);
  assert.equal(design.scaleY, 1.5);
  assert.equal(design.length(10, 'pt', 'x'), '20.00pt');
  assert.equal(design.length(10, 'mm', 'y'), '15.00mm');
  assert.equal(design.length(10, 'pt', 'min'), '15.00pt');
  assert.equal(design.length(10, 'px', 'max'), '20.00px');
  assert.throws(() => geometry.design(format, { width: 0, height: 100 }), /positive finite/);
  assert.deepEqual(geometry.css({ x: -4, y: 2.5, width: 10, height: 20 }), { position: 'absolute', left: '-4mm', top: '2.5mm', width: '10mm', height: '20mm' });
});

test('box helpers keep IDs at the declaration and issue() encodes a structured finding', () => {
  assert.deepEqual(box.photo('Hero'), { type: 'photo', label: 'Hero', parameters: {} });
  assert.deepEqual(box.markdown('Story', { flowOrder: 2 }), { type: 'markdown', label: 'Story', parameters: {}, flowOrder: 2 });
  const attributes = issue({ code: 'gpx-invalid', message: 'Bad track.', element: 'route', parameter: 'track', file: 'fl-1', details: { line: 3 } });
  assert.equal(attributes['data-issue'], 'Bad track.');
  assert.deepEqual(templateIssueSchema.parse(JSON.parse(attributes['data-issue-info'])),
    { code: 'gpx-invalid', message: 'Bad track.', severity: 'warning', element: 'route', parameter: 'track', file: 'fl-1', details: { line: 3 } });
  assert.equal(templateIssueSchema.safeParse({ code: 'Not A Code', message: 'x' }).success, false);
});

test('the runtime exports exactly the listed helpers and checks a template\'s required capabilities', () => {
  assert.deepEqual(Object.keys(runtime).sort(), [...runtimeExports].sort());
  const template = (requires?: string[]) => ({
    id: 'needs', version: '1', contract: 1, ...(requires ? { requires } : {}), parameters: {},
    format: { label: 'F', trim: { width: mm(100), height: mm(100) },
      bleed: { top: mm(0), bottom: mm(0), outside: mm(0), binding: mm(0) }, safe: { top: mm(5), bottom: mm(5), outside: mm(5), binding: mm(5) },
      structure: { delivery: 'pages', ends: 'inside-covers', pageCount: { min: 2, max: 20, step: 2 } },
      output: { container: 'pdf', colorSpace: 'sRGB', transparency: 'allow' } },
    spreads: { main: { label: 'Main', render: () => null } },
  });
  assert.ok(templateSchema.safeParse(template()).success);
  assert.ok(templateSchema.safeParse(template([...capabilities])).success);
  const missing = templateSchema.safeParse(template(['anchors', 'teleport', 'time-travel']));
  assert.equal(missing.success, false);
  assert.match(missing.error!.issues[0].message, /does not provide: teleport, time-travel\. Update ImageFlow/);
});

test('platform components forward issue() markers to their own node', () => {
  const found = (code: string) => issue({ code, message: 'Problem ' + code + '.', severity: 'error' });
  const render = (ctx: RenderContext) => createElement(runtime.Spread, found('on-spread'),
    createElement(ctx.PhotoBox, { id: 'hero', ...found('on-photo') }),
    createElement(ctx.MarkdownBox, { id: 'story', ...found('on-markdown') }),
    createElement(ctx.Element, { id: 'note', ...found('on-element') }, 'Note'));
  const template = chooseFormat(templateSchema.parse({
    id: 'issues', version: '1', contract: 1, parameters: {},
    format: { label: 'F', trim: { width: mm(100), height: mm(100) },
      bleed: { top: mm(0), bottom: mm(0), outside: mm(0), binding: mm(0) }, safe: { top: mm(5), bottom: mm(5), outside: mm(5), binding: mm(5) },
      structure: { delivery: 'pages', ends: 'inside-covers', pageCount: { min: 2, max: 20, step: 2 } },
      output: { container: 'pdf', colorSpace: 'sRGB', transparency: 'allow' } },
    spreads: { main: { label: 'Main', boxes: { hero: box.photo('Hero'), story: box.markdown('Story') }, elements: { note: { label: 'Note' } }, render } },
  }));
  const project = projectSchema.parse({ schemaVersion: 1, title: 'Issues', template: { id: 'issues', version: '1' }, spreads: [{ id: 'one', definition: 'main' }] });
  const book = { project, photos: {}, texts: {}, files: {}, problems: [], mode: 'export', template: { script: '', assets: {} } } as RenderProject;
  const html = renderToStaticMarkup(createElement(SpreadView, { book, template, format: resolveFormat(template.format), spread: project.spreads[0],
    page: { left: 1, right: 2 }, index: { pages: 2, anchors: [] }, positions: {}, renderPhotos: false }));
  // Each finding sits on the node the component renders, where the Book check finds it and its owner.
  const marked = [...html.matchAll(/<div ([^>]*data-issue-info="[^"]*"[^>]*)>/g)].map(([, attributes]) => [
    attributes.match(/data-box="(\w+)"|data-element="(\w+)"|class="(if-spread)"/)!.slice(1).find(Boolean),
    attributes.match(/&quot;code&quot;:&quot;([a-z-]+)&quot;/)![1],
  ]);
  assert.deepEqual(marked, [['if-spread', 'on-spread'], ['hero', 'on-photo'], ['story', 'on-markdown'], ['note', 'on-element']]);
});

test('Text inherits display-only fallback for empty values, with explicit hiding and editor hints', () => {
  const source = { id: 'text', version: '1', contract: 1, parameters: {},
    format: { label: 'F', trim: { width: mm(100), height: mm(100) },
      bleed: { top: mm(0), bottom: mm(0), outside: mm(0), binding: mm(0) }, safe: { top: mm(5), bottom: mm(5), outside: mm(5), binding: mm(5) },
      structure: { delivery: 'pages', ends: 'inside-covers', pageCount: { min: 2, max: 20, step: 2 } },
      output: { container: 'pdf', colorSpace: 'sRGB', transparency: 'allow' } } };
  const render = (value: string, mode: 'edit' | 'export', hidden = false, fallback = '<Photo caption>') => {
    const template = chooseFormat(templateSchema.parse({ ...source, spreads: { main: { label: 'Main',
      parameters: { place: { type: 'string', label: 'Place', default: '' } }, render: (ctx: RenderContext) =>
        createElement(runtime.Spread, {}, createElement(ctx.Text, { parameter: 'place', fallback, fallbackLabel: 'photo caption', hidden })) } } }));
    const project = projectSchema.parse({ schemaVersion: 1, title: 'Text', template: { id: 'text', version: '1' },
      spreads: [{ id: 'one', definition: 'main', params: { place: value } }] });
    const book = { project, photos: {}, texts: {}, files: {}, problems: [], mode, template: { script: '', assets: {} } } as RenderProject;
    const html = renderToStaticMarkup(createElement(SpreadView, { book, template, format: resolveFormat(template.format), spread: project.spreads[0],
      page: { left: 1, right: 2 }, index: { pages: 2, anchors: [] }, positions: {}, renderPhotos: false }));
    assert.equal(project.spreads[0].params.place, value);
    return html;
  };
  assert.match(render('', 'edit'), /class="if-text-inherited" title="Using photo caption">&lt;Photo caption&gt;/);
  assert.match(render(' \n ', 'export'), />&lt;Photo caption&gt;<\/p>/);
  assert.doesNotMatch(render('', 'export'), /if-text-inherited/);
  assert.match(render('Custom', 'export'), />Custom<\/p>/);
  assert.doesNotMatch(render('', 'edit', true), /data-edit="place"/);
  assert.match(render(' ', 'edit', false, ''), /if-text-placeholder/);
});

test('inline Text validates its opt-in and string binding and renders pure multiline artwork', () => {
  const render = ({ requires = ['inline-text'], type = 'string', editing = 'inline', mode = 'edit', value = 'First\nSecond' }:
    { requires?: string[]; type?: string; editing?: string; mode?: 'edit' | 'export'; value?: string } = {}) => {
    const template = chooseFormat(templateSchema.parse({ id: 'text', version: '1', contract: 1, requires,
      format: { label: 'F', trim: { width: mm(100), height: mm(100) },
        bleed: { top: mm(0), bottom: mm(0), outside: mm(0), binding: mm(0) }, safe: { top: mm(5), bottom: mm(5), outside: mm(5), binding: mm(5) },
        structure: { delivery: 'pages', ends: 'inside-covers', pageCount: { min: 2, max: 20, step: 2 } },
        output: { container: 'pdf', colorSpace: 'sRGB', transparency: 'allow' } },
      spreads: { main: { label: 'Main', parameters: { heading: type === 'string' ? { type, label: 'Heading', default: '', multiline: true }
        : { type: 'number', label: 'Number', default: 1 } }, render: (ctx: RenderContext) =>
        createElement(runtime.Spread, {}, createElement(ctx.Text, { parameter: 'heading', editing: editing as 'inline' })) } } }));
    const project = projectSchema.parse({ schemaVersion: 1, title: 'Text', template: { id: 'text', version: '1' },
      spreads: [{ id: 'one', definition: 'main', params: { heading: value } }] });
    const book = { project, photos: {}, texts: {}, files: {}, problems: [], mode, template: { script: '', assets: {} } } as RenderProject;
    return renderToStaticMarkup(createElement(SpreadView, { book, template, format: resolveFormat(template.format), spread: project.spreads[0],
      page: { left: 1, right: 2 }, index: { pages: 2, anchors: [] }, positions: {}, renderPhotos: false }));
  };
  assert.throws(() => render({ requires: [] }), /requires.*inline-text/);
  assert.throws(() => render({ type: 'number' }), /string parameter/);
  assert.throws(() => render({ editing: 'panel' }), /editing must be inline/);
  assert.match(render(), /white-space:pre-wrap/);
  assert.match(render({ value: '' }), /if-text-placeholder/);
  const artwork = render({ mode: 'export' });
  assert.match(artwork, />First\nSecond<\/p>/);
  assert.doesNotMatch(artwork, /contenteditable|data-text-editor|iframe|textbox/);
  assert.doesNotMatch(render({ value: '', mode: 'export' }), /if-text-placeholder/);
});
