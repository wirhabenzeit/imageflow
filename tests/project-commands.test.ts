import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TemplateInfo } from '../src/desktop';
import { formatSchema, mm } from '../src/format';
import { p } from '../src/parameters';
import { photoIndexSchema, projectSchema } from '../src/project';
import type { ProjectFiles } from '../src/project';
import { applyProjectCommands, ProjectCommandError, projectOperationsSchema } from '../src/project-commands';
import type { ProjectCommandErrorCode } from '../src/project-commands';

const format = formatSchema.parse({
  label: 'Test', trim: { width: mm(200), height: mm(200) },
  bleed: { top: mm(3), bottom: mm(3), outside: mm(3), binding: mm(0) },
  safe: { top: mm(5), bottom: mm(5), outside: mm(5), binding: mm(5) },
  // Inside covers put no ordering rule on spreads, so these tests can move spreads freely (strict ends: single-pages.test.ts).
  structure: { delivery: 'pages', ends: 'inside-covers', pageCount: { min: 2, max: 200, step: 2 } },
  output: { container: 'pdf', colorSpace: 'sRGB', transparency: 'allow' },
});
const photo = { type: 'photo' as const, label: 'Photo', parameters: { caption: p.boolean({ label: 'Caption', default: false }) } };
const heading = p.string({ label: 'Heading', default: '', maxLength: 30 });
const template: TemplateInfo = {
  version: '1', format, formatId: 'standard', formats: { standard: 'Standard', wide: 'Wide' },
  parameters: { paper: p.enum({ label: 'Paper', default: 'white', options: ['white', 'cream'] }), route: p.file({ label: 'Route', accept: ['.gpx'] }) },
  spreads: {
    main: {
      label: 'Main', span: 'spread', parameters: { heading }, boxes: { hero: photo, second: photo,
        body: { type: 'markdown', label: 'Body', parameters: { size: p.integer({ label: 'Size', default: 2, min: 1, max: 4 }) } } },
      elements: { calendar: { label: 'Calendar', parameters: { month: p.date({ label: 'Month', default: '2026-01-01' }) } } },
    },
    minimal: {
      label: 'Minimal', span: 'spread', parameters: { heading: p.string({ label: 'Short heading', default: '', maxLength: 5 }) },
      boxes: { hero: photo }, elements: {},
    },
    end: { label: 'End', span: 'left', parameters: {}, boxes: { hero: photo }, elements: {} },
  },
};
function files(): ProjectFiles {
  return {
    project: projectSchema.parse({
      schemaVersion: 1, title: 'A book', template: { id: 'test', version: '1' },
      texts: { note: 'texts/note.md' }, files: { route: 'files/route.gpx', unsupported: 'files/note.txt' },
      spreads: [
        { id: 'one', definition: 'main', params: { heading: 'Long heading' }, boxes: {
          hero: { photo: 'p1', params: { caption: true }, crops: { main: { centerX: .2, centerY: .4, zoom: 2 } }, focus: { centerX: .2, centerY: .4 } },
          second: { photo: 'p2', params: {} }, body: { text: 'note', params: {} },
        } },
        { id: 'two', definition: 'main', boxes: { hero: { photo: 'p2', params: {} } } },
      ],
    }),
    photoIndex: photoIndexSchema.parse({ p1: { path: 'photos/one.jpg', caption: 'Old caption', credit: 'Author' }, p2: { path: 'photos/two.jpg' } }),
  };
}
function failure(operations: unknown, code: ProjectCommandErrorCode, index = 0) {
  const before = files();
  const original = structuredClone(before);
  assert.throws(() => applyProjectCommands(before, template, operations), (error) =>
    error instanceof ProjectCommandError && error.code === code && error.operationIndex === index);
  assert.deepEqual(before, original);
}

test('a batch inserts and references a spread before duplicating, moving, and removing it', () => {
  const original = files();
  const snapshot = structuredClone(original);
  let generated = 0;
  const result = applyProjectCommands(original, template, [
    { op: 'insert_spread', definition: 'main', ref: 'new', after: 'one', params: { heading: 'New' }, boxes: { hero: { photo: 'p2' } } },
    { op: 'set_parameter', scope: 'spread', spread: '$new', key: 'heading', value: 'Edited' },
    { op: 'duplicate_spread', spread: '$new', ref: 'copy' },
    { op: 'move_spread', spread: '$copy', after: null },
    { op: 'remove_spread', spread: '$new' },
  ], { generateId: () => 'generated-' + ++generated });
  assert.deepEqual(result.references, { new: 'generated-1', copy: 'generated-2' });
  assert.deepEqual(result.files.project.spreads.map(({ id }) => id), ['generated-2', 'one', 'two']);
  assert.equal(result.files.project.spreads[0].params.heading, 'Edited');
  assert.equal(result.files.project.spreads[0].boxes.hero.photo, 'p2');
  assert.equal(result.changes.length, 5);
  assert.equal(result.reflow, true);
  assert.deepEqual(original, snapshot);
});

