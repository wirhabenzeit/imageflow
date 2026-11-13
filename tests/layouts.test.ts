import assert from 'node:assert/strict';
import { test } from 'node:test';
import { declarationConflicts, describeLayoutChange, discardContent, keptElements, keptOutside, layoutChoices, moveContent, swapContent, planLayoutChange, switchLayout } from '../src/layouts';
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
  assert.equal(describeLayoutChange(change), '2 photos set aside');
  go(spread, 'pair');
  assert.equal(describeLayoutChange(planLayoutChange(spread, 'grid', layouts)), '');
  spread.boxes.body = { text: 't1', params: {} };
  assert.equal(describeLayoutChange(planLayoutChange(spread, 'text', layouts)),
    '2 photos set aside');
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

test('placing kept content moves it, swapping with what the box shows; it does not come back twice', () => {
  const spread = gridSpread();
  spread.boxes.hero.params = { caption: true };
  setPlacement(spread.boxes.third, 'grid', { centerX: .2, centerY: .3, zoom: 2 });
  go(spread, 'pair');
  // Place the kept lower-left photo in the left box: the photo there is kept in its place.
  assert.equal(moveContent(spread, 'third', 'hero'), 'p1');
  assert.deepEqual(spread.boxes.hero, { params: { caption: true }, photo: 'p3', focus: { centerX: .2, centerY: .3 } });
  assert.deepEqual(spread.boxes.third, { params: {}, photo: 'p1' });
  // Into an empty box: a move, not a copy.
  spread.boxes.second = { params: {} };
  moveContent(spread, 'fourth', 'second');
  assert.deepEqual(keptOutside(spread, layouts).map(({ id, source }) => [id, source]), [['third', 'p1']]);
  go(spread, 'grid');
  assert.deepEqual(photos(spread), { hero: 'p3', second: 'p4', third: 'p1', fourth: undefined });
  assert.throws(() => moveContent(spread, 'fourth', 'hero'), /no content saved for box fourth/);
});

test('discarding kept content removes it from the spread only', () => {
  const spread = gridSpread();
  go(spread, 'pair');
  discardContent(spread, 'third');
  assert.deepEqual(keptOutside(spread, layouts).map(({ id }) => id), ['fourth']);
  go(spread, 'grid');
  assert.equal(spread.boxes.third.photo, undefined);
});

test('element settings of other layouts are listed as kept', () => {
  const spread = gridSpread();
  spread.elements = { calendar: { params: { month: '2027-03-01' } }, empty: { params: {} } };
  assert.deepEqual(keptElements(spread, layouts), ['calendar']);
});

test('a placed photo moves to a box on another spread; the two swap, or the source box empties', () => {
  const a = gridSpread();
  const b: SpreadState = { id: 's2', definition: 'pair', params: {}, elements: {}, boxes: { hero: { photo: 'p9', params: { caption: true } } } };
  setPlacement(a.boxes.hero, 'grid', { centerX: .2, centerY: .4, zoom: 2 });
  assert.equal(swapContent(a, 'hero', b, 'hero'), 'p9');
  assert.deepEqual(b.boxes.hero, { params: { caption: true }, photo: 'p1', focus: { centerX: .2, centerY: .4 } });
  assert.deepEqual(a.boxes.hero, { params: {}, photo: 'p9' });
  assert.equal(swapContent(a, 'second', b, 'second'), undefined);
  assert.deepEqual([a.boxes.second, b.boxes.second], [{ params: {} }, { params: {}, photo: 'p2' }]);
});

test('layout families: previews collapse a family with a picker to one, and group the variants of other families', async () => {
  const { familyLayouts, familyProblems, layoutPreviews, pickerFamily } = await import('../src/layouts');
  const grids: Layouts = {
    pair: layout('Pair', { hero: photo('Left'), second: photo('Right') }),
    grid: layout('2×2', { hero: photo('1') }, { family: 'grid', variant: { size: '2x2' } }),
    text: layout('Text', { body: text('Story') }),
    grid9: layout('3×3', { hero: photo('1') }, { family: 'grid', variant: { size: '3x3' } }),
    wide: layout('Wide', {}, { family: 'banner' }),
    closing: layout('Closing', {}, { span: 'left' }),
    narrow: layout('Narrow', {}, { family: 'banner' }),
  };
  const families = { grid: { label: 'Photo grid', picker: {} }, banner: { label: 'Banner' } };
  assert.deepEqual(familyProblems(grids, families), []);
  assert.deepEqual(familyLayouts(grids, 'grid'), ['grid', 'grid9']);
  // The family stands where it first appears: its current variant, else its first. Pickerless families stay expanded.
  assert.deepEqual(layoutPreviews(grids, 'pair', families), ['pair', 'grid', 'text', 'wide', 'narrow']);
  assert.deepEqual(layoutPreviews(grids, 'grid9', families), ['pair', 'grid9', 'text', 'wide', 'narrow']);
  assert.deepEqual(layoutPreviews(grids, 'closing', families), ['closing']);
  // Without declared families, previews are the layout choices as before.
  assert.deepEqual(layoutPreviews(grids, 'pair'), layoutChoices(grids, 'pair'));
  assert.equal(pickerFamily(grids, 'grid9', families), 'grid');
  assert.equal(pickerFamily(grids, 'wide', families), undefined);
  assert.equal(pickerFamily(grids, 'missing', families), undefined);
});

test('switching between family variants follows the ordinary layout rules', () => {
  const variants: Layouts = {
    grid: layout('2×2', { hero: photo('1'), second: photo('2'), third: photo('3'), fourth: photo('4') }, { family: 'grid' }),
    grid9: layout('3×3', Object.fromEntries(['hero', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth']
      .map((id, i) => [id, photo(String(i + 1))])), { family: 'grid' }),
  };
  const spread = gridSpread();
  switchLayout(spread, 'grid9', variants);
  spread.boxes.fifth = { photo: 'p5', params: {} };
  assert.equal(describeLayoutChange(planLayoutChange(spread, 'grid', variants)), '1 photo set aside');
  switchLayout(spread, 'grid', variants);
  assert.deepEqual(keptOutside(spread, variants).map(({ id }) => id), ['fifth']);
  switchLayout(spread, 'grid9', variants);
  assert.deepEqual(keptOutside(spread, variants), []);
  assert.equal(photos(spread).fifth, 'p5');
});
