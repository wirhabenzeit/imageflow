import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TemplateInfo } from '../src/desktop';
import { formatSchema, mm } from '../src/format';
import { listProblems, newItemId, p, parameterSchema, parameterWarnings, resolveParams, resolveValue, sameValue } from '../src/parameters';
import type { ListParameter } from '../src/parameters';
import { photoIndexSchema, projectSchema } from '../src/project';
import type { ProjectFiles } from '../src/project';
import { applyProjectCommands, ProjectCommandError } from '../src/project-commands';
import type { ProjectCommandErrorCode } from '../src/project-commands';
import { editorChanges } from '../src/editor-changes';
import { changedValues } from '../src/editor-session';
import { capabilities } from '../src/runtime-exports';
import { fileErrors } from '../src/file-findings';
import { fixtureRequestSchema, fixtureSpread, planFixtures } from '../src/fixtures';
import type { FixtureCase, FixtureCell, FixtureSourceIds } from '../src/fixtures';
import type { ListItem } from '../src/parameters';
import type { RenderProject } from '../src/project';
import { fileIsAssigned } from '../desktop/source-actions';

const tracks = p.list({
  label: 'Tracks',
  item: {
    track: p.file({ label: 'GPX track', accept: ['.gpx'] }),
    colour: p.color({ label: 'Colour', default: '#c0392b' }),
    label: p.string({ label: 'Label', default: '', maxLength: 10 }),
  },
  max: 3,
}) as ListParameter;

test('list parameters are in the pre-release contract-1 baseline', () => {
  assert.ok(capabilities.includes('list-parameters'));
});

test('p.list declarations validate their items, bounds and defaults', () => {
  assert.equal(parameterSchema.safeParse(tracks).success, true);
  // Default items get IDs from their position.
  const withDefault = p.list({ label: 'Stops', item: { place: p.string({ label: 'Place', default: '' }) }, default: [{ place: 'Oslo' }, { place: 'Bergen' }] });
  assert.deepEqual(withDefault.default, [{ id: 'item1', place: 'Oslo' }, { id: 'item2', place: 'Bergen' }]);
  assert.equal(parameterSchema.safeParse(withDefault).success, true);
  const bad = (declaration: unknown) => assert.equal(parameterSchema.safeParse(declaration).success, false, JSON.stringify(declaration));
  bad({ type: 'list', label: 'Empty', item: {}, default: [] });
  bad({ type: 'list', label: 'Reserved', item: { id: { type: 'string', label: 'Id', default: '' } }, default: [] });
  bad({ type: 'list', label: 'Nested', item: { inner: tracks }, default: [] });
  bad({ type: 'list', label: 'Bounds', item: { a: { type: 'boolean', label: 'A', default: false } }, min: 3, max: 2, default: [{ id: 'x' }, { id: 'y' }, { id: 'z' }] });
  // A default without IDs, written without p.list, or outside min/max, is not a valid value.
  bad({ type: 'list', label: 'No ids', item: { a: { type: 'boolean', label: 'A', default: false } }, default: [{ a: true }] });
  bad({ type: 'list', label: 'Too few', item: { a: { type: 'boolean', label: 'A', default: false } }, min: 1, default: [] });
  bad({ type: 'list', label: 'Bad field default', item: { c: { type: 'color', label: 'C', default: 'red' } }, default: [] });
});

test('list values are checked per item, and missing fields are allowed', () => {
  assert.deepEqual(listProblems(tracks, []), []);
  assert.deepEqual(listProblems(tracks, [{ id: 'a', track: 'gpx1' }, { id: 'b', colour: '#000000', label: 'Day 2' }]), []);
  assert.deepEqual(listProblems(tracks, 'gpx1'), ['is not a list of items']);
  assert.deepEqual(listProblems(tracks, [{ id: 'a' }, { id: 'a' }, { colour: '#000000' }, 'x', { id: 'c', colour: 'red', width: 3 }]), [
    'has 5 items; it allows at most 3', 'item 2 repeats the id a', 'item 3 has no valid id', 'item 4 is not an object',
    'item 5 · Colour has a value the template does not allow', 'item 5 has a field width the list does not declare',
  ]);
});

