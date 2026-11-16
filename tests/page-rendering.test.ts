import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { mm, pageSequence, printFormat, resolveFormat, spanAllowedAt } from '../src/format';
import { boundGeometry } from '../src/geometry';
import { firstSpreadLayouts, readEdit, resolveEditPath, writeEdit } from '../src/editing';
import { changedValues, editingContext, queuedEditorSave } from '../src/editor-session';
import { saveInlineText } from '../src/inline-text';
import { insertionProblem, spreadOrder } from '../src/spread-order';
import { familyProblems, layoutChoices, layoutFootprint } from '../src/layouts';
import { projectSchema, scopeSpread } from '../src/project';
import type { RenderProject, SpreadState } from '../src/project';
import { p } from '../src/parameters';
import { bookIndex, chooseFormat, normalizeTemplate, Page, Spread, SpreadView, templateInfo, templateSchema } from '../src/template';
import type { RenderContext } from '../src/template';
import { textAssignments } from '../src/text-assignments';
import { applyProjectCommands } from '../src/project-commands';

const format = printFormat({ label: 'Book', trim: { width: mm(200), height: mm(240) },
  bleed: { all: mm(3), binding: mm(0) }, safe: { all: mm(10), binding: mm(18) },
  pageCount: { min: 2, max: 100, step: 2 }, ends: 'inside-covers' });
const state = (definition: string, heading: string) => ({ definition, params: { heading },
  boxes: { story: { text: 'story', params: {} } }, elements: { grid: { params: { size: 1 } } } });
const split: SpreadState = { id: 's', definition: 'full', split: true, params: {}, boxes: {}, elements: {},
  pages: { left: state('page', 'Left'), right: state('page', 'Right') } };
const template = chooseFormat(templateSchema.parse(normalizeTemplate({ id: 'pages', version: '1', contract: 1, format,
  spreads: ({ spread, page }: { spread: <T>(x: T) => T; page: <T>(x: T) => T }) => ({
    full: spread({ label: 'Full', render: () => createElement(Spread) }),
    page: page({ label: 'Page', parameters: { heading: p.string({ label: 'Heading', default: '' }) },
      boxes: { story: { type: 'markdown', label: 'Story' } },
      elements: { grid: { label: 'Grid', parameters: { size: p.integer({ label: 'Size', default: 1 }) },
        editor: { parameters: ['size'], spread: ['heading'], component: () => null } } },
      render: (ctx: RenderContext) => createElement(Page, { className: ctx.side },
        createElement(ctx.Text, { parameter: 'heading', rect: ctx.geometry.page('safe') }),
        createElement(ctx.MarkdownBox, { id: 'story', rect: ctx.geometry.page() }),
        createElement(ctx.Element, { id: 'grid' }, JSON.stringify(ctx.page))) }),
  }) })));
const book = (spread: SpreadState = split): RenderProject => ({
  project: projectSchema.parse({ schemaVersion: 2, title: 'Pages', template: { id: 'pages', version: '1' },
    texts: { story: 'texts/story.md' }, spreads: [structuredClone(spread)] }),
  mode: 'edit', problems: [], template: { script: '', assets: {} }, photos: {}, texts: { story: 'Story' }, files: {},
});
const markup = (input: RenderProject) => {
  const sequence = pageSequence(input.project.spreads.map((spread) => layoutFootprint(spread, template.spreads)), format);
  return renderToStaticMarkup(createElement(SpreadView, { book: input, template, format: resolveFormat(format),
    spread: input.project.spreads[0], page: sequence.spreads[0].page, index: bookIndex(input, template, sequence),
    positions: textAssignments(input, template).positions, renderPhotos: false }));
};

test('page geometry is local to its trim and mirrors outside and binding safe insets', () => {
  const left = boundGeometry(resolveFormat(format), { side: 'left' });
  const right = boundGeometry(resolveFormat(format), { side: 'right' });
  assert.deepEqual(left.page(), { x: 0, y: 0, width: 200, height: 240 });
  assert.deepEqual(right.page(), left.page());
  assert.equal(left.page('safe').x, 10);
  assert.equal(right.page('safe').x, 18);
  assert.deepEqual(left.page('bleed'), { x: -3, y: -3, width: 203, height: 246 });
  assert.deepEqual(right.page('bleed'), { x: 0, y: -3, width: 203, height: 246 });
  assert.deepEqual(right.design({ width: 100, height: 120 }).page(5, 10, 20, 30), { x: 10, y: 20, width: 40, height: 60 });
  assert.throws(() => right.page('left'), /facing page/);
  assert.throws(() => right.spread(), /no spread geometry/);
});

