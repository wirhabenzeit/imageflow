import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blankPage, describeLayoutChange, keptOutside, planLayoutChange, stateLayout, swapPages, switchLayout } from '../src/layouts';
import type { Layout, LayoutTarget, Layouts } from '../src/layouts';
import { p } from '../src/parameters';
import { pageSides, spreadSchema, storedBoxes } from '../src/project';
import type { LayoutState, PageSide, SpreadState, StateLocation } from '../src/project';

// Changing layouts between spreads and pages (ADR 0009 §3 and §4): the worked examples, then random sequences of
// changes on random templates checked against the rules' invariants.

const photo = (label: string) => ({ type: 'photo' as const, label, parameters: {} });
const text = (label: string) => ({ type: 'markdown' as const, label, parameters: {} });
const title = p.string({ label: 'Title', default: '' });
const layout = (label: string, span: Layout['span'], boxes: Layout['boxes'], extra: Partial<Layout> = {}): Layout =>
  ({ label, span, parameters: {}, boxes, elements: {}, ...extra });
const layouts: Layouts = {
  feature: layout('Feature', 'spread', { hero: photo('Hero'), story: text('Story') }, { parameters: { title } }),
  heroSpread: layout('Hero spread', 'spread', { hero: photo('Hero') }, { parameters: { title } }),
  photoPage: layout('Photo page', 'page', { hero: photo('Hero') }, { parameters: { title } }),
  textPage: layout('Text page', 'page', { story: text('Story') }),
};
const empty = { params: {}, boxes: {}, elements: {} };
const go = (spread: SpreadState, target: string | LayoutTarget) => switchLayout(spread, target, layouts);
const shown = (state: LayoutState | undefined, box: string) => state?.boxes[box]?.photo ?? state?.boxes[box]?.text;

test('splitting a spread moves what the page shows; the rest stays on the spread and returns on merging', () => {
  const spread: SpreadState = { id: 's', definition: 'feature', params: { title: 'Summer' }, elements: {},
    boxes: { hero: { photo: 'A', params: {}, crops: { feature: { centerX: .3, centerY: .5, zoom: 2 } }, focus: { centerX: .3, centerY: .5 } }, story: { text: 'S', params: {} } } };
  const before = structuredClone(spread);
  const plan = planLayoutChange(spread, { definition: 'photoPage', page: 'left' }, layouts);
  assert.deepEqual(spread, before, 'planning changes nothing');
  assert.equal(describeLayoutChange(plan), 'Title and Hero move to the left page · Story kept on the spread · right page becomes blank');
  go(spread, { definition: 'photoPage', page: 'left' });
  assert.equal(spread.split, true);
  assert.equal(spread.definition, 'feature', 'the spread remembers its layout');
  assert.deepEqual<SpreadState['pages']>(spread.pages, { left: { definition: 'photoPage', params: { title: 'Summer' }, elements: {},
    boxes: { hero: before.boxes.hero } } });
  assert.deepEqual<SpreadState['boxes']>(spread.boxes, { story: { text: 'S', params: {} } });
  assert.deepEqual(spread.params, {});
  assert.ok(spreadSchema.safeParse(spread).success);

  // The right page takes the story the spread keeps (rule 3).
  go(spread, { definition: 'textPage', page: 'right' });
  assert.equal(shown(spread.pages?.right, 'story'), 'S');
  assert.deepEqual(spread.boxes, {});
  // An edit on a page, then back to the spread layout: all three return, the crop with them.
  spread.pages!.left!.params.title = 'Autumn';
  const merge = go(spread, 'feature');
  assert.equal(describeLayoutChange(merge), 'Title, Hero and Story move to the spread');
  assert.equal(spread.split, undefined);
  assert.equal(spread.params.title, 'Autumn');
  assert.deepEqual(spread.boxes.hero, before.boxes.hero);
  assert.equal(shown(spread, 'story'), 'S');
  assert.deepEqual(spread.pages, { left: { definition: 'photoPage', ...empty }, right: { definition: 'textPage', ...empty } });
});