test('layout switches preserve hidden content, crops, and rejected parameter overrides', () => {
  const original = files();
  const result = applyProjectCommands(original, template, [
    { op: 'switch_layout', spread: 'one', definition: 'minimal' },
    { op: 'switch_layout', spread: 'one', definition: 'main' },
  ]);
  assert.deepEqual(result.files, original);
  assert.match(result.changes[0], /Short heading will reset/);
  assert.equal(result.reflow, true);
  failure([{ op: 'switch_layout', spread: 'one', definition: 'end' }], 'INCOMPATIBLE_LAYOUT');
});

test('replacement assignments reset crop state and clearing preserves box parameters', () => {
  const replaced = applyProjectCommands(files(), template, [
    { op: 'assign_source', spread: 'one', box: 'hero', kind: 'photo', source: 'p2' },
  ]).files.project.spreads[0].boxes.hero;
  assert.deepEqual(replaced, { params: { caption: true }, photo: 'p2' });
  const cleared = applyProjectCommands(files(), template, [{ op: 'clear_box', spread: 'one', box: 'hero' }]);
  assert.deepEqual(cleared.files.project.spreads[0].boxes.hero, { params: { caption: true } });
  assert.deepEqual(cleared.files.photoIndex, files().photoIndex);
  failure([{ op: 'assign_source', spread: 'one', box: 'body', kind: 'photo', source: 'p1' }], 'BOX_TYPE_MISMATCH');
  failure([{ op: 'assign_source', spread: 'one', box: 'hero', kind: 'photo', source: 'missing' }], 'SOURCE_NOT_FOUND');
});

test('clearing removes saved content the current layout does not declare', () => {
  const base = files();
  base.project.spreads[0].boxes.orphan = { photo: 'p1', params: { legacy: true } };
  base.project.spreads[1] = { ...base.project.spreads[1], definition: 'minimal', boxes: { hero: { photo: 'p2', params: {} }, second: { photo: 'p1', params: { caption: true } } } };
  const cleared = applyProjectCommands(base, template, [
    { op: 'clear_box', spread: 'one', box: 'orphan' },
    { op: 'clear_box', spread: 'two', box: 'second' },
  ]);
  // No layout declares `orphan`, so nothing can use its parameters any more.
  assert.equal(Object.hasOwn(cleared.files.project.spreads[0].boxes, 'orphan'), false);
  // `second` is kept for the main layout, so its parameters stay with the spread.
  assert.deepEqual(cleared.files.project.spreads[1].boxes.second, { params: { caption: true } });
  assert.deepEqual(cleared.changes, ['Cleared box orphan', 'Cleared box second']);
  failure([{ op: 'clear_box', spread: 'one', box: 'unknown' }], 'BOX_NOT_FOUND');
});

test('swapping across spreads moves focus and keeps parameters while discarding per-frame crops', () => {
  const result = applyProjectCommands(files(), template, [{ op: 'swap_content', from: { spread: 'one', box: 'hero' }, to: { spread: 'two', box: 'hero' } }]);
  assert.deepEqual(result.files.project.spreads[0].boxes.hero, { params: { caption: true }, photo: 'p2' });
  assert.deepEqual(result.files.project.spreads[1].boxes.hero, { params: {}, photo: 'p1', focus: { centerX: .2, centerY: .4 } });
  assert.deepEqual(result.affectedSpreads, ['one', 'two']);
  failure([{ op: 'swap_content', from: { spread: 'one', box: 'hero' }, to: { spread: 'one', box: 'body' } }], 'BOX_TYPE_MISMATCH');
});

test('crops use the existing per-layout focus rules and require assigned photos', () => {
  const result = applyProjectCommands(files(), template, [
    { op: 'switch_layout', spread: 'one', definition: 'minimal' },
    { op: 'set_crop', spread: 'one', box: 'hero', centerX: .7, centerY: .6, zoom: 3 },
  ]);
  const box = result.files.project.spreads[0].boxes.hero;
  assert.deepEqual(box.crops, { main: { centerX: .2, centerY: .4, zoom: 2 }, minimal: { centerX: .7, centerY: .6, zoom: 3 } });
  assert.deepEqual(box.focus, { centerX: .7, centerY: .6 });
  failure([{ op: 'clear_box', spread: 'one', box: 'hero' }, { op: 'set_crop', spread: 'one', box: 'hero', centerX: .5, centerY: .5, zoom: 1 }], 'EMPTY_BOX', 1);
});