test('resolving a list fills defaults, leaves out unreadable items and never rewrites the saved value', () => {
  const saved: Record<string, string | number>[] = [{ id: 'a', track: 'gpx1' }, { id: 'a', track: 'gpx2' }, { id: 'b', colour: 'red', label: 'Far too long a label', extra: 1 }];
  const copy = structuredClone(saved);
  assert.deepEqual(resolveValue(tracks, saved), [
    { id: 'a', track: 'gpx1', colour: '#c0392b', label: '' },
    { id: 'b', track: '', colour: '#c0392b', label: '' },
  ]);
  assert.deepEqual(saved, copy);
  // Not a list, or too many readable items: the list's default.
  assert.deepEqual(resolveValue(tracks, 'gpx1'), []);
  assert.deepEqual(resolveValue(tracks, [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]), []);
  assert.deepEqual(resolveParams({ tracks }, {}), { tracks: [] });
  // Each problem is reported, naming its item.
  assert.deepEqual(parameterWarnings({ tracks }, { tracks: saved }, 'Map'), [
    'Map · Tracks item 2 repeats the id a; the item is left out.',
    'Map · Tracks item 3 · Colour has a value the template does not allow; its default is used.',
    'Map · Tracks item 3 · Label has a value the template does not allow; its default is used.',
    'Map · Tracks item 3 has a field extra the list does not declare; that field is ignored.',
  ]);
  assert.deepEqual(parameterWarnings({ tracks }, { tracks: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }] }, 'Map'),
    ['Map · Tracks has 4 items; it allows at most 3; the default is used.']);
});

test('item IDs are unique identifiers, and lists compare by content', () => {
  const items = [{ id: newItemId() }];
  for (let i = 0; i < 50; i++) items.push({ id: newItemId(items) });
  assert.equal(new Set(items.map(({ id }) => id)).size, items.length);
  assert.ok(items.every(({ id }) => /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)));
  assert.ok(sameValue([{ id: 'a', x: 1 }], [{ id: 'a', x: 1 }]));
  assert.ok(!sameValue([{ id: 'a', x: 1 }], [{ id: 'a', x: 2 }]));
  assert.ok(sameValue('a', 'a') && !sameValue('a', ['a']));
});

test('saved projects keep list values, including items the template does not allow', () => {
  const project = projectSchema.parse({ schemaVersion: 1, title: 'Book', template: { id: 't', version: '1' },
    spreads: [{ id: 's', definition: 'map', params: {}, elements: { map: { params: { tracks: [{ id: 'a', track: 'gpx1' }, { colour: 'red' }] } } } }] });
  assert.deepEqual(project.spreads[0].elements.map.params.tracks, [{ id: 'a', track: 'gpx1' }, { colour: 'red' }]);
});

test('custom editors set the whole list, which is validated like any value', () => {
  const ok = editorChanges({ tracks }, ['tracks'], { tracks: [{ id: 'a', track: 'gpx1' }] });
  assert.deepEqual(ok, { allowed: { tracks: [{ id: 'a', track: 'gpx1' }] }, rejected: [] });
  const bad = editorChanges({ tracks }, ['tracks'], { tracks: [{ track: 'gpx1' }] });
  assert.deepEqual(bad.allowed, {});
  assert.match(bad.rejected[0].message, /Tracks takes an array of items, each an object with a unique id and the fields track, colour, label, 0 to 3 items/);
});

