import assert from 'node:assert/strict';
import { test } from 'node:test';
import { declarationConflicts, describeLayoutChange, keptOutside, layoutChoices, planLayoutChange, switchLayout } from '../src/layouts';
import type { Layout, Layouts } from '../src/layouts';
import { p } from '../src/parameters';
import type { Parameters } from '../src/parameters';
import type { SpreadState } from '../src/project';
import { placementIn, setPlacement } from '../src/spread';

const photo = (label: string, parameters: Parameters = {}) => ({ type: 'photo' as const, label, parameters });
const text = (label: string) => ({ type: 'markdown' as const, label, parameters: {} });
const layout = (label: string, boxes: Layout['boxes'], extra: Partial<Layout> = {}): Layout =>
  ({ label, span: 'spread', parameters: {}, boxes, elements: {}, ...extra });
const heading = p.string({ label: 'Heading', default: '', maxLength: 90 });

// A four-photo grid, a two-photo pair and a text spread that shares none of their photo boxes.
const layouts: Layouts = {
  grid: layout('Grid', { hero: photo('Upper left'), second: photo('Upper right'), third: photo('Lower left'), fourth: photo('Lower right') },
    { parameters: { heading } }),
  pair: layout('Pair', { hero: photo('Left'), second: photo('Right') },
    { parameters: { heading: p.string({ label: 'Title', default: '', maxLength: 20 }) } }),
  text: layout('Text', { body: text('Story') }),
  closing: layout('Closing', {}, { span: 'left' }),
};
const gridSpread = (): SpreadState => ({
  id: 's1', definition: 'grid', params: {}, elements: {},
  boxes: { hero: { photo: 'p1', params: {} }, second: { photo: 'p2', params: {} }, third: { photo: 'p3', params: {} }, fourth: { photo: 'p4', params: {} } },
});
const go = (spread: SpreadState, ...targets: string[]) => { for (const target of targets) switchLayout(spread, target, layouts); };
const photos = (spread: SpreadState) => Object.fromEntries(Object.entries(spread.boxes).map(([id, box]) => [id, box.photo]));

test('A → B → A keeps every assignment and the first layout\'s crops', () => {
  const spread = gridSpread();
  setPlacement(spread.boxes.hero, 'grid', { centerX: .3, centerY: .4, zoom: 2 });
  go(spread, 'pair');
  assert.deepEqual(keptOutside(spread, layouts).map(({ id }) => id), ['third', 'fourth']);
  go(spread, 'grid');
  assert.deepEqual(photos(spread), { hero: 'p1', second: 'p2', third: 'p3', fourth: 'p4' });
  assert.deepEqual(placementIn(spread.boxes.hero, 'grid'), { centerX: .3, centerY: .4, zoom: 2 });
});

test('a replacement made in B survives a layout without the box, and the old photo does not return', () => {
  const spread = gridSpread();
  go(spread, 'pair');
  spread.boxes.hero = { params: spread.boxes.hero.params, photo: 'p9' };
  go(spread, 'text', 'grid');
  assert.deepEqual(photos(spread), { hero: 'p9', second: 'p2', third: 'p3', fourth: 'p4' });
});

test('a removal stays removed; visiting a layout without the box removes nothing', () => {
  const spread = gridSpread();
  go(spread, 'pair');
  spread.boxes.second = { params: spread.boxes.second.params };
  go(spread, 'text', 'grid');
  assert.deepEqual(photos(spread), { hero: 'p1', second: undefined, third: 'p3', fourth: 'p4' });
});

test('crops belong to their layout; others fill around the focus, and a new photo starts over', () => {
  const spread = gridSpread();
  setPlacement(spread.boxes.hero, 'grid', { centerX: .2, centerY: .7, zoom: 3 });
  go(spread, 'pair');
  assert.deepEqual(placementIn(spread.boxes.hero, 'pair'), { centerX: .2, centerY: .7, zoom: 1 });
  setPlacement(spread.boxes.hero, 'pair', { centerX: .6, centerY: .5, zoom: 1.5 });
  go(spread, 'grid');
  assert.deepEqual(placementIn(spread.boxes.hero, 'grid'), { centerX: .2, centerY: .7, zoom: 3 });
  assert.deepEqual(placementIn(spread.boxes.hero, 'pair'), { centerX: .6, centerY: .5, zoom: 1.5 });
  // Replacing the photo replaces the box state, crops and focus included.
  spread.boxes.hero = { params: spread.boxes.hero.params, photo: 'p9' };
  assert.deepEqual(placementIn(spread.boxes.hero, 'grid'), { centerX: .5, centerY: .5, zoom: 1 });
  // A centred fill stores nothing and clears the focus.
  setPlacement(spread.boxes.second, 'grid', { centerX: .1, centerY: .1, zoom: 2 });
  setPlacement(spread.boxes.second, 'grid', { centerX: .5, centerY: .5, zoom: 1 });
  assert.deepEqual(spread.boxes.second, { photo: 'p2', params: {} });
});

