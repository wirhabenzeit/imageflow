import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mm } from '../src/format';
import { editorChanges } from '../src/editor-changes';
import { changedValues, documentEditorFor, editingContext, editorOwnedDocument, editorState, editorTargetGone, queuedEditorSave } from '../src/editor-session';
import type { EditorTarget } from '../src/editor-session';
import { p } from '../src/parameters';
import { projectSchema } from '../src/project';
import type { Project, RenderProject } from '../src/project';
import { chooseFormat, editorContext, templateInfo, templateSchema } from '../src/template';

// A calendar-like template: month pages declare an anchor, and a document editor owns the marked dates.
const format = {
  label: 'Editor test', trim: { width: mm(100), height: mm(100) },
  bleed: { top: mm(3), bottom: mm(3), outside: mm(3), binding: mm(0) },
  safe: { top: mm(5), bottom: mm(5), outside: mm(5), binding: mm(5) },
  structure: { delivery: 'pages', ends: 'single-pages', pageCount: { min: 2, max: 40, step: 2 } },
  output: { container: 'pdf', colorSpace: 'sRGB', transparency: 'allow' },
};
const render = () => null;
const component = () => null;
const declaration = (editors: object = { markedDays: { label: 'Marked days', parameters: ['markedDates'], component } }) => ({
  id: 'editors', version: '1', contract: 1, format,
  parameters: {
    firstMonth: p.date({ label: 'First month', default: '2027-01-01', precision: 'month' }),
    markedDates: p.string({ label: 'Marked days', default: '', maxLength: 600 }),
    accent: p.color({ label: 'Accent', default: '#243b30' }),
  },
  editors,
  spreads: {
    month: { label: 'Month', boxes: { hero: { type: 'photo', label: 'Photo' } }, render, anchors: () => [{ id: 'month', side: 'right' }],
      elements: { grid: { label: 'Grid', parameters: { size: p.integer({ label: 'Size', default: 3, min: 1, max: 9 }) },
        editor: { parameters: ['size'], component } } } },
    plain: { label: 'Plain', render },
  },
});
const template = chooseFormat(templateSchema.parse(declaration()));
const info = templateInfo(template);

function project(spreads: object[], params: Record<string, string> = {}): Project {
  return projectSchema.parse({ schemaVersion: 1, title: 'Editors', template: { id: 'editors', version: '1' }, params, spreads });
}
const months = () => [
  { id: 'jan', definition: 'month', boxes: { hero: { photo: 'shore' } } },
  { id: 'feb', definition: 'month' },
  { id: 'mar', definition: 'month' },
];
const photo = (caption: string) => ({ width: 1200, height: 800, caption, src: '/photo' });
const rendered = (state: Project, photos: RenderProject['photos'] = { shore: photo('Shore'), cliffs: photo('Cliffs') }) =>
  ({ project: state, photos, texts: {}, files: {}, problems: [], mode: 'edit', template: { script: '', assets: {} } }) as RenderProject;
const markedDays: EditorTarget = { kind: 'document', spread: 'feb', layout: 'month', editor: 'markedDays' };
const key = (state: Project, target: EditorTarget) => editingContext(info, editorState(state, target.spread)!, target);

test('a node marked only with parameters a document editor owns opens that editor', () => {
  assert.equal(documentEditorFor(info, ['document.markedDates']), 'markedDays');
  // A node that also shows another parameter, or a document parameter no editor owns, keeps its popover.
  assert.equal(documentEditorFor(info, ['document.markedDates', 'document.accent']), undefined);
  assert.equal(documentEditorFor(info, ['document.accent']), undefined);
  assert.equal(documentEditorFor(info, ['markedDates']), undefined);
  assert.equal(documentEditorFor(info, []), undefined);
  // Owned document parameters get no control in Book settings.
  assert.deepEqual(editorOwnedDocument(info), ['markedDates']);
});

