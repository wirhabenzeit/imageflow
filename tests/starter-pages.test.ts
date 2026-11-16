import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { projectSchema, storedBoxes } from '../src/project';
import type { Project } from '../src/project';

const sample = async () => projectSchema.parse(JSON.parse(await readFile('sample/starter/project.json', 'utf8')));
const assignments = (project: Project) => project.spreads.flatMap(spread => storedBoxes(spread).flatMap(({ state }) =>
  state.photo ? ['photo:' + state.photo] : state.text ? ['text:' + state.text] : [])).sort();

test('starter exercises independently editable page pairs with no duplicate hidden assignments', async () => {
  const book = await sample();
  assert.equal(book.schemaVersion, 2);
  assert.equal(book.spreads.length, 17);
  assert.equal(book.spreads.filter(spread => spread.split).length, 11);
  for (const spread of book.spreads.filter(spread => spread.split)) {
    assert.deepEqual(spread.boxes, {});
    assert.deepEqual(spread.params, {});
    assert.ok(spread.pages?.left?.definition);
    assert.ok(spread.pages?.right?.definition);
    assert.equal(spread.definition, spread.pages!.left!.definition,
      'A page pair remembers a declared page design instead of a retired combination spread');
  }
  const contents = book.spreads.find(spread => spread.id === 'contents')!;
  assert.equal(contents.pages!.left!.definition, 'photo');
  assert.equal(contents.pages!.right!.definition, 'contents');
  assert.equal(contents.pages!.left!.boxes.hero.photo, 'peaks');
  const water = book.spreads.find(spread => spread.id === 'water')!;
  assert.equal(water.pages!.left!.boxes.hero.photo, 'shore');
  assert.equal(water.pages!.right!.boxes.hero.photo, 'island');
  const grids = book.spreads.find(spread => spread.id === 'frames')!.pages!.left!;
  assert.equal(grids.definition, 'gridPage9');
  assert.deepEqual(Object.keys(grids.boxes.hero.crops ?? {}), ['gridPage9']);
});

test('starter migration keeps every photo and flowing text assignment from the earlier sample', async () => {
  const current = await sample();
  const earlier = projectSchema.parse(JSON.parse(await readFile('tests/compat/books/starter/project.json', 'utf8')));
  assert.deepEqual(assignments(current), assignments(earlier));
  const previousContentsPhoto = earlier.spreads.find(spread => spread.id === 'contents')!.boxes.hero;
  const contentsPhoto = current.spreads.find(spread => spread.id === 'contents')!.pages!.left!.boxes.hero;
  assert.deepEqual(contentsPhoto.crops?.photo, previousContentsPhoto.crops?.contents,
    'The optional contents photograph keeps its crop under the reusable photo-page layout');
  assert.deepEqual(Object.keys(contentsPhoto.crops ?? {}), ['photo']);
  const notebook = current.spreads.find(spread => spread.id === 'notebook')!;
  assert.equal(notebook.pages!.left!.boxes.body.text, 'notebook');
  assert.equal(notebook.pages!.right!.boxes.body.text, 'notebook');
});