test('parameter commands validate scopes, types, constraints, and registered file extensions', () => {
  const result = applyProjectCommands(files(), template, [
    { op: 'set_parameter', scope: 'document', key: 'paper', value: 'cream' },
    { op: 'set_parameter', scope: 'document', key: 'route', value: 'route' },
    { op: 'set_parameter', scope: 'box', spread: 'one', owner: 'body', key: 'size', value: 3 },
    { op: 'set_parameter', scope: 'element', spread: 'one', owner: 'calendar', key: 'month', value: '2027-04-01' },
    { op: 'reset_parameter', scope: 'spread', spread: 'one', key: 'heading' },
  ]);
  assert.deepEqual(result.files.project.params, { paper: 'cream', route: 'route' });
  assert.deepEqual(result.files.project.spreads[0].params, {});
  assert.equal(result.files.project.spreads[0].boxes.body.params.size, 3);
  assert.equal(result.files.project.spreads[0].elements.calendar.params.month, '2027-04-01');
  failure([{ op: 'set_parameter', scope: 'box', spread: 'one', owner: 'body', key: 'size', value: 1.5 }], 'INVALID_PARAMETER_VALUE');
  failure([{ op: 'set_parameter', scope: 'document', key: 'paper', value: 'pink' }], 'INVALID_PARAMETER_VALUE');
  failure([{ op: 'set_parameter', scope: 'document', key: 'route', value: 'missing' }], 'SOURCE_NOT_FOUND');
  failure([{ op: 'set_parameter', scope: 'document', key: 'route', value: 'unsupported' }], 'INVALID_PARAMETER_VALUE');
  failure([{ op: 'set_parameter', scope: 'element', spread: 'one', owner: 'calendar', key: 'month', value: '2026-02-30' }], 'INVALID_PARAMETER_VALUE');
});

test('all supplied insertion state is checked before it can be returned', () => {
  failure([{ op: 'insert_spread', definition: 'main', boxes: { hero: { photo: 'missing' } } }], 'SOURCE_NOT_FOUND');
  failure([{ op: 'insert_spread', definition: 'main', boxes: { hero: { text: 'note' } } }], 'BOX_TYPE_MISMATCH');
  failure([{ op: 'insert_spread', definition: 'main', params: { unknown: true } }], 'PARAMETER_NOT_FOUND');
  failure([{ op: 'insert_spread', definition: 'main', elements: { unknown: { params: {} } } }], 'ELEMENT_NOT_FOUND');
  failure([{ op: 'insert_spread', definition: 'main', boxes: { hero: { photo: 'p1', crops: { end: { centerX: .5, centerY: .5, zoom: 1 } } } } }], 'INCOMPATIBLE_LAYOUT');
});

test('a failure late in a batch reports its operation and rolls back every earlier edit', () => {
  failure([
    { op: 'set_title', title: 'A changed title' },
    { op: 'set_photo_metadata', photo: 'p1', values: { caption: 'A changed caption' } },
    { op: 'remove_spread', spread: 'two' },
    { op: 'remove_spread', spread: 'two' },
  ], 'SPREAD_NOT_FOUND', 3);
});

test('removing every spread leaves an empty book whose document parameters can still change', () => {
  const result = applyProjectCommands(files(), template, [
    { op: 'remove_spread', spread: 'one' },
    { op: 'remove_spread', spread: 'two' },
    { op: 'set_parameter', scope: 'document', key: 'paper', value: 'cream' },
  ]);
  assert.deepEqual(result.files.project.spreads, []);
  assert.equal(result.files.project.params.paper, 'cream');
  assert.equal(projectSchema.safeParse(result.files.project).success, true);
  const reset = applyProjectCommands(result.files, template, [{ op: 'reset_parameter', scope: 'document', key: 'paper' }]);
  assert.equal(Object.hasOwn(reset.files.project.params, 'paper'), false);
  const inserted = applyProjectCommands(result.files, template, [{ op: 'insert_spread', definition: 'main', ref: 'first' }]);
  assert.equal(inserted.files.project.spreads.length, 1);
});

test('references must be declared earlier, unique, and point to existing spreads', () => {
  failure([{ op: 'move_spread', spread: '$future', after: null }], 'REFERENCE_NOT_FOUND');
  failure([{ op: 'duplicate_spread', spread: 'one', ref: 'copy' }, { op: 'duplicate_spread', spread: 'one', ref: 'copy' }], 'DUPLICATE_REFERENCE', 1);
  failure([{ op: 'duplicate_spread', spread: 'one', ref: 'copy' }, { op: 'remove_spread', spread: '$copy' }, { op: 'move_spread', spread: '$copy', after: null }], 'SPREAD_NOT_FOUND', 2);
  assert.throws(() => applyProjectCommands(files(), template, [{ op: 'duplicate_spread', spread: 'one' }], { generateId: () => 'one' }), { code: 'INVALID_SPREAD_ID', operationIndex: 0 });
});