const format = formatSchema.parse({
  label: 'Test', trim: { width: mm(200), height: mm(200) },
  bleed: { top: mm(3), bottom: mm(3), outside: mm(3), binding: mm(0) },
  safe: { top: mm(5), bottom: mm(5), outside: mm(5), binding: mm(5) },
  structure: { delivery: 'pages', ends: 'inside-covers', pageCount: { min: 2, max: 200, step: 2 } },
  output: { container: 'pdf', colorSpace: 'sRGB', transparency: 'allow' },
});
const template: TemplateInfo = {
  version: '1', format, formatId: 'standard', formats: { standard: 'Standard' },
  parameters: { stops: p.list({ label: 'Stops', item: { place: p.string({ label: 'Place', default: '' }) }, default: [{ place: 'Home' }] }) },
  spreads: { map: { label: 'Map', span: 'spread', parameters: {}, boxes: {}, elements: { map: { label: 'Map', parameters: { tracks, zoom: p.number({ label: 'Zoom', default: 8 }) } } } } },
};
function files(params: Record<string, unknown> = { tracks: [{ id: 'a', track: 'gpx1' }, { id: 'b', track: 'gpx2', colour: '#000000' }] }): ProjectFiles {
  return {
    project: projectSchema.parse({ schemaVersion: 1, title: 'Book', template: { id: 't', version: '1' },
      files: { gpx1: 'files/one.gpx', gpx2: 'files/two.gpx', notes: 'files/notes.txt' },
      spreads: [{ id: 's', definition: 'map', params: {}, elements: { map: { params } } }] }),
    photoIndex: photoIndexSchema.parse({}),
  };
}
const target = { scope: 'element', spread: 's', owner: 'map', key: 'tracks' } as const;
const saved = (result: { files: ProjectFiles }) => result.files.project.spreads[0].elements.map.params.tracks;
function failure(operations: unknown, code: ProjectCommandErrorCode, before = files()) {
  const original = structuredClone(before);
  assert.throws(() => applyProjectCommands(before, template, operations), (error) => error instanceof ProjectCommandError && error.code === code,
    JSON.stringify(operations));
  assert.deepEqual(before, original);
}

test('agents set a whole list, validated per item and per file', () => {
  const result = applyProjectCommands(files(), template, [{ op: 'set_parameter', ...target, value: [{ id: 'x', track: 'gpx2', label: 'Day 1' }] }]);
  assert.deepEqual(saved(result), [{ id: 'x', track: 'gpx2', label: 'Day 1' }]);
  assert.deepEqual(result.changes, ['Updated elements.map.tracks']);
  // The same list again changes nothing.
  assert.deepEqual(applyProjectCommands(files(), template, [{ op: 'set_parameter', ...target, value: saved({ files: files() }) }]).changes, []);
  failure([{ op: 'set_parameter', ...target, value: [{ track: 'gpx1' }] }], 'INVALID_PARAMETER_VALUE');
  failure([{ op: 'set_parameter', ...target, value: [{ id: 'x', track: 'missing' }] }], 'SOURCE_NOT_FOUND');
  failure([{ op: 'set_parameter', ...target, value: [{ id: 'x', track: 'notes' }] }], 'INVALID_PARAMETER_VALUE');
  failure([{ op: 'set_parameter', ...target, value: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }] }], 'INVALID_PARAMETER_VALUE');
  failure([{ op: 'set_parameter', ...target, key: 'zoom', value: [] }], 'INVALID_PARAMETER_VALUE');
});

