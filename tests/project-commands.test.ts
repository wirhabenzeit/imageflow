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
  structure: { delivery: 'pages', ends: 'single-pages', pageCount: { min: 2, max: 200, step: 2 } },
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
  assert.match(result.changes[0], /Short heading uses the default/);
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
    { op: 'remove_spread', spread: 'one' },
  ], 'LAST_SPREAD', 3);
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