test('moves require a destination and support the start, a spread, and earlier batch references', () => {
  failure([{ op: 'move_spread', spread: 'two' }], 'INVALID_OPERATION');
  const front = applyProjectCommands(files(), template, [{ op: 'move_spread', spread: 'two', after: null }]);
  assert.deepEqual(front.files.project.spreads.map(({ id }) => id), ['two', 'one']);
  const after = applyProjectCommands(files(), template, [{ op: 'move_spread', spread: 'one', after: 'two' }]);
  assert.deepEqual(after.files.project.spreads.map(({ id }) => id), ['two', 'one']);
  const referenced = applyProjectCommands(files(), template, [
    { op: 'insert_spread', definition: 'main', ref: 'chapter' },
    { op: 'move_spread', spread: 'one', after: '$chapter' },
  ], { generateId: () => 'chapter-id' });
  assert.deepEqual(referenced.files.project.spreads.map(({ id }) => id), ['two', 'chapter-id', 'one']);
});

test('metadata updates support explicit removal and identify every retained use', () => {
  const result = applyProjectCommands(files(), template, [
    { op: 'set_photo_metadata', photo: 'p2', values: { title: 'Two', caption: '', credit: null } },
    { op: 'set_photo_metadata', photo: 'p1', values: { caption: null } },
  ]);
  assert.deepEqual(result.files.photoIndex.p2, { path: 'photos/two.jpg', title: 'Two', caption: '' });
  assert.deepEqual(result.files.photoIndex.p1, { path: 'photos/one.jpg', credit: 'Author' });
  assert.deepEqual(result.affectedSpreads, ['one', 'two']);
});

test('strict schemas reject unknown fields, malformed scopes, unsafe IDs, invalid crop values, and oversized batches', () => {
  for (const operation of [
    { op: 'set_title', title: 'Book', unexpected: true },
    { op: 'set_parameter', scope: 'document', spread: 'one', key: 'paper', value: 'white' },
    { op: 'set_parameter', scope: 'box', spread: 'one', key: 'caption', value: true },
    { op: 'move_spread', spread: 'constructor', after: null },
    { op: 'move_spread', spread: '$__proto__', after: null },
    { op: 'insert_spread', definition: 'main', boxes: { hero: { photo: 'p1', unexpected: true } } },
    { op: 'set_crop', spread: 'one', box: 'hero', centerX: -.1, centerY: .5, zoom: 1 },
    { op: 'set_crop', spread: 'one', box: 'hero', centerX: .5, centerY: .5, zoom: Infinity },
    { op: 'set_photo_metadata', photo: 'p1', values: { path: '/outside.jpg' } },
  ]) failure([operation], 'INVALID_OPERATION');
  assert.equal(projectOperationsSchema.safeParse([]).success, false);
  assert.equal(projectOperationsSchema.safeParse(Array.from({ length: 101 }, () => ({ op: 'set_title', title: 'Book' }))).success, false);
});

test('declaration lookups reject inherited layouts and return only project files', () => {
  const inherited = { ...template, spreads: Object.create({ shadow: template.spreads.main }) };
  assert.throws(() => applyProjectCommands(files(), inherited, [{ op: 'insert_spread', definition: 'shadow' }]), { code: 'LAYOUT_NOT_FOUND' });
  const withRuntimeData = { ...files(), assets: new Map([['large.jpg', new Uint8Array(100)]]) };
  const result = applyProjectCommands(withRuntimeData, template, [{ op: 'set_title', title: 'New title' }]);
  assert.deepEqual(Object.keys(result.files).sort(), ['photoIndex', 'project']);
});

test('no-op operations preserve state and do not report changes', () => {
  const original = files();
  const result = applyProjectCommands(original, template, [
    { op: 'set_title', title: original.project.title },
    { op: 'switch_layout', spread: 'one', definition: 'main' },
    { op: 'move_spread', spread: 'two', after: 'one' },
    { op: 'assign_source', spread: 'two', box: 'hero', kind: 'photo', source: 'p2' },
    { op: 'swap_content', from: { spread: 'one', box: 'second' }, to: { spread: 'two', box: 'hero' } },
    { op: 'reset_parameter', scope: 'document', key: 'paper' },
    { op: 'set_photo_metadata', photo: 'p1', values: { caption: 'Old caption' } },
  ]);
  assert.deepEqual(result.files, original);
  assert.deepEqual(result.changes, []);
  assert.deepEqual(result.affectedSpreads, []);
  assert.equal(result.reflow, false);
});