test('changing one page never touches the facing page', () => {
  const spread: SpreadState = { id: 's', definition: 'feature', split: true, ...empty, boxes: { hero: { photo: 'X', params: {} } },
    pages: { left: { definition: 'textPage', ...empty, boxes: { hero: { photo: 'L', params: {} } } },
      right: { definition: 'photoPage', ...empty, boxes: { hero: { photo: 'B', params: {} } } } } };
  const right = structuredClone(spread.pages!.right);
  // The left page's own memory first.
  go(spread, { definition: 'photoPage', page: 'left' });
  assert.equal(shown(spread.pages?.left, 'hero'), 'L');
  assert.deepEqual(spread.pages?.right, right);
  // Then the spread's.
  delete spread.pages!.left!.boxes.hero;
  go(spread, { definition: 'textPage', page: 'left' });
  go(spread, { definition: 'photoPage', page: 'left' });
  assert.equal(shown(spread.pages?.left, 'hero'), 'X');
  assert.equal(shown(spread, 'hero'), undefined);
  // Otherwise the hero is empty; B stays on the right page.
  go(spread, { definition: 'textPage', page: 'left' });
  spread.pages!.left!.boxes = {};
  go(spread, { definition: 'photoPage', page: 'left' });
  assert.equal(shown(spread.pages?.left, 'hero'), undefined);
  assert.deepEqual(spread.pages?.right, right);
});

test('merging and splitting again: the selected side wins, and a replaced photo is set aside', () => {
  const split = (): SpreadState => ({ id: 's', definition: 'heroSpread', split: true, ...empty,
    pages: { left: { definition: 'photoPage', ...empty, boxes: { hero: { photo: 'A', params: {} } } },
      right: { definition: 'photoPage', ...empty, boxes: { hero: { photo: 'B', params: {} } } } } });
  const spread = split();
  go(spread, { definition: 'heroSpread', side: 'left' });
  assert.equal(shown(spread, 'hero'), 'A');
  assert.equal(shown(spread.pages?.left, 'hero'), undefined);
  assert.equal(shown(spread.pages?.right, 'hero'), 'B', 'not taken, so kept');
  assert.deepEqual(keptOutside(spread, layouts).map(({ source, location }) => [source, location]), [['B', 'right']]);

  // Splitting again from the left: A returns there, B shows from the right page's memory.
  const again = structuredClone(spread);
  go(again, { definition: 'photoPage', page: 'left' });
  assert.equal(shown(again.pages?.left, 'hero'), 'A');
  assert.equal(shown(again.pages?.right, 'hero'), 'B');
  assert.equal(again.displaced, undefined);

  // Instead from the right: A replaces B, which is set aside; the left page's hero is empty.
  const change = planLayoutChange(spread, { definition: 'photoPage', page: 'right' }, layouts);
  assert.equal(describeLayoutChange(change), 'Hero moves to the right page · Hero on the right page replaced');
  go(spread, { definition: 'photoPage', page: 'right' });
  assert.equal(shown(spread.pages?.right, 'hero'), 'A');
  assert.equal(shown(spread.pages?.left, 'hero'), undefined);
  assert.deepEqual(spread.displaced, [{ from: 'right', box: 'hero', state: { photo: 'B', params: {} } }]);
  assert.deepEqual(keptOutside(spread, layouts), [{ id: 'hero', kind: 'photo', source: 'B', location: 'right', replaced: true }]);

  // Merging with the right side selected takes the right page's photo; with none selected, the left page's.
  const right = split();
  go(right, { definition: 'heroSpread', side: 'right' });
  assert.equal(shown(right, 'hero'), 'B');
  const unselected = split();
  go(unselected, 'heroSpread');
  assert.equal(shown(unselected, 'hero'), 'A');
});

test('an emptied box and a reset parameter carry over as empty and default; older values do not come back', () => {
  const spread: SpreadState = { id: 's', definition: 'textPage', split: true, ...empty,
    params: { title: 'Old' }, boxes: { hero: { photo: 'X', params: {} } },
    pages: { left: { definition: 'photoPage', ...empty, params: { title: 'New' }, boxes: { hero: { photo: 'A', params: {} } } },
      right: { definition: 'textPage', ...empty } } };
  spread.pages!.left!.boxes.hero = { params: {} };
  delete spread.pages!.left!.params.title;
  const merge = planLayoutChange(spread, { definition: 'heroSpread', side: 'left' }, layouts);
  assert.equal(describeLayoutChange(merge), 'Hero on the spread replaced');
  go(spread, { definition: 'heroSpread', side: 'left' });
  assert.equal(shown(spread, 'hero'), undefined);
  assert.equal(spread.params.title, undefined, '"Old" is overwritten by the default');
  assert.deepEqual(spread.displaced, [{ from: 'spread', box: 'hero', state: { photo: 'X', params: {} } }]);
  go(spread, { definition: 'photoPage', page: 'right' });
  assert.equal(shown(spread.pages?.right, 'hero'), undefined);
  assert.equal(spread.pages?.right?.params.title, undefined);
  assert.equal(shown(spread.pages?.left, 'hero'), undefined);
  assert.equal(spread.pages?.left?.params.title, undefined);
});