test('document editors must edit declared document parameters, each owned by one editor', () => {
  const problems = (editors: object) => {
    const result = templateSchema.safeParse(declaration(editors));
    return result.success ? [] : result.error.issues.map(({ message }) => message);
  };
  assert.deepEqual(problems({ dates: { parameters: ['holidays'], component } }),
    ["Document editor dates edits holidays, which the template's parameters do not declare."]);
  assert.deepEqual(problems({ a: { parameters: ['markedDates'], component }, b: { parameters: ['markedDates'], component } }),
    ['Document parameter markedDates is edited by both a and b. Give it to one editor.']);
  assert.match(problems({ empty: { parameters: [], component } }).join(), /at least one document parameter/);
  // Only labels and parameters reach the app; components stay in the render frame.
  assert.deepEqual(info.editors, { markedDays: { label: 'Marked days', parameters: ['markedDates'] } });
});

test('the editor context is what render reads, and follows reordering and photo changes', () => {
  const state = project(months());
  const opened = editorContext(rendered(state), template, 'feb')!;
  assert.equal(opened.context.spread, 'feb');
  assert.equal(opened.context.layout, 'month');
  assert.deepEqual(opened.context.page, { left: 3, right: 4 });
  // The book's anchors tell the page which month it is: February is the second month page.
  assert.equal(opened.context.book.anchors('month').findIndex((anchor) => anchor.page === opened.context.page.right), 1);
  assert.equal(opened.context.document.firstMonth, '2027-01-01');
  assert.equal(opened.context.boxes.hero.photo, null);

  // Moving February to the front makes it the first month page.
  const reordered = project([months()[1], months()[0], months()[2]]);
  const moved = editorContext(rendered(reordered), template, 'feb')!;
  assert.notEqual(moved.key, opened.key);
  assert.equal(moved.context.book.anchors('month').findIndex((anchor) => anchor.page === moved.context.page.right), 0);

  // A photo assigned to the page shows in the context, with its metadata and without its file location.
  const withPhoto = project(months().map((spread) => spread.id === 'feb' ? { ...spread, boxes: { hero: { photo: 'cliffs' } } } : spread));
  const photographed = editorContext(rendered(withPhoto), template, 'feb')!;
  assert.notEqual(photographed.key, opened.key);
  assert.deepEqual(photographed.context.boxes.hero.photo, { width: 1200, height: 800, caption: 'Cliffs' });

  // A change elsewhere in the book that this page cannot see leaves the context as it was.
  const elsewhere = project(months().map((spread) => spread.id === 'jan' ? { ...spread, boxes: { hero: { photo: 'cliffs' } } } : spread));
  assert.equal(editorContext(rendered(elsewhere), template, 'feb')!.key, opened.key);
  // A deleted spread has no context; the app closes its editor.
  assert.equal(editorContext(rendered(project([months()[0]])), template, 'feb'), undefined);
});

test('context changes do not make a document editor stale, outside edits to its own values do', () => {
  const state = project(months(), { markedDates: '25.12' });
  const opened = key(state, markedDays);
  // Reordering, another photo or another document parameter (even the first month) refresh the context instead.
  assert.equal(key(project([months()[1], months()[0], months()[2]], { markedDates: '25.12' }), markedDays), opened);
  assert.equal(key(project(months().map((spread) => ({ ...spread, boxes: { hero: { photo: 'cliffs' } } })), { markedDates: '25.12' }), markedDays), opened);
  assert.equal(key(project(months(), { markedDates: '25.12', firstMonth: '2027-06-01', accent: '#ff0000' }), markedDays), opened);
  // A change to the marked dates themselves (Undo, an agent, a reload) is a conflict: stop and reopen.
  assert.notEqual(key(project(months(), { markedDates: '25.12, 2027-02-14' }), markedDays), opened);
  // So is a changed declaration of an owned parameter, such as a new default.
  const changed = chooseFormat(templateSchema.parse({ ...declaration(), parameters: { ...declaration().parameters,
    markedDates: p.string({ label: 'Marked days', default: '01.01', maxLength: 600 }) } }));
  assert.notEqual(editingContext(templateInfo(changed), editorState(state, 'feb')!, markedDays), opened);
});

