import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadProject, updateProject } from '../desktop/project';
import { bookFormatOf, bookFormatVersion, pagesUnsupportedMessage, projectSchema, scopeState, spreadSchema, unsupportedBookMessage } from '../src/project';

// Book format 2 adds page states (ADR 0009). A book is written in the lowest format that holds it. Until phases 2 and
// 3 can handle what format 2 stores, books that use it are refused with a request to update (release gates).

const spread = { id: 'one', definition: 'story', params: {}, boxes: { hero: { photo: 'a', params: {} } }, elements: {} };
const book = (spreads: unknown[], schemaVersion = 1) => ({ schemaVersion, title: 'Pages', template: { id: 't', version: '1' }, spreads });
const left = { definition: 'photoPage', params: { title: 'Left' }, boxes: { hero: { photo: 'b', params: {} } }, elements: {} };
const displaced = [{ from: 'right', box: 'hero', state: { photo: 'b', params: { tilt: 2 }, crops: { photoPage: { centerX: 0.4, centerY: 0.5, zoom: 1.2 } } } }];

test('a book without page states is format 1, whatever it was saved as', () => {
  assert.equal(bookFormatVersion, 2);
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
  assert.equal(spreadSchema.safeParse({ ...spread, pages: { left: { params: {} } } }).success, false, 'a page needs its layout');
  assert.equal(spreadSchema.safeParse({ ...spread, split: true }).success, false, 'a spread shown as pages needs a page');
  assert.equal(spreadSchema.parse({ ...spread, pages: { left }, split: true }).split, true);
});

test('content a layout change replaced is set aside with where it came from', () => {
  assert.deepEqual(spreadSchema.parse({ ...spread, displaced }).displaced, displaced);
  // Only content is set aside; a replaced parameter value is simply replaced, as an edit would replace it.
  assert.equal(spreadSchema.safeParse({ ...spread, displaced: [{ from: 'left', box: 'hero', state: { params: { tilt: 2 } } }] }).success, false);
  assert.equal(spreadSchema.safeParse({ ...spread, displaced: [{ from: 'middle', box: 'hero', state: { photo: 'b' } }] }).success, false);
});

test('books with page states, replaced content or pages shown are refused until this version supports them', () => {
  // Asset usage and source removal do not read page states yet (phase 2), and pages are not drawn yet (phase 3).
  for (const gated of [{ ...spread, pages: { left } }, { ...spread, displaced }, { ...spread, pages: { left }, split: true }]) {
    assert.equal(unsupportedBookMessage(book([spread, { ...gated, id: 'two' }], 2)), pagesUnsupportedMessage);
    const result = projectSchema.safeParse(book([gated], 2));
    assert.equal(result.success, false);
    assert.ok(result.error!.issues.some(({ message }) => message === pagesUnsupportedMessage));
  }
  assert.equal(unsupportedBookMessage(book([spread], 2)), undefined);
  assert.match(unsupportedBookMessage(book([spread], 3))!, /book format 3/);
});

test('a newer format than 2 asks for an update', () => {
  const result = projectSchema.safeParse(book([spread], 3));
  assert.equal(result.success, false);
  assert.match(result.error!.issues[0].message, /book format 3; this version reads formats up to 2/);
});

test('a book with page states is refused on opening and left unchanged; saving writes format 1', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'imageflow-book-format-')));
  const folder = join(root, 'Book');
  try {
    await mkdir(join(folder, 'template'), { recursive: true });
    await writeFile(join(folder, 'template/index.tsx'), 'export default {};\n');
    await writeFile(join(folder, 'photos.json'), '{}');
    const source = JSON.stringify(book([{ ...spread, pages: { left } }], 2));
    await writeFile(join(folder, 'project.json'), source);
    await assert.rejects(loadProject(folder, join(root, 'cache')), (error: Error) => error.message === pagesUnsupportedMessage);
    assert.equal(await readFile(join(folder, 'project.json'), 'utf8'), source);
    // A format-2 book without page states opens, and saving it writes format 1.
    await writeFile(join(folder, 'project.json'), JSON.stringify(book([spread], 2)));
    const opened = await loadProject(folder, join(root, 'cache'));
    await updateProject(opened, { project: { ...opened.project, title: 'Saved' }, photoIndex: opened.photoIndex });
    assert.equal(JSON.parse(await readFile(join(folder, 'project.json'), 'utf8')).schemaVersion, 1);
    // Saving cannot write what this version refuses to open.
    await assert.rejects(updateProject(opened, { project: { ...opened.project, spreads: [{ ...opened.project.spreads[0], pages: { left } }] },
      photoIndex: opened.photoIndex }), /page layouts/);
  } finally { await rm(root, { recursive: true }); }
});
