import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadProject, updateProject } from '../desktop/project';
import { bookFormatOf, bookFormatVersion, pagesUnsupportedMessage, projectSchema, scopeState, spreadSchema, unsupportedBookMessage } from '../src/project';

// Book format 2 adds page states (ADR 0009). A book is written in the lowest format that holds it. Every reference
// consumer reads page states and replaced content (phase 2), so books that store them open; until pages are drawn
// (phase 3), a book with a spread shown as pages is refused with a request to update (release gate).

const spread = { id: 'one', definition: 'story', params: {}, boxes: { hero: { photo: 'a', params: {} } }, elements: {} };
const book = (spreads: unknown[], schemaVersion = 1) => ({ schemaVersion, title: 'Pages', template: { id: 't', version: '1' }, spreads });
const left = { definition: 'photoPage', params: { title: 'Left' }, boxes: { hero: { photo: 'b', params: {} } }, elements: {} };
const displaced = [{ from: 'right', box: 'hero', state: { photo: 'b', params: { tilt: 2 }, crops: { photoPage: { centerX: 0.4, centerY: 0.5, zoom: 1.2 } } } }];

test('a book without page states is format 1, whatever it was saved as', () => {
  assert.equal(bookFormatVersion, 3);
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
  assert.match(unsupportedBookMessage(book([spread], 4))!, /book format 4/);
});

test('a newer format than 3 asks for an update', () => {
  const result = projectSchema.safeParse(book([spread], 4));
  assert.equal(result.success, false);
  assert.match(result.error!.issues[0].message, /book format 4; this version reads formats up to 3/);
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