test('element editors keep their stale rule and ignore context changes', () => {
  const grid: EditorTarget = { kind: 'element', spread: 'feb', element: 'grid' };
  const opened = key(project(months()), grid);
  assert.equal(key(project([months()[2], months()[1], months()[0]], { markedDates: '25.12' }), grid), opened);
  assert.notEqual(key(project(months().map((spread) => spread.id === 'feb' ? { ...spread, elements: { grid: { params: { size: 5 } } } } : spread)), grid), opened);
});

test('an editor closes when what it was opened from is deleted, not when it moves', () => {
  const grid: EditorTarget = { kind: 'element', spread: 'feb', element: 'grid' };
  const spreads = project(months()).spreads;
  assert.equal(editorTargetGone(spreads, markedDays), false);
  assert.equal(editorTargetGone([spreads[1], spreads[0], spreads[2]], markedDays), false);
  assert.equal(editorTargetGone([spreads[0], spreads[2]], markedDays), true);
  assert.equal(editorTargetGone([spreads[0], spreads[2]], grid), true);
  // Switching the page's layout removes the node a document editor was opened from. An element editor reports
  // that its values changed instead, as before.
  const switched = [spreads[0], { ...spreads[1], definition: 'plain' }, spreads[2]];
  assert.equal(editorTargetGone(switched, markedDays), true);
  assert.equal(editorTargetGone(switched, grid), false);
});

test('a queued save applies only to the values it was based on', () => {
  const state = project(months(), { markedDates: '25.12' });
  const before = key(state, markedDays);
  const changes = changedValues(info, editorState(state, 'feb')!, markedDays, { values: { markedDates: '25.12, 2027-02-14' }, spread: {} })!;
  assert.deepEqual(changes, { values: { markedDates: '25.12, 2027-02-14' }, spread: {} });
  // An unchanged draft saves nothing.
  assert.equal(changedValues(info, editorState(state, 'feb')!, markedDays, { values: { markedDates: '25.12' }, spread: {} }), undefined);

  // Applied to the project it was based on, even after the page moved.
  const moved = project([months()[1], months()[0], months()[2]], { markedDates: '25.12' });
  assert.equal(queuedEditorSave(info, moved, markedDays, before, changes), true);
  assert.equal(moved.params.markedDates, '25.12, 2027-02-14');

  // Not applied when the marked dates changed while the save waited (Undo, an agent), so it cannot overwrite them.
  const newer = project(months(), { markedDates: '01.01' });
  assert.equal(queuedEditorSave(info, newer, markedDays, before, changes), false);
  assert.equal(newer.params.markedDates, '01.01');
  // Nor when the page it was opened from was deleted or switched layout.
  const deleted = project([months()[0]], { markedDates: '25.12' });
  assert.equal(queuedEditorSave(info, deleted, markedDays, before, changes), false);
  assert.equal(deleted.params.markedDates, '25.12');
  const switched = project(months().map((spread) => spread.id === 'feb' ? { ...spread, definition: 'plain' } : spread), { markedDates: '25.12' });
  assert.equal(queuedEditorSave(info, switched, markedDays, before, changes), false);
});

test('a document editor sets only its own document parameters', () => {
  const { allowed, rejected } = editorChanges(template.parameters, ['markedDates'], { markedDates: '25.12', accent: '#000000', holidays: 'x' }, 'element', 'document');
  assert.deepEqual(allowed, { markedDates: '25.12' });
  assert.deepEqual(rejected.map(({ message }) => message), [
    "set() ignored accent: it is not one of this editor's parameters, so it is edited in Book settings. This editor edits markedDates.",
    'set() ignored holidays: the document has no such parameter. This editor edits markedDates.',
  ]);
});