test('the latest parameter value wins; a rejected value is kept and reported, not cut', () => {
  const spread = gridSpread();
  spread.params.heading = 'Short';
  go(spread, 'text');
  assert.equal(spread.params.heading, 'Short');
  go(spread, 'grid');
  spread.params.heading = 'A heading that is far too long for the pair';
  const change = planLayoutChange(spread, 'pair', layouts);
  assert.deepEqual(change.fallbacks, ['Title']);
  go(spread, 'pair');
  assert.equal(spread.params.heading, 'A heading that is far too long for the pair');
  // Resetting removes the value; nothing can bring an older one back.
  delete spread.params.heading;
  go(spread, 'text', 'grid');
  assert.equal(spread.params.heading, undefined);
});

test('planning describes the switch and changes nothing', () => {
  const spread = gridSpread();
  const before = structuredClone(spread);
  const change = planLayoutChange(spread, 'pair', layouts);
  assert.deepEqual(spread, before);
  assert.deepEqual(change.carried, { photo: 2, text: 0 });
  assert.deepEqual(change.kept, { photo: 2, text: 0 });
  assert.equal(describeLayoutChange(change), '2 photos carried over · 2 photos kept outside this layout');
  go(spread, 'pair');
  assert.equal(describeLayoutChange(planLayoutChange(spread, 'grid', layouts)), '2 photos carried over · 2 photos shown again');
  spread.boxes.body = { text: 't1', params: {} };
  assert.equal(describeLayoutChange(planLayoutChange(spread, 'text', layouts)),
    '1 text shown again · 2 photos kept outside this layout · text will reflow');
  assert.throws(() => planLayoutChange(spread, 'missing', layouts), /no layout missing/);
});

test('only layouts with the same footprint are choices', () => {
  assert.deepEqual(layoutChoices(layouts, 'grid'), ['grid', 'pair', 'text']);
  assert.deepEqual(layoutChoices(layouts, 'closing'), ['closing']);
  assert.deepEqual(layoutChoices(layouts, 'gone'), ['grid', 'pair', 'text', 'closing']);
});

test('an ID keeps its box type and parameter type across layouts; constraints may differ', () => {
  assert.deepEqual(declarationConflicts(layouts), []);
  const conflicting: Layouts = {
    a: layout('A', { hero: photo('Hero', { caption: p.boolean({ label: 'Caption', default: false }) }) },
      { parameters: { heading }, elements: { grid: { label: 'Grid', parameters: { month: p.date({ label: 'Month', default: '2027-01-01' }) } } } }),
    b: layout('B', { hero: text('Hero') }),
    c: layout('C', { hero: photo('Hero', { caption: p.string({ label: 'Caption', default: '' }) }) },
      { parameters: { heading: p.enum({ label: 'Heading', default: 'a', options: ['a'] }) },
        elements: { grid: { label: 'Grid', parameters: { month: p.string({ label: 'Month', default: '' }) } } } }),
  };
  assert.deepEqual(declarationConflicts(conflicting), [
    'Box hero is a photo box in A but a Markdown box in B. A box keeps its type in every layout; use a different ID for a different box.',
    'Parameter heading is a string in A but an enum in C. A parameter keeps its type in every layout; use a different ID for a different parameter.',
    'Parameter caption of box hero is a boolean in A but a string in C. A parameter keeps its type in every layout; use a different ID for a different parameter.',
    'Parameter month of element grid is a date in A but a string in C. A parameter keeps its type in every layout; use a different ID for a different parameter.',
  ]);
});