test('content commands require page addressing on split sheets; merging stays available', () => {
  const original = files();
  const spread = original.project.spreads[0];
  spread.split = true;
  spread.pages = { left: { definition: 'page', params: { heading: 'Visible' },
    boxes: { hero: { photo: 'p2', params: {} } }, elements: {} } };
  const info: TemplateInfo = { ...template, spreads: { ...template.spreads, page: { ...template.spreads.main, span: 'page' } } };
  const operations = [
    { op: 'assign_source', spread: 'one', box: 'hero', kind: 'photo', source: 'p1' },
    { op: 'clear_box', spread: 'one', box: 'hero' },
    { op: 'set_crop', spread: 'one', box: 'hero', centerX: .5, centerY: .5, zoom: 2 },
    { op: 'set_parameter', spread: 'one', scope: 'spread', key: 'heading', value: 'Hidden' },
    { op: 'reset_parameter', spread: 'one', scope: 'spread', key: 'heading' },
    { op: 'set_parameter', spread: 'one', scope: 'box', owner: 'hero', key: 'caption', value: true },
    { op: 'set_parameter', spread: 'one', scope: 'element', owner: 'calendar', key: 'month', value: '2026-02-01' },
    { op: 'insert_list_item', spread: 'one', scope: 'spread', key: 'items', item: { id: 'x' } },
    { op: 'update_list_item', spread: 'one', scope: 'spread', key: 'items', id: 'x', values: { title: 'x' } },
    { op: 'remove_list_item', spread: 'one', scope: 'spread', key: 'items', id: 'x' },
    { op: 'move_list_item', spread: 'one', scope: 'spread', key: 'items', id: 'x', after: null },
    { op: 'swap_content', from: { spread: 'one', box: 'hero' }, to: { spread: 'two', box: 'hero' } },
    { op: 'swap_content', from: { spread: 'two', box: 'hero' }, to: { spread: 'one', box: 'hero' } },
  ];
  const before = structuredClone(original);
  for (const operation of operations) {
    assert.throws(() => applyProjectCommands(original, info, [{ op: 'set_title', title: 'Unsaved' }, operation]),
      (error) => error instanceof ProjectCommandError && error.code === 'SPREAD_SHOWN_AS_PAGES' &&
        error.operationIndex === 1 && /shown as pages/.test(error.message), operation.op);
    assert.deepEqual(original, before);
  }
  const merged = applyProjectCommands(original, info, [{ op: 'switch_layout', spread: 'one', definition: 'main' }]);
  assert.equal(merged.files.project.spreads[0].split, undefined);
  assert.equal(merged.files.project.spreads[0].boxes.hero.photo, 'p2');
  assert.equal(merged.files.project.spreads[0].params.heading, 'Visible');
});

test('switch_layout refuses page layouts on a split sheet whatever its hidden definition is', () => {
  const info: TemplateInfo = { ...template, spreads: { ...template.spreads, page: { ...template.spreads.main, span: 'page' } } };
  for (const definition of ['page', 'undeclared']) {
    const original = files();
    const spread = original.project.spreads[0];
    spread.definition = definition;
    spread.split = true;
    spread.pages = { left: { definition: 'page', params: {}, boxes: {}, elements: {} } };
    assert.throws(() => applyProjectCommands(original, info, [{ op: 'switch_layout', spread: 'one', definition: 'page' }]),
      (error) => error instanceof ProjectCommandError && error.code === 'INCOMPATIBLE_LAYOUT' && /Specify page/.test(error.message), definition);
  }
});

test('page commands isolate duplicate IDs, validate values and remain atomic', () => {
  const original = files();
  const info: TemplateInfo = { ...template, spreads: { ...template.spreads, page: {
    ...template.spreads.main, span: 'page', parameters: { heading, items: p.list({ label: 'Items', item: { title: heading } }) },
  } } };
  const initial = applyProjectCommands(original, info, [
    { op: 'insert_page_pair', ref: 'pair', pages: {
      left: { definition: 'page', boxes: { hero: { photo: 'p1' } } },
      right: { definition: 'page', boxes: { hero: { photo: 'p2' } } },
    } },
    { op: 'set_parameter', spread: '$pair', page: 'right', scope: 'spread', key: 'heading', value: 'Right' },
    { op: 'set_parameter', spread: '$pair', page: 'right', scope: 'box', owner: 'hero', key: 'caption', value: true },
    { op: 'set_parameter', spread: '$pair', page: 'right', scope: 'element', owner: 'calendar', key: 'month', value: '2026-02-01' },
    { op: 'insert_list_item', spread: '$pair', page: 'right', scope: 'spread', key: 'items', item: { id: 'x', title: 'One' } },
    { op: 'update_list_item', spread: '$pair', page: 'right', scope: 'spread', key: 'items', id: 'x', values: { title: 'Two' } },
    { op: 'set_crop', spread: '$pair', page: 'right', box: 'hero', centerX: .3, centerY: .4, zoom: 2 },
  ]);
  const pair = initial.files.project.spreads.at(-1)!;
  assert.equal(pair.pages!.left!.boxes.hero.photo, 'p1');
  assert.deepEqual(pair.pages!.left!.params, {});
  assert.equal(pair.pages!.right!.params.heading, 'Right');
  assert.equal(pair.pages!.right!.elements.calendar.params.month, '2026-02-01');
  assert.equal(pair.pages!.right!.boxes.hero.crops!.page.zoom, 2);
  assert.deepEqual(pair.pages!.right!.params.items, [{ id: 'x', title: 'Two' }]);
  assert.equal(pair.boxes.hero, undefined, 'hidden spread remains untouched');
  assert.deepEqual(original, files(), 'input files remain unchanged');
  const edited = applyProjectCommands(initial.files, info, [
    { op: 'swap_content', from: { spread: pair.id, page: 'left', box: 'hero' }, to: { spread: pair.id, page: 'right', box: 'hero' } },
    { op: 'reset_parameter', spread: pair.id, page: 'right', scope: 'spread', key: 'heading' },
    { op: 'clear_box', spread: pair.id, page: 'right', box: 'hero' },
    { op: 'assign_source', spread: pair.id, page: 'left', box: 'hero', kind: 'photo', source: 'p1' },
  ]).files;
  assert.equal(edited.project.spreads.at(-1)!.pages!.right!.boxes.hero.photo, undefined);
  assert.equal(edited.project.spreads.at(-1)!.pages!.right!.params.heading, undefined);
  assert.throws(() => applyProjectCommands(initial.files, info, [
    { op: 'set_title', title: 'Should roll back' },
    { op: 'set_parameter', spread: pair.id, page: 'right', scope: 'spread', key: 'heading', value: 'x'.repeat(40) },
  ]), /rejects this value/);
  assert.equal(initial.files.project.title, original.project.title);
});