test('the blank page shows nothing and keeps what its page stores', () => {
  const spread: SpreadState = { id: 's', definition: 'heroSpread', ...empty, boxes: { hero: { photo: 'A', params: {} } } };
  go(spread, { page: 'left' });
  assert.equal(stateLayout(layouts, spread.pages?.left?.definition), blankPage);
  assert.equal(shown(spread, 'hero'), 'A', 'kept on the spread: nothing shows it');
  go(spread, { definition: 'photoPage', page: 'right' });
  assert.equal(shown(spread.pages?.right, 'hero'), 'A');
  go(spread, { page: 'right' });
  assert.equal(shown(spread.pages?.right, 'hero'), 'A');
  assert.equal(spread.pages?.right?.definition, undefined);
  assert.ok(spreadSchema.safeParse(spread).success);
  assert.throws(() => planLayoutChange(spread, {}, layouts), /no layout/);
});

test('swapping pages exchanges their states, layouts included', () => {
  const spread: SpreadState = { id: 's', definition: 'feature', split: true, ...empty,
    pages: { left: { definition: 'photoPage', ...empty, boxes: { hero: { photo: 'A', params: {} } } } } };
  swapPages(spread);
  assert.deepEqual(Object.keys(spread.pages!), ['right']);
  assert.equal(shown(spread.pages?.right, 'hero'), 'A');
  assert.throws(() => swapPages({ ...spread, split: undefined }), /shown as pages/);
});

