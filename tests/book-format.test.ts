import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadProject, updateProject } from '../desktop/project';
import { bookFormatOf, bookFormatVersion, pagesUnsupportedMessage, photoIndexSchema, projectSchema, scopeState, spreadSchema, unsupportedBookMessage } from '../src/project';
import './persistence-root';

// Book format 2 adds page states (ADR 0009). A book is written in the lowest format that holds it. Every reference
// consumer reads page states and replaced content (phase 2), so books that store them open; until pages are drawn
// (phase 3), a book with a spread shown as pages is refused with a request to update (release gate).

const spread = { id: 'one', definition: 'story', params: {}, boxes: { hero: { photo: 'a', params: {} } }, elements: {} };
const book = (spreads: unknown[], schemaVersion = 1) => ({ schemaVersion, title: 'Pages', template: { id: 't', version: '1' }, spreads });
const left = { definition: 'photoPage', params: { title: 'Left' }, boxes: { hero: { photo: 'b', params: {} } }, elements: {} };
const displaced = [{ from: 'right', box: 'hero', state: { photo: 'b', params: { tilt: 2 }, crops: { photoPage: { centerX: 0.4, centerY: 0.5, zoom: 1.2 } } } }];

test('a book without page states is format 1, whatever it was saved as', () => {
  assert.equal(bookFormatVersion, 4);
  assert.equal(projectSchema.parse(book([spread])).schemaVersion, 1);
  // A format-2 book whose page states were all removed goes back to format 1, so older apps can open it again.
  assert.equal(projectSchema.parse(book([spread], 2)).schemaVersion, 1);
});

test('stored page states or replaced content make a book format 2', () => {
  assert.equal(bookFormatOf({ spreads: [{}, { pages: {} }] }), 2);
  assert.equal(bookFormatOf({ spreads: [{ displaced: [] }] }), 2);
  assert.equal(bookFormatOf({ spreads: [{ split: true }] }), 2);
  assert.equal(bookFormatOf({ spreads: [{}, {}] }), 1);
});

test('page states follow the same rules as the spread state', () => {
  const parsed = spreadSchema.parse({ ...spread, pages: { left, right: { definition: 'textPage' } } });
  // A page keeps its state while the spread shows a spread layout; missing collections default as for a spread.
  assert.deepEqual(parsed.pages, { left, right: { definition: 'textPage', params: {}, boxes: {}, elements: {} } });
  assert.equal(scopeState(parsed), parsed);
  assert.equal(scopeState(parsed, 'left')?.boxes.hero.photo, 'b');
  assert.equal(spreadSchema.safeParse({ ...spread, pages: { left: { ...left, boxes: { hero: { photo: 'b', text: 'c', params: {} } } } } }).success, false);
  // A page without a layout shows ImageFlow's blank page and still keeps its content.
  assert.equal(spreadSchema.parse({ ...spread, pages: { left: { boxes: { hero: { photo: 'b' } } } } }).pages?.left?.definition, undefined);
  assert.equal(spreadSchema.safeParse({ ...spread, split: true }).success, false, 'a spread shown as pages needs a page');
  assert.equal(spreadSchema.parse({ ...spread, pages: { left }, split: true }).split, true);
});

test('content a layout change replaced is set aside with where it came from', () => {
  assert.deepEqual(spreadSchema.parse({ ...spread, displaced }).displaced, displaced);
  // Only content is set aside; a replaced parameter value is simply replaced, as an edit would replace it.
  assert.equal(spreadSchema.safeParse({ ...spread, displaced: [{ from: 'left', box: 'hero', state: { params: { tilt: 2 } } }] }).success, false);
  assert.equal(spreadSchema.safeParse({ ...spread, displaced: [{ from: 'middle', box: 'hero', state: { photo: 'b' } }] }).success, false);
});

test('books with stored page states, replaced content and shown pages open as format 2', () => {
  for (const stored of [{ ...spread, pages: { left } }, { ...spread, displaced }, { ...spread, pages: { left }, split: true }]) {
    assert.equal(unsupportedBookMessage(book([spread, { ...stored, id: 'two' }], 2)), undefined);
    assert.equal(projectSchema.parse(book([stored], 1)).schemaVersion, 2);
  }
  assert.equal(unsupportedBookMessage(book([spread], 2)), undefined);
  assert.match(unsupportedBookMessage(book([spread], 5))!, /book format 5/);
});

test('a newer format than 4 asks for an update', () => {
  const result = projectSchema.safeParse(book([spread], 5));
  assert.equal(result.success, false);
  assert.match(result.error!.issues[0].message, /book format 5; this version reads formats up to 4/);
});