test('reset removes an undeclared saved element parameter from just the addressed split page', () => {
  const before = files();
  const inserted = applyProjectCommands(before, { ...template, spreads: {
    ...template.spreads, page: { ...template.spreads.main, span: 'page' },
  } }, [{ op: 'insert_page_pair', ref: 'pair', pages: {
    left: { definition: 'page', elements: { calendar: { params: { month: '2026-02-01' } } } },
    right: { definition: 'page', elements: { calendar: { params: { month: '2026-03-01' } } } },
  } }]);
  const spread = inserted.references.pair;
  const migrated = { ...template, spreads: { ...template.spreads, page: { ...template.spreads.main, span: 'page' as const, elements: {} } } };
  const reset = applyProjectCommands(inserted.files, migrated, [
    { op: 'reset_parameter', scope: 'element', spread, page: 'left', owner: 'calendar', key: 'month' },
  ]);
  const pages = reset.files.project.spreads.at(-1)!.pages!;
  assert.equal(Object.hasOwn(pages.left!.elements, 'calendar'), false, 'the emptied undeclared element entry is removed');
  assert.equal(pages.right!.elements.calendar.params.month, '2026-03-01');
  assert.equal(inserted.files.project.spreads.at(-1)!.pages!.left!.elements.calendar.params.month, '2026-02-01');
  assert.throws(() => applyProjectCommands(reset.files, migrated, [
    { op: 'reset_parameter', scope: 'element', spread, page: 'left', owner: 'calendar', key: 'month' },
  ]), { code: 'PARAMETER_NOT_FOUND' }, 'resetting an unsaved, undeclared key still fails');
});

test('page layout transitions, blank pages and sheet operations share editor rules', () => {
  const info: TemplateInfo = { ...template, spreads: { ...template.spreads,
    page: { ...template.spreads.main, span: 'page' },
    left: { ...template.spreads.main, span: 'page', sides: ['left'] },
  } };
  const split = applyProjectCommands(files(), info, [
    { op: 'switch_layout', spread: 'one', page: 'left', definition: 'page' },
    { op: 'switch_layout', spread: 'one', page: 'right', definition: 'page' },
    { op: 'swap_pages', spread: 'one' },
    { op: 'clear_page', spread: 'one', page: 'left' },
    { op: 'duplicate_spread', spread: 'one', ref: 'copy' },
    { op: 'move_spread', spread: '$copy', after: 'two' },
    { op: 'remove_spread', spread: 'one' },
  ]);
  const copy = split.files.project.spreads.at(-1)!;
  assert.equal(copy.split, true);
  assert.equal(copy.pages!.left!.definition, undefined);
  assert.equal(copy.pages!.right!.definition, 'page');
  assert.throws(() => applyProjectCommands(split.files, info, [{ op: 'switch_layout', spread: copy.id, page: 'right', definition: 'left' }]), /not allowed/);
  assert.throws(() => applyProjectCommands(files(), info, [{ op: 'assign_source', spread: 'one', page: 'left', box: 'hero', kind: 'photo', source: 'p2' }]), /requires a split/);
  const restricted = applyProjectCommands(files(), info, [{ op: 'switch_layout', spread: 'one', page: 'left', definition: 'left' }]);
  assert.throws(() => applyProjectCommands(restricted.files, info, [{ op: 'swap_pages', spread: 'one' }]), /restricted/);
});