// Random sequences. A seeded generator keeps every failure reproducible.
function random(seed: number) {
  let state = seed >>> 0 || 1;
  const next = () => (state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  return { next, pick: <T,>(items: readonly T[]) => items[Math.floor(next() * items.length)], chance: (p: number) => next() < p };
}
type Random = ReturnType<typeof random>;

// A template whose layouts declare random subsets of a few boxes, parameters and an element, so IDs meet across
// spread and page layouts. Same ID, same type, as the template check requires.
function randomLayouts(rng: Random): Layouts {
  const result: Layouts = {};
  for (const [prefix, span] of [['spread', 'spread'], ['page', 'page']] as const) for (let i = 0; i < 4; i++) {
    const boxes: Layout['boxes'] = {};
    for (const id of ['a', 'b']) if (rng.chance(.6)) boxes[id] = photo(id.toUpperCase());
    if (rng.chance(.4)) boxes.c = text('C');
    const parameters = Object.fromEntries(['x', 'y'].filter(() => rng.chance(.5)).map((id) => [id, p.string({ label: id.toUpperCase(), default: '' })]));
    const elements: Layout['elements'] = rng.chance(.5) ? { e: { label: 'E', parameters: { z: p.string({ label: 'Z', default: '' }) } } } : {};
    result[prefix + i] = layout(prefix + i, span, boxes, { parameters, elements });
  }
  return result;
}

type Unit = { kind: 'box' | 'param' | 'element'; id: string };
const units = (layout: Layout | undefined): Unit[] => !layout ? [] : [
  ...Object.keys(layout.boxes).map((id) => ({ kind: 'box' as const, id })),
  ...Object.keys(layout.parameters).map((id) => ({ kind: 'param' as const, id })),
  ...Object.keys(layout.elements).map((id) => ({ kind: 'element' as const, id })),
];
// What a state shows for an ID: the content token, the parameter value, or undefined for empty and default.
function showing(state: LayoutState | undefined, unit: Unit) {
  if (!state) return undefined;
  if (unit.kind === 'box') return shown(state, unit.id);
  if (unit.kind === 'param') return state.params[unit.id] as string | undefined;
  return state.elements[unit.id]?.params.z as string | undefined;
}
const stateAt = (spread: SpreadState, location: StateLocation) => location === 'spread' ? spread : spread.pages?.[location];
const layoutAt = (spread: SpreadState, location: StateLocation, all: Layouts) =>
  location === 'spread' ? all[spread.definition] : stateLayout(all, spread.pages?.[location]?.definition);
const visible = (spread: SpreadState): StateLocation[] => spread.split ? [...pageSides] : ['spread'];
const contents = (spread: SpreadState) => storedBoxes(spread).flatMap(({ state }) => state.photo ? [state.photo] : state.text ? [state.text] : []).sort();

test('random sequences of changes keep the rules of §3', () => {
  let checked = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const rng = random(seed);
    const all = randomLayouts(rng);
    const spreadLayouts = Object.keys(all).filter((id) => all[id].span === 'spread');
    const pageLayouts = Object.keys(all).filter((id) => all[id].span === 'page');
    let token = 0;
    const spread: SpreadState = { id: 's', definition: rng.pick(spreadLayouts), ...structuredClone(empty) };
    for (let step = 0; step < 40; step++) {
      const where = `seed ${seed}, step ${step}`;
      const roll = rng.next();
      if (roll < .3) {
        // Edits on a visible state: place a new photo or text, empty a box, set or reset a parameter.
        const location = rng.pick(visible(spread));
        const state = stateAt(spread, location);
        const unit = state && rng.pick([...units(layoutAt(spread, location, all)), undefined]);
        if (!state || !unit) continue;
        const value = 't' + ++token;
        if (unit.kind === 'box') {
          if (rng.chance(.5)) state.boxes[unit.id] = { params: state.boxes[unit.id]?.params ?? {}, ...(unit.id === 'c' ? { text: value } : { photo: value }) };
          else if (state.boxes[unit.id]) state.boxes[unit.id] = { params: state.boxes[unit.id].params };
        } else if (unit.kind === 'param') {
          if (rng.chance(.5)) state.params[unit.id] = value; else delete state.params[unit.id];
        } else if (rng.chance(.5)) state.elements.e = { params: { z: value } };
        else delete state.elements.e;
        continue;
      }
      if (roll < .35) {
        if (!spread.split) continue;
        const before = contents(spread);
        const { left, right } = structuredClone(spread.pages!);
        swapPages(spread);
        assert.deepEqual(spread.pages, { ...(right ? { left: right } : {}), ...(left ? { right: left } : {}) }, where);
        assert.deepEqual(contents(spread), before, where);
        continue;
      }
      const side = rng.pick(pageSides);
      const target: LayoutTarget = rng.chance(.4) ? { definition: rng.pick(spreadLayouts), ...(rng.chance(.7) ? { side } : {}) }
        : rng.chance(.1) ? { page: side } : { definition: rng.pick(pageLayouts), page: side };
      const before = structuredClone(spread);
      const plan = planLayoutChange(spread, target, all);
      assert.deepEqual(spread, before, where + ': planning changes nothing');
      assert.deepEqual(planLayoutChange(spread, target, all), plan, where + ': the same change gives the same result');
      const next = plan.spread;
      assert.ok(spreadSchema.safeParse(next).success, where + ': the result is a valid spread');

      // Content is conserved: every photo and text is in exactly one state or among replaced content.
      assert.deepEqual(contents(next), contents(before), where + ': content is conserved');

      // A page that stays visible never changes.
      if (before.split && target.page) {
        const facing = target.page === 'left' ? 'right' : 'left';
        assert.deepEqual(next.pages?.[facing], before.pages?.[facing], where + ': the facing page is unchanged');
      }

      // Rule 1 for the target that takes first: when a replaced layout shows an ID, the target shows what a replaced
      // layout showed, a value if any showed one, and the selected side's when it has one. An emptied box or a reset
      // parameter is therefore never filled from older memory: this is the step that keeps them cleared.
      const first: StateLocation = target.page ?? 'spread';
      const replaced: StateLocation[] = target.page ? [before.split ? target.page : 'spread']
        : before.split ? pageSides.filter((page) => before.pages?.[page]) : ['spread'];
      const selected: PageSide = target.page ?? target.side ?? 'left';
      for (const unit of units(layoutAt(next, first, all))) {
        const sources = replaced.filter((location) => units(layoutAt(before, location, all)).some((item) => item.kind === unit.kind && item.id === unit.id));
        if (!sources.length) {
          // Rules 2 and 3: the target's own memory, then, for a page, what the spread stores.
          const own = showing(stateAt(before, first), unit);
          const expected = own !== undefined || first === 'spread' ? own : showing(before, unit);
          assert.equal(showing(stateAt(next, first), unit), expected, where + ': ' + unit.kind + ' ' + unit.id + ' from memory');
          continue;
        }
        const values = sources.map((location) => ({ location, value: showing(stateAt(before, location), unit) }));
        const after = showing(stateAt(next, first), unit);
        const valued = values.filter(({ value }) => value !== undefined);
        if (!valued.length) assert.equal(after, undefined, where + ': ' + unit.kind + ' ' + unit.id + ' stays empty or default');
        else assert.equal(after, (valued.find(({ location }) => location === selected) ?? valued[0]).value, where + ': ' + unit.kind + ' ' + unit.id);
      }

      // Every shown value was stored before the change; a change never invents one.
      const stored = new Set(JSON.stringify(before).match(/"t\d+"/g) ?? []);
      for (const location of visible(next)) for (const unit of units(layoutAt(next, location, all))) {
        const value = showing(stateAt(next, location), unit);
        if (value !== undefined) assert.ok(stored.has('"' + value + '"'), where + ': ' + value + ' was stored');
      }
      Object.keys(spread).forEach((key) => delete spread[key as keyof SpreadState]);
      Object.assign(spread, next);
      checked++;
    }
  }
  assert.ok(checked > 3000);
});
