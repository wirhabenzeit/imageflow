import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canSwapPages, editableSpread, discardKeptContent, keptItems, placeKeptContent, shownContentTargets } from '../src/page-editor';
import type { Layouts } from '../src/layouts';
import { spreadSchema } from '../src/project';

const layouts: Layouts = {
  full: { label: 'Full', span: 'spread', parameters: {}, boxes: { hero: { label: 'Hero', type: 'photo', parameters: {} } }, elements: {} },
  page: { label: 'Page', span: 'page', parameters: {}, boxes: { hero: { label: 'Hero', type: 'photo', parameters: {} }, story: { label: 'Story', type: 'markdown', parameters: {} } }, elements: {} },
  restricted: { label: 'Left', span: 'page', sides: ['left'], parameters: {}, boxes: {}, elements: {} },
};
const sheet = () => spreadSchema.parse({ id: 'pair', definition: 'full', split: true,
  boxes: { hero: { photo: 'spread-photo', params: { fit: true } } }, pages: {
    left: { definition: 'page', boxes: { hero: { photo: 'left-photo' }, old: { photo: 'kept-photo' } } },
    right: { definition: 'page', boxes: { hero: { photo: 'right-photo' } } },
  }, displaced: [
    { from: 'left', box: 'hero', state: { photo: 'replaced-1' } },
    { from: 'left', box: 'hero', state: { photo: 'replaced-2' } },
  ] });

test('kept entries distinguish identical replaced IDs and all locations', () => {
  const kept = keptItems(sheet(), layouts);
  assert.deepEqual(kept.map(({ id, location, source, displaced }) => [id, location, source, displaced]), [
    ['hero', 'spread', 'spread-photo', undefined], ['old', 'left', 'kept-photo', undefined],
    ['hero', 'left', 'replaced-1', 0], ['hero', 'left', 'replaced-2', 1],
  ]);
  assert.deepEqual(shownContentTargets(sheet(), layouts, 'photo').map(({ box, page }) => [box, page]), [['hero', 'left'], ['hero', 'right']]);
  assert.deepEqual(shownContentTargets(sheet(), layouts, 'text').map(({ box, page }) => [box, page]), [['story', 'left'], ['story', 'right']]);
});

test('placing remembered content swaps only selected source and destination, resets crops and retains parameters', () => {
  const input = sheet();
  input.pages!.right!.boxes.hero.params = { caption: true };
  input.pages!.right!.boxes.hero.crops = { page: { zoom: 2, centerX: .4, centerY: .6 } };
  const beforeLeft = structuredClone(input.pages!.left);
  const item = keptItems(input, layouts)[0];
  assert.equal(placeKeptContent(input, item, { box: 'hero', page: 'right' }), 'right-photo');
  assert.deepEqual(input.pages!.left, beforeLeft);
  assert.deepEqual(input.boxes.hero, { params: { fit: true }, photo: 'right-photo' });
  assert.deepEqual(input.pages!.right!.boxes.hero, { params: { caption: true }, photo: 'spread-photo' });
});

test('placing a replaced item into an occupied box keeps its occupant replaced with provenance', () => {
  const input = sheet();
  const item = keptItems(input, layouts).find(({ displaced }) => displaced === 1)!;
  assert.equal(placeKeptContent(input, item, { box: 'hero', page: 'right' }), 'right-photo');
  assert.equal(input.pages!.right!.boxes.hero.photo, 'replaced-2');
  assert.deepEqual(input.displaced!.map(({ from, box, state }) => [from, box, state.photo]), [
    ['left', 'hero', 'replaced-1'], ['right', 'hero', 'right-photo'],
  ]);
});

test('placing replaced content in an empty box removes just that replacement; discard rejects stale identities', () => {
  const input = sheet();
  delete input.pages!.right!.boxes.hero.photo;
  const item = keptItems(input, layouts).find(({ displaced }) => displaced === 0)!;
  placeKeptContent(input, item, { box: 'hero', page: 'right' });
  assert.equal(input.pages!.right!.boxes.hero.photo, 'replaced-1');
  assert.deepEqual(input.displaced!.map(({ state }) => state.photo), ['replaced-2']);
  const snapshot = structuredClone(input);
  assert.equal(discardKeptContent(input, item), false);
  assert.deepEqual(input, snapshot);
  const remaining = keptItems(input, layouts).find(({ displaced }) => displaced === 0)!;
  assert.equal(discardKeptContent(input, remaining), true);
  assert.equal(input.displaced, undefined);
});

test('discarding remembered content touches its precise state and leaves box settings', () => {
  const input = sheet();
  const item = keptItems(input, layouts).find(({ location, replaced }) => location === 'spread' && !replaced)!;
  assert.equal(discardKeptContent(input, item), true);
  assert.deepEqual(input.boxes.hero, { params: { fit: true } });
  assert.equal(input.pages!.left!.boxes.hero.photo, 'left-photo');
  assert.equal(input.displaced!.length, 2);
});

test('page swap eligibility includes restrictions, missing layouts, and blank sides', () => {
  const input = sheet();
  assert.equal(canSwapPages(input, layouts), true);
  input.pages!.left!.definition = 'restricted';
  assert.equal(canSwapPages(input, layouts), false);
  input.pages!.left!.definition = 'missing';
  assert.equal(canSwapPages(input, layouts), false);
  delete input.pages!.left;
  assert.equal(canSwapPages(input, layouts), true);
  delete input.split;
  assert.equal(canSwapPages(input, layouts), false);
});

test('queued canvas edits cannot write a page or spread that became hidden', () => {
  const input = sheet();
  assert.equal(editableSpread(input), undefined);
  assert.equal(editableSpread(input, 'right')?.definition, 'page');
  delete input.split;
  assert.equal(editableSpread(input, 'right'), undefined);
  assert.equal(editableSpread(input)?.definition, 'full');
});