test('commands keep unknown fields they do not touch, and a content change keeps the box\'s other keys (ADR 0010)', () => {
  const original = files();
  const raw = { project: structuredClone(original.project) as Record<string, any>, photoIndex: structuredClone(original.photoIndex) as Record<string, any> };
  raw.project.bookNote = 'abc';
  raw.project.spreads[0].spreadNote = 's';
  raw.project.spreads[0].boxes.hero.boxNote = 'bx';
  raw.photoIndex.p1.syncRevision = 4;
  const loaded = { project: projectSchema.parse(raw.project), photoIndex: photoIndexSchema.parse(raw.photoIndex) };
  const result = applyProjectCommands(loaded, template, [
    { op: 'assign_source', spread: 'one', box: 'hero', kind: 'photo', source: 'p2' },
    { op: 'set_photo_metadata', photo: 'p1', values: { caption: 'New' } },
    { op: 'duplicate_spread', spread: 'one', ref: 'copy' },
  ]);
  const project = result.files.project as Record<string, any>;
  assert.equal(project.bookNote, 'abc');
  assert.equal(project.spreads[0].spreadNote, 's');
  assert.equal(project.spreads[0].boxes.hero.photo, 'p2');
  assert.equal(project.spreads[0].boxes.hero.crops, undefined);
  assert.equal(project.spreads[0].boxes.hero.boxNote, 'bx');
  // A duplicate is a copy of the whole state.
  assert.equal(project.spreads[1].spreadNote, 's');
  const index = result.files.photoIndex as Record<string, any>;
  assert.equal(index.p1.syncRevision, 4);
  assert.equal(index.p1.caption, 'New');
});

// Photo p1 shown on one spread, set aside on another, replaced content on a third, and on the cover.
function placed(): { files: ProjectFiles; template: TemplateInfo } {
  const book = files();
  const crop = { crops: { main: { centerX: .3, centerY: .3, zoom: 2 } }, focus: { centerX: .3, centerY: .3 } };
  book.project = projectSchema.parse({ ...structuredClone(book.project), format: 'standard', spreads: [
    { id: 'one', definition: 'main', boxes: { hero: { photo: 'p1', params: { caption: true }, ...crop }, body: { text: 'note', params: {} } } },
    { id: 'two', definition: 'minimal', boxes: { second: { photo: 'p1', params: {}, ...crop } } },
    { id: 'three', definition: 'main', boxes: {}, displaced: [{ from: 'spread', box: 'hero', state: { photo: 'p1', params: {} } }] },
    { id: 'four', definition: 'main', boxes: { hero: { photo: 'p2', params: {} } } },
  ], cover: { definition: 'wrap', boxes: { front: { photo: 'p1', params: {} } } }, params: { route: 'route' } });
  return { files: book, template: { ...template, coverFormats: { standard: {} }, coverLayouts: { wrap: { label: 'Wrap', parameters: {}, boxes: { front: photo }, elements: {} } } } as never };
}
const size = (width: number, height: number, caption?: string) => ({ width, height, ...(caption ? { caption } : {}) });

test('replace_source swaps a photo in every box, set aside or not, and keeps crops of the same shape (API-010)', () => {
  const { files: book, template } = placed();
  const original = structuredClone(book);
  const sizes: Record<string, ReturnType<typeof size>> = { p1: size(6000, 4000), p2: size(3000, 2001) };
  const operation = { op: 'replace_source', source: 'p1', with: 'p2' };
  const result = applyProjectCommands(book, template, [operation], { photo: (id) => sizes[id] });
  assert.deepEqual(book, original);
  const { project, photoIndex } = result.files;
  assert.equal(JSON.stringify(project).includes('"p1"'), false);
  assert.deepEqual(project.spreads[0].boxes.hero, { ...original.project.spreads[0].boxes.hero, photo: 'p2' });
  assert.deepEqual(project.spreads[1].boxes.second.crops, original.project.spreads[1].boxes.second.crops);
  assert.equal(project.spreads[2].displaced![0].state.photo, 'p2');
  assert.equal(project.cover!.boxes.front.photo, 'p2');
  assert.deepEqual(result.affectedSpreads, ['one', 'two', 'three', 'four'], 'also where the replacement stood, for its caption');
  assert.equal(result.affectedCover, true);
  // Each placement says what became of its crop (API-021).
  assert.deepEqual(result.changes, ['Replaced photo p1 with p2 in 2 boxes shown and 2 set aside; crop kept: one hero, two second; ' +
    'no crop saved: three hero (set aside), cover front; caption copied']);
  assert.deepEqual(photoIndex.p1, original.photoIndex.p1);
  assert.deepEqual(photoIndex.p2, { ...original.photoIndex.p2, caption: 'Old caption' });
  // Another shape, and one that is not known, drop the crops; a caption of its own stays.
  for (const p2 of [size(4000, 6000, 'From Lightroom'), undefined]) {
    const other = applyProjectCommands(book, template, [operation], { photo: (id) => id === 'p1' ? sizes.p1 : p2 });
    assert.equal(other.files.project.spreads[0].boxes.hero.crops, undefined);
    assert.equal(other.files.project.spreads[0].boxes.hero.focus, undefined);
    assert.deepEqual(other.files.project.spreads[0].boxes.hero.params, { caption: true });
    assert.match(other.changes[0], p2 ? /; crop reset, as the shapes differ: one hero, two second; no crop saved: three hero \(set aside\), cover front$/
      : /; crop reset, as the shapes are not known: one hero, two second; no crop saved: .*; caption copied$/);
    assert.equal(other.files.photoIndex.p2.caption, p2 ? undefined : 'Old caption');
  }
  assert.deepEqual(applyProjectCommands(book, template, [{ op: 'replace_source', source: 'p1', with: 'p1' }]).changes, []);
  failure([{ op: 'replace_source', source: 'p1', with: 'nope' }], 'SOURCE_NOT_FOUND');
});