test('saved cover artwork requires format 3 and stays separate from interior layouts', () => {
  const cover = { definition: 'jacket', params: { title: 'Exterior' }, boxes: {}, elements: {} };
  const saved = projectSchema.parse({ ...book([spread], 1), cover });
  assert.equal(saved.schemaVersion, 3);
  assert.deepEqual(saved.cover, cover);
  assert.deepEqual(saved.spreads, [spread]);
  assert.equal(projectSchema.parse({ ...saved, cover: undefined }).schemaVersion, 1);
});

test('a book with pages shown opens unchanged; saving writes the lowest format', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'imageflow-book-format-')));
  const folder = join(root, 'Book');
  try {
    await mkdir(join(folder, 'template'), { recursive: true });
    await writeFile(join(folder, 'template/index.tsx'), 'export default {};\n');
    await writeFile(join(folder, 'photos.json'), '{}');
    const source = JSON.stringify(book([{ ...spread, pages: { left }, split: true }], 2));
    await writeFile(join(folder, 'project.json'), source);
    assert.equal((await loadProject(folder, join(root, 'cache'))).project.spreads[0].split, true);
    assert.equal(await readFile(join(folder, 'project.json'), 'utf8'), source);
    // A format-2 book without page states opens, and saving it writes format 1.
    await writeFile(join(folder, 'project.json'), JSON.stringify(book([spread], 2)));
    const opened = await loadProject(folder, join(root, 'cache'));
    const saved = await updateProject(opened, { project: { ...opened.project, title: 'Saved' }, photoIndex: opened.photoIndex });
    assert.equal(JSON.parse(await readFile(join(folder, 'project.json'), 'utf8')).schemaVersion, 1);
    // Stored page states make it format 2 again.
    const paged = await updateProject(saved, { project: { ...saved.project, spreads: [{ ...saved.project.spreads[0], pages: { left } }] }, photoIndex: saved.photoIndex });
    assert.equal(JSON.parse(await readFile(join(folder, 'project.json'), 'utf8')).schemaVersion, 2);
    // Shown pages save and open too.
    const split = await updateProject(paged, { project: { ...paged.project, spreads: [{ ...paged.project.spreads[0], pages: { left }, split: true }] },
      photoIndex: paged.photoIndex });
    assert.deepEqual((await loadProject(folder, join(root, 'cache'))).project, split.project);
  } finally { await rm(root, { recursive: true }); }
});

// Unknown fields (ADR 0010, guardrail 2): a build that predates an additive field keeps it when it saves the book.
const unknownPage = { ...left, pageNote: 'p', boxes: { hero: { photo: 'b', params: {}, boxNote: 'bx', crops: { photoPage: { centerX: 0.4, centerY: 0.5, zoom: 1.2, cropNote: 1 } } } } };
const withUnknown = () => structuredClone({
  ...book([{ ...spread, spreadNote: 's', boxes: { hero: { photo: 'a', params: {}, boxNote: 'bx' } }, pages: { left: unknownPage }, displaced: [{ ...displaced[0], displacedNote: 'd' }] }], 2),
  bookNote: 'abc', cover: { definition: 'cover', params: {}, boxes: {}, elements: { e: { params: {}, elementNote: 1 } }, coverNote: 'c' },
  template: { id: 't', version: '1', templateNote: 't' },
});

test('unknown keys survive a parse at the book, spread, page, cover, box and element levels', () => {
  const parsed = projectSchema.parse(withUnknown()) as Record<string, any>;
  assert.equal(parsed.bookNote, 'abc');
  assert.equal(parsed.template.templateNote, 't');
  assert.equal(parsed.cover.coverNote, 'c');
  assert.equal(parsed.cover.elements.e.elementNote, 1);
  assert.equal(parsed.spreads[0].spreadNote, 's');
  assert.equal(parsed.spreads[0].boxes.hero.boxNote, 'bx');
  assert.equal(parsed.spreads[0].pages.left.pageNote, 'p');
  assert.equal(parsed.spreads[0].pages.left.boxes.hero.boxNote, 'bx');
  assert.equal(parsed.spreads[0].pages.left.boxes.hero.crops.photoPage.cropNote, 1);
  assert.equal(parsed.spreads[0].displaced[0].displacedNote, 'd');
  // Parsing the parsed book again changes nothing, and the format is still recomputed.
  assert.deepEqual(projectSchema.parse(parsed), parsed);
  assert.equal(parsed.schemaVersion, 3);
});