test('agents insert, update, move and remove list items by ID', () => {
  const result = applyProjectCommands(files(), template, [
    { op: 'insert_list_item', ...target, item: { id: 'c', track: 'gpx1', label: 'Day 3' }, after: 'a' },
    { op: 'update_list_item', ...target, id: 'b', values: { colour: '#ffffff' } },
    { op: 'move_list_item', ...target, id: 'b', after: null },
    { op: 'remove_list_item', ...target, id: 'a' },
  ]);
  assert.deepEqual(saved(result), [{ id: 'b', track: 'gpx2', colour: '#ffffff' }, { id: 'c', track: 'gpx1', label: 'Day 3' }]);
  assert.deepEqual(result.changes, ['Added item c to elements.map.tracks', 'Updated item b of elements.map.tracks',
    'Moved item b in elements.map.tracks', 'Removed item a from elements.map.tracks']);
  // An inserted item without an ID gets a new one, appended.
  const appended = saved(applyProjectCommands(files(), template, [{ op: 'insert_list_item', ...target, item: { track: 'gpx2' } }])) as { id: string }[];
  assert.equal(appended.length, 3);
  assert.match(appended[2].id, /^i[0-9a-f]{10}$/);
  // A document list without a saved value starts from its default.
  const document = applyProjectCommands(files(), template, [{ op: 'insert_list_item', scope: 'document', key: 'stops', item: { id: 'away', place: 'Away' } }]);
  assert.deepEqual(document.files.project.params.stops, [{ id: 'item1', place: 'Home' }, { id: 'away', place: 'Away' }]);
  // Items on an element without saved parameters create its state.
  const empty = files();
  empty.project.spreads[0].elements = {};
  assert.deepEqual(saved(applyProjectCommands(empty, template, [{ op: 'insert_list_item', ...target, item: { id: 'n' } }])), [{ id: 'n' }]);
});

test('list item operations reject what the list does not allow', () => {
  failure([{ op: 'update_list_item', ...target, id: 'nope', values: { label: 'x' } }], 'ITEM_NOT_FOUND');
  failure([{ op: 'remove_list_item', ...target, id: 'nope' }], 'ITEM_NOT_FOUND');
  failure([{ op: 'move_list_item', ...target, id: 'a', after: 'nope' }], 'ITEM_NOT_FOUND');
  failure([{ op: 'move_list_item', ...target, id: 'a', after: 'a' }], 'INVALID_POSITION');
  failure([{ op: 'insert_list_item', ...target, item: { id: 'a' } }], 'INVALID_PARAMETER_VALUE');
  failure([{ op: 'insert_list_item', ...target, item: { colour: 'red' } }], 'INVALID_PARAMETER_VALUE');
  failure([{ op: 'insert_list_item', ...target, item: { track: 'missing' } }], 'SOURCE_NOT_FOUND');
  failure([{ op: 'update_list_item', ...target, id: 'a', values: { id: 'z' } }], 'INVALID_PARAMETER_VALUE');
  failure([{ op: 'insert_list_item', ...target, item: {} }, { op: 'insert_list_item', ...target, item: {} }], 'INVALID_PARAMETER_VALUE');
  failure([{ op: 'remove_list_item', ...target, key: 'zoom', id: 'a' }], 'NOT_A_LIST');
  // A saved list the template no longer allows is replaced whole, not edited item by item.
  failure([{ op: 'remove_list_item', ...target, id: 'a' }], 'INVALID_PARAMETER_VALUE', files({ tracks: [{ id: 'a' }, { id: 'a' }] }));
});

test('an open editor sees no change when a list is set to the same items', () => {
  const state = { spread: files().project.spreads[0], params: {} };
  const editorTarget = { kind: 'element' as const, spread: 's', element: 'map' };
  const current = resolveParams(template.spreads.map.elements.map.parameters, state.spread.elements.map.params);
  assert.equal(changedValues(template, state, editorTarget, { values: { tracks: structuredClone(current.tracks) }, spread: {} }), undefined);
  assert.ok(changedValues(template, state, editorTarget, { values: { tracks: [] }, spread: {} }));
});