test('remove_sources clears every use and says how many boxes that is (API-011)', () => {
  const { files: book, template } = placed();
  const result = applyProjectCommands(book, template, [{ op: 'remove_sources', kind: 'photo', sources: ['p1', 'p1'] }]);
  assert.equal(result.removedSources, true);
  assert.deepEqual(Object.keys(result.files.photoIndex), ['p2']);
  assert.equal(JSON.stringify(result.files.project).includes('"p1"'), false);
  assert.deepEqual(result.files.project.spreads[0].boxes.hero, { params: { caption: true } });
  assert.equal(result.files.project.spreads[2].displaced, undefined);
  assert.deepEqual(result.changes, ['Removed photo p1 from the book; cleared 2 boxes shown and 2 set aside']);
  assert.deepEqual([result.affectedSpreads, result.affectedCover], [['one', 'two', 'three'], true]);
  const text = applyProjectCommands(book, template, [{ op: 'remove_sources', kind: 'text', sources: ['note'] }]);
  assert.deepEqual([text.files.project.texts, text.files.project.spreads[0].boxes.body, text.reflow], [{}, { params: {} }, true]);
  const file = applyProjectCommands(book, template, [{ op: 'remove_sources', kind: 'file', sources: ['route', 'unsupported'] }]);
  assert.deepEqual([file.files.project.files, file.files.project.params], [{}, {}]);
  assert.equal(file.affectedSpreads.length, 4);
  assert.deepEqual(applyProjectCommands(book, template, [{ op: 'remove_sources', kind: 'file', sources: ['unsupported'] }]).changes, ['Removed file unsupported from the book; unused']);
  failure([{ op: 'remove_sources', kind: 'photo', sources: ['p1', 'nope'] }], 'SOURCE_NOT_FOUND');
});

test('changes of a photo or file on the cover are reported for the cover', () => {
  const { files: book, template } = placed();
  // Only the replacement is on the cover: it gets the caption.
  book.project.cover!.boxes.front.photo = 'p2';
  assert.equal(applyProjectCommands(book, template, [{ op: 'replace_source', source: 'p1', with: 'p2' }]).affectedCover, true);
  assert.equal(applyProjectCommands(book, template, [{ op: 'set_photo_metadata', photo: 'p2', values: { caption: 'New' } }]).affectedCover, true);
  // A file of the book settings and of the cover.
  book.project.cover!.params = { track: 'route' };
  const removed = applyProjectCommands(book, template, [{ op: 'remove_sources', kind: 'file', sources: ['route'] }]);
  assert.match(removed.changes[0], /cleared from book settings, the cover$/);
  assert.equal(removed.affectedCover, true);
  assert.equal(removed.affectedSpreads.length, 4);
});

test('replace_source sees captions cleared earlier in its batch', () => {
  const { files: book, template } = placed();
  book.photoIndex.p2.caption = 'Its own';
  const result = applyProjectCommands(book, template, [{ op: 'set_photo_metadata', photo: 'p2', values: { caption: null } },
    { op: 'replace_source', source: 'p1', with: 'p2' }], { photo: () => size(6000, 4000) });
  assert.equal(result.files.photoIndex.p2.caption, 'Old caption');
});

test('a layout that does not exist is answered with the likely ones and their labels (API-017)', () => {
  const message = (definition: string) => {
    try { applyProjectCommands(files(), template, [{ op: 'insert_spread', definition }]); } catch (error) { return (error as Error).message; }
    assert.fail('expected an error');
  };
  assert.equal(message('minimla'), 'The template has no layout minimla. Did you mean minimal (Minimal)?');
  assert.equal(message('somethingElse'), 'The template has no layout somethingElse. Layouts are listed in the template declarations (get_authoring_context).');
});