test('keys that could reach the prototype chain are refused at every level', () => {
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const plant = (target: Record<string, any>) => Object.defineProperty(target, key, { value: { x: 1 }, enumerable: true, configurable: true, writable: true });
    const cases: ((b: any) => void)[] = [
      (b) => plant(b), (b) => plant(b.spreads[0]), (b) => plant(b.spreads[0].pages.left), (b) => plant(b.spreads[0].boxes.hero),
      (b) => plant(b.cover), (b) => plant(b.template), (b) => plant(b.spreads[0].displaced[0].state),
    ];
    for (const apply of cases) {
      const copy = withUnknown();
      apply(copy);
      const result = projectSchema.safeParse(copy);
      assert.equal(result.success, false, key);
      assert.match(result.error!.issues[0].message, /reserved/);
    }
  }
  // JSON.parse makes `__proto__` an own key, which a loose copy would otherwise turn into the result's prototype.
  assert.equal(projectSchema.safeParse(JSON.parse('{"__proto__":{"polluted":true},' + JSON.stringify(withUnknown()).slice(1))).success, false);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test('unknown keys of photos.json entries are kept, reserved ones and capture fields are refused', () => {
  const parsed = photoIndexSchema.parse({ a: { path: 'photos/a.jpg', title: 'T', syncRevision: 4 } }) as Record<string, any>;
  assert.equal(parsed.a.syncRevision, 4);
  assert.equal(photoIndexSchema.safeParse(JSON.parse('{"a":{"path":"p","__proto__":{"x":1}}}')).success, false);
  assert.equal(photoIndexSchema.safeParse({ a: { path: 'p', constructor: 1 } }).success, false);
  assert.equal(photoIndexSchema.safeParse({ a: { path: 'p', captured: { dateTime: '2024-01-01T00:00:00', offset: null } } }).success, false);
  assert.equal(photoIndexSchema.safeParse({ a: { path: 'p', camera: 'x' } }).success, false);
});

test('a newer book format is still refused, unknown keys or not', () => {
  const result = projectSchema.safeParse({ ...withUnknown(), schemaVersion: bookFormatVersion + 1 });
  assert.equal(result.success, false);
  assert.match(result.error!.issues[0].message, /newer version/);
});

const lineage = '3f0c2d5e-8a41-4c3b-9d57-0b1e6a7f2c90';
test('bookId is an optional UUID that parses, survives a round trip and is refused when malformed', () => {
  const parsed = projectSchema.parse({ ...book([spread]), bookId: lineage });
  assert.equal(parsed.bookId, lineage);
  assert.equal(projectSchema.parse(parsed).bookId, lineage);
  assert.equal(projectSchema.parse(book([spread])).bookId, undefined);
  for (const bad of ['', 'not-a-uuid', 7, null, lineage + 'x']) assert.equal(projectSchema.safeParse({ ...book([spread]), bookId: bad }).success, false);
  // Adding it never changes the book format.
  assert.equal(parsed.schemaVersion, 1);
});

test('saves keep a bookId, assign one to a legacy book with its first write, and never write just for it', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'imageflow-book-id-')));
  const folder = join(root, 'Book');
  try {
    await mkdir(join(folder, 'template'), { recursive: true });
    await writeFile(join(folder, 'template/index.tsx'), 'export default {};\n');
    await writeFile(join(folder, 'photos.json'), '{}');
    const saved = async () => JSON.parse(await readFile(join(folder, 'project.json'), 'utf8'));
    await writeFile(join(folder, 'project.json'), JSON.stringify(book([spread])));
    const legacy = await loadProject(folder, join(root, 'cache'));
    assert.equal(legacy.project.bookId, undefined);
    // Nothing changed: nothing is written, so no bookId yet.
    assert.equal(await updateProject(legacy, { project: legacy.project, photoIndex: legacy.photoIndex }), legacy);
    assert.equal((await saved()).bookId, undefined);
    const first = await updateProject(legacy, { project: { ...legacy.project, title: 'One' }, photoIndex: legacy.photoIndex });
    const id = (await saved()).bookId;
    assert.match(id, /^[0-9a-f-]{36}$/);
    assert.equal(first.project.bookId, id);
    // Later edits, including ones built from a snapshot that lacks the field (Undo), keep it.
    const { bookId: _omitted, ...withoutId } = first.project;
    const second = await updateProject(first, { project: { ...withoutId, title: 'Two' }, photoIndex: first.photoIndex });
    assert.equal((await saved()).bookId, id);
    assert.equal(second.project.bookId, id);
    // An edit cannot replace it, and a reload sees the same one.
    await updateProject(second, { project: { ...second.project, title: 'Three', bookId: '11111111-1111-4111-8111-111111111111' }, photoIndex: second.photoIndex });
    assert.equal((await saved()).bookId, id);
    assert.equal((await saved()).title, 'Three');
    assert.equal((await loadProject(folder, join(root, 'cache'))).project.bookId, id);
  } finally { await rm(root, { recursive: true }); }
});

test('unknown keys of a linked text or file reference survive a parse', () => {
  const linked = { path: '/Users/a/note.md', linked: true as const, futureKey: { nested: 1 } };
  const parsed = projectSchema.parse({ ...withUnknown(), texts: { note: linked }, files: { route: { ...linked, path: '/Users/a/r.gpx' } } }) as Record<string, any>;
  assert.deepEqual(parsed.texts.note, linked);
  assert.equal(parsed.files.route.futureKey.nested, 1);
});
