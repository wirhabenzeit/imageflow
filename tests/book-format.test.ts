import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadProject, updateProject } from '../desktop/project';
import { bookFormatOf, bookFormatVersion, pagesUnsupportedMessage, projectSchema, scopeState, unsupportedBookMessage } from '../src/project';

// Book format 2 adds page states (ADR 0009). A book is written in the lowest format that holds it.

const spread = { id: 'one', definition: 'story', params: {}, boxes: { hero: { photo: 'a', params: {} } }, elements: {} };
const book = (spreads: unknown[], schemaVersion = 1) => ({ schemaVersion, title: 'Pages', template: { id: 't', version: '1' }, spreads });
const left = { definition: 'photoPage', params: { title: 'Left' }, boxes: { hero: { photo: 'b', params: {} } }, elements: {} };

test('a book without page states is format 1, whatever it was saved as', () => {
  assert.equal(bookFormatVersion, 2);
  assert.equal(projectSchema.parse(book([spread])).schemaVersion, 1);
  // A format-2 book whose page states were all removed goes back to format 1, so older apps can open it again.
  assert.equal(projectSchema.parse(book([spread], 2)).schemaVersion, 1);
});

test('page states make a book format 2 and are kept as saved', () => {
  // A page keeps its state while the spread shows a spread layout.
  const parsed = projectSchema.parse(book([{ ...spread, pages: { left } }]));
  assert.equal(parsed.schemaVersion, 2);
  assert.deepEqual(parsed.spreads[0].pages, { left });
  assert.equal(bookFormatOf({ spreads: [{}, { pages: {} }] }), 2);
  assert.equal(bookFormatOf({ spreads: [{ displaced: [] }] }), 2);
});

test('content a layout change replaced is set aside with where it came from', () => {
  const displaced = [{ from: 'right', box: 'hero', state: { photo: 'b', params: { tilt: 2 }, crops: { photoPage: { centerX: 0.4, centerY: 0.5, zoom: 1.2 } } } }];
  const parsed = projectSchema.parse(book([{ ...spread, displaced }]));
  assert.equal(parsed.schemaVersion, 2);
  assert.deepEqual(parsed.spreads[0].displaced, displaced);
  // Only content is set aside; a replaced parameter value is simply replaced, as an edit would replace it.
  assert.equal(projectSchema.safeParse(book([{ ...spread, displaced: [{ from: 'left', box: 'hero', state: { params: { tilt: 2 } } }] }])).success, false);
  assert.equal(projectSchema.safeParse(book([{ ...spread, displaced: [{ from: 'middle', box: 'hero', state: { photo: 'b' } }] }])).success, false);
});

test('page states follow the same rules as the spread state', () => {
  const parsed = projectSchema.parse(book([{ ...spread, pages: { right: { definition: 'textPage' } } }]));
  // Missing collections default as they do for a spread.
  assert.deepEqual(parsed.spreads[0].pages?.right, { definition: 'textPage', params: {}, boxes: {}, elements: {} });
  const invalid = projectSchema.safeParse(book([{ ...spread, pages: { left: { ...left, boxes: { hero: { photo: 'b', text: 'c', params: {} } } } } }]));
  assert.equal(invalid.success, false);
  assert.equal(projectSchema.safeParse(book([{ ...spread, pages: { left: { params: {} } } }])).success, false, 'a page needs its layout');
  assert.equal(projectSchema.safeParse(book([{ ...spread, pages: { middle: left } }])).success, true, 'unknown sides are dropped like other unknown keys');
});

test('a spread shown as pages is refused until this version can draw pages', () => {
  // Release gate: drawing the remembered spread layout instead would show and export the wrong pages.
  const result = projectSchema.safeParse(book([{ ...spread, pages: { left }, split: true }]));
  assert.equal(result.success, false);
  assert.ok(result.error!.issues.some(({ message }) => message === pagesUnsupportedMessage));
  assert.equal(unsupportedBookMessage(book([{ ...spread, pages: { left }, split: true }], 2)), pagesUnsupportedMessage);
  assert.equal(unsupportedBookMessage(book([{ ...spread, pages: { left } }], 2)), undefined);
  assert.match(unsupportedBookMessage(book([spread], 3))!, /book format 3/);
  // Without page states it is malformed rather than unsupported.
  assert.ok(projectSchema.safeParse(book([{ ...spread, split: true }])).error!.issues.some(({ message }) => /needs the state of at least one page/.test(message)));
});

test('a newer format than 2 asks for an update', () => {
  const result = projectSchema.safeParse(book([spread], 3));
  assert.equal(result.success, false);
  assert.match(result.error!.issues[0].message, /book format 3; this version reads formats up to 2/);
});

test('scopeState finds the state of the spread or of one of its pages', () => {
  const parsed = projectSchema.parse(book([{ ...spread, pages: { left } }])).spreads[0];
  assert.equal(scopeState(parsed), parsed);
  assert.equal(scopeState(parsed, 'left')?.boxes.hero.photo, 'b');
  assert.equal(scopeState(parsed, 'right'), undefined);
});

test('saving writes the lowest format that holds the book, and keeps page states', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'imageflow-book-format-')));
  const folder = join(root, 'Book');
  try {
    await mkdir(join(folder, 'template'), { recursive: true });
    await writeFile(join(folder, 'template/index.tsx'), 'export default {};\n');
    await writeFile(join(folder, 'project.json'), JSON.stringify(book([spread])));
    await writeFile(join(folder, 'photos.json'), '{}');
    const saved = async () => JSON.parse(await readFile(join(folder, 'project.json'), 'utf8'));
    const opened = await loadProject(folder, join(root, 'cache'));
    const split = await updateProject(opened, { project: { ...opened.project, spreads: [{ ...opened.project.spreads[0], pages: { left } }] },
      photoIndex: opened.photoIndex });
    assert.equal((await saved()).schemaVersion, 2);
    assert.deepEqual((await saved()).spreads[0].pages, { left });
    // Opening the format-2 book again reads its page states back.
    const reopened = await loadProject(folder, join(root, 'cache'));
    assert.deepEqual(reopened.project.spreads[0].pages, { left });
    const { pages: _pages, ...merged } = split.project.spreads[0];
    await updateProject(reopened, { project: { ...reopened.project, spreads: [merged] }, photoIndex: reopened.photoIndex });
    assert.equal((await saved()).schemaVersion, 1);
  } finally { await rm(root, { recursive: true }); }
});