test('a list falls back to its default when dropping unreadable items leaves fewer than min', () => {
  const atLeastTwo = p.list({ label: 'Stops', item: { place: p.string({ label: 'Place', default: '' }) }, min: 2,
    default: [{ place: 'A' }, { place: 'B' }] }) as ListParameter;
  assert.deepEqual(resolveValue(atLeastTwo, [{ id: 'x', place: 'X' }, { id: 'x', place: 'Y' }]),
    [{ id: 'item1', place: 'A' }, { id: 'item2', place: 'B' }]);
  assert.deepEqual(resolveValue(atLeastTwo, [{ id: 'x', place: 'X' }, { id: 'y', place: 'Y' }]), [{ id: 'x', place: 'X' }, { id: 'y', place: 'Y' }]);
});

test('positional default IDs skip IDs other default items use', () => {
  const list = p.list({ label: 'L', item: { place: p.string({ label: 'Place', default: '' }) }, default: [{ id: 'item2', place: 'A' }, { place: 'B' }, { place: 'C' }] });
  assert.deepEqual(list.default.map(({ id }) => id), ['item2', 'item2-2', 'item3']);
  assert.equal(parameterSchema.safeParse(list).success, true);
});

test('a rejected list from an editor shows the value and its first problem', () => {
  const { rejected } = editorChanges({ tracks }, ['tracks'], { tracks: [{ id: 'a' }, { id: 'a' }] });
  assert.match(rejected[0].message, /\[\{"id":"a"\},\{"id":"a"\}\] is not a valid value \(it item 2 repeats the id a\)/);
});

test('the Book check reports a missing or wrong file per list item', () => {
  const book = { project: { files: { gpx1: 'files/one.gpx', notes: 'files/notes.txt' } },
    files: { gpx1: { name: 'one.gpx', extension: '.gpx', text: '' }, notes: { name: 'notes.txt', extension: '.txt', text: '' } } } as unknown as RenderProject;
  const findings = fileErrors(book, { tracks }, { tracks: [{ id: 'a', track: 'gpx1' }, { id: 'b', track: 'gone' }, { id: 'c', track: 'notes' }] }, 'Map');
  assert.deepEqual(findings.map(({ code, message, parameter, source }) => ({ code, message, parameter, source })), [
    { code: 'file-missing', message: 'Map · Tracks 2 · GPX track: the assigned file is no longer in the project. Choose it again.', parameter: 'tracks', source: 'gone' },
    { code: 'file-type', message: 'Map · Tracks 3 · GPX track: notes.txt is not a .gpx file. Choose another file.', parameter: 'tracks', source: 'notes' },
  ]);
  assert.match(findings[0].suggestion!, /\(item b, field track\)/);
});

test('a file held in a list item is assigned, so it cannot be removed', () => {
  const book = { project: files().project } as Parameters<typeof fileIsAssigned>[0];
  assert.equal(fileIsAssigned(book, 'gpx2'), true);
  assert.equal(fileIsAssigned(book, 'notes'), false);
});

test('fixtures fill list items, including a malformed file and long text', () => {
  const ids: FixtureSourceIds = { photo: { landscape: 'land', portrait: 'port' }, file: (extension) => 'bad' + extension };
  const definition = template.spreads.map;
  const cell = (fixture: FixtureCase) => ({ layout: 'map', case: fixture, spread: 'f-' + fixture }) as FixtureCell;
  const items = (fixture: FixtureCase) => fixtureSpread(cell(fixture), definition, ids, 'text').elements.map.params.tracks as ListItem[];
  assert.deepEqual(items('malformed-files'), [{ id: 'fixture1', track: 'bad.gpx', label: '' }]);
  assert.equal((items('long-text')[0].label as string).length, 10);
  assert.deepEqual(items('empty'), []);
  assert.equal(items('typical').length, 1);
  // The map's list makes the malformed-files and long-text cases applicable.
  const plan = planFixtures({ ...template, spreads: { map: definition } }, fixtureRequestSchema.parse({}));
  assert.ok(!plan.skipped.some(({ layout, case: fixture }) => layout === 'map' && (fixture === 'malformed-files' || fixture === 'long-text')), JSON.stringify(plan.skipped));
});