test('two page layouts render one sheet with independent state, side and page numbers', () => {
  const html = markup(book());
  assert.equal((html.match(/class="if-sheet"/g) ?? []).length, 1);
  assert.equal((html.match(/data-box="story"/g) ?? []).length, 2);
  assert.match(html, /data-if-page="left"/);
  assert.match(html, /data-if-page="right"/);
  assert.match(html, /data-side="left"/);
  assert.match(html, /data-side="right"/);
  assert.match(html, />Left<\/p>/);
  assert.match(html, />Right<\/p>/);
  assert.match(html, /\{&quot;left&quot;:1\}/);
  assert.match(html, /\{&quot;right&quot;:2\}/);
  assert.doesNotMatch(html, /\{&quot;left&quot;:1,&quot;right&quot;/);
  const blank = structuredClone(split);
  delete blank.pages!.right;
  assert.equal((markup(book(blank)).match(/data-box="story"/g) ?? []).length, 1);
});

test('text flow keys identical box IDs by page and orders the left page first', () => {
  const { chains, positions } = textAssignments(book(), template);
  assert.deepEqual(chains.get('story')?.map(({ spread, page, box }) => [spread, page, box]), [['s', 'left', 'story'], ['s', 'right', 'story']]);
  assert.equal(positions['s:left:story'].part, 1);
  assert.equal(positions['s:right:story'].part, 2);
  assert.equal(positions['s:right:story'].parts, 2);
});

test('page layouts occupy ordinary opening and closing units with side restrictions', () => {
  const ends = { ...format, structure: { ...format.structure, ends: 'single-pages' as const } };
  const sequence = pageSequence([{ span: 'page', sides: ['right'] }, 'spread', { span: 'page', sides: ['left'] }], ends);
  assert.deepEqual(sequence.issues, []);
  assert.deepEqual(sequence.spreads.map(({ page }) => page), [{ left: undefined, right: 1 }, { left: 2, right: 3 }, { left: 4, right: undefined }]);
  assert.equal(spanAllowedAt('page', 0, 3, ends, ['left']), false);
  assert.equal(spanAllowedAt('page', 1, 3, ends), false);
  const layouts = { ...template.spreads, right: { ...template.spreads.page, sides: ['right' as const] }, left: { ...template.spreads.page, sides: ['left' as const] } };
  const info = { ...templateInfo(template), spreads: layouts, format: ends };
  assert.deepEqual(firstSpreadLayouts(layouts, ends), ['page', 'right']);
  assert.ok(layoutChoices(layouts, 'full', ends, { index: 0, count: 3 }).includes('right'));
  assert.ok(!layoutChoices(layouts, 'full', ends, { index: 0, count: 3 }).includes('left'));
  assert.equal(insertionProblem([], 0, 'page', info, ['right']), undefined);
  assert.ok(insertionProblem([], 0, 'page', info, ['left']));
  const units = ['right', 'full', 'left'].map((definition, i) => ({ ...structuredClone(split), split: undefined, pages: undefined, id: 's' + i, definition }));
  assert.equal(spreadOrder(units, 's0', 1, info), undefined);
  assert.ok(familyProblems({ a: { ...layouts.left, family: 'f' }, b: { ...layouts.right, family: 'f' } }, { f: { label: 'Family' } }).length);
});

test('page text saves and element editor saves change only the selected state and reject stale drafts', () => {
  const project = book().project;
  const before = structuredClone(project.spreads[0]);
  const info = templateInfo(template);
  const field = resolveEditPath(info, 'page', 'heading', 'right')!;
  assert.equal(readEdit(project, project.spreads[0], field), 'Right');
  assert.equal(saveInlineText(project, info, 's', 'page', field, 'Right', 'Edited'), false, 'custom editor owns heading');
  const textInfo = structuredClone(info);
  delete textInfo.spreads.page.elements.grid.editor!.spread;
  assert.equal(saveInlineText(project, textInfo, 's', 'page', field, 'Right', 'Edited'), true);
  assert.equal(saveInlineText(project, info, 's', 'page', field, 'Right', 'Stale'), false);
  writeEdit(project, 's', field, 'Updated');
  const target = { kind: 'element' as const, spread: 's', element: 'grid', page: 'right' as const };
  const state = { spread: project.spreads[0], params: project.params };
  const context = editingContext(info, state, target);
  const draft = { values: { size: 2 }, spread: { heading: 'Custom' } };
  assert.deepEqual(changedValues(info, state, target, draft), draft);
  assert.equal(queuedEditorSave(info, project, target, context, draft), true);
  assert.equal(queuedEditorSave(info, project, target, context, draft), false);
  assert.equal(scopeSpread(project.spreads[0], 'right')?.params.heading, 'Custom');
  assert.deepEqual(project.spreads[0].pages?.left, before.pages?.left);
  assert.deepEqual(project.spreads[0].params, before.params);
  delete project.spreads[0].split;
  assert.equal(queuedEditorSave(info, project, target, editingContext(info, state, target), draft), false, 'a merged page is no longer an editor target');
  assert.equal(saveInlineText(project, textInfo, 's', 'page', field, 'Custom', 'Hidden edit'), false);
});


test('a split sheet draws its pages even if its remembered spread layout was removed', () => {
  const spread = structuredClone(split);
  spread.definition = 'removed';
  assert.equal(layoutFootprint(spread, template.spreads).span, 'spread');
  assert.match(markup(book(spread)), />Right<\/p>/);
});

test('shown pages, rather than the hidden spread layout, supply the book index', () => {
  const input = book();
  const sequence = pageSequence(['spread'], format);
  const index = bookIndex(input, template, sequence);
  assert.equal(index.spreads?.[0].layout, undefined);
  assert.deepEqual(index.spreads?.[0].photos, []);
  assert.equal(index.spreads?.[0].pages?.left?.layout, 'page');
  assert.equal(index.spreads?.[0].pages?.right?.layout, 'page');
});


test('choosing the remembered page layout merges a split unit after switching to a non-facing format', () => {
  const spread = structuredClone(split);
  spread.definition = 'page';
  const single = printFormat({ label: 'Single', trim: { width: mm(200), height: mm(240) }, facingPages: false,
    bleed: mm(3), safe: mm(10), pageCount: { min: 1, max: 100, step: 1 } });
  const info = { ...templateInfo(template), format: single };
  const result = applyProjectCommands({ project: book(spread).project, photoIndex: {} }, info,
    [{ op: 'switch_layout', spread: 's', definition: 'page' }]);
  const merged = result.files.project.spreads[0];
  assert.equal(merged.split, undefined);
  assert.equal(merged.params.heading, 'Left');
  assert.equal(merged.pages?.right?.params.heading, 'Right');
});
