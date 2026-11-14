import assert from 'node:assert/strict';
import { test } from 'node:test';
import { presentationUnits, presentationPage } from '../src/presentation-model';
import { commandState, emptyMenuState } from '../src/commands';
import { mm, printFormat } from '../src/format';
import { chooseFormat, templateInfo, templateSchema } from '../src/template';
import { newSpread } from '../src/editing';
const base = { label: 'F', trim: { width: mm(100), height: mm(120) }, bleed: mm(3), safe: mm(5), pageCount: { min: 2, max: 100, step: 2 as const } };
const template = (format: ReturnType<typeof printFormat>) => templateInfo(chooseFormat(templateSchema.parse({ id: 't', version: '1', contract: 1, format,
  spreads: { full: { label: 'Full', span: 'spread', render: () => null }, cover: { label: 'Cover', span: 'right', render: () => null }, back: { label: 'Back', span: 'left', render: () => null }, page: { label: 'Page', span: 'page', render: () => null } } })));

test('presentation centres single covers and keeps spreads together regardless of PDF delivery', () => {
  const book = template(printFormat({ ...base, ends: 'single-pages' }));
  const spreads = [newSpread('cover'), newSpread('full'), newSpread('back')];
  assert.deepEqual(presentationUnits(spreads, book).map(({ side, pages }) => [side, pages]), [['right', [1]], ['spread', [2, 3]], ['left', [4]]]);
  const pages = presentationUnits(spreads, book, true);
  assert.deepEqual(pages.map(({ side, pages }) => [side, pages]), [['right', [1]], ['left', [2]], ['right', [3]], ['left', [4]]]);
  assert.equal(presentationPage(pages, 3), 2);
  assert.equal(presentationPage(pages, 99), -1);
});
test('without facing pages, the F option cannot split a page', () => {
  const book = template(printFormat({ ...base, facingPages: false }));
  const spreads = [newSpread('page'), newSpread('page')];
  assert.deepEqual(presentationUnits(spreads, book, true), presentationUnits(spreads, book));
  assert.deepEqual(presentationUnits(spreads, book).map(({ pages }) => pages), [[1], [2]]);
});
test('presentation is available read-only and its typing shortcuts are not registered globally', () => {
  for (const id of ['presentation', 'presentation-start'] as const) {
    const state = commandState(id, { ...emptyMenuState, document: true, writable: false });
    assert.equal(state.enabled, true);
    assert.equal(state.registerAccelerator, false);
  }
  assert.equal(commandState('delete-spread', emptyMenuState).registerAccelerator, false);
});

test('inside-cover delivery keeps its spread intact, and an empty book has no presentation units', () => {
  const book = template(printFormat({ ...base, ends: 'inside-covers', delivery: 'spreads' }));
  assert.deepEqual(presentationUnits([newSpread('full')], book).map(({ side, pages }) => [side, pages]), [['spread', [1, 2]]]);
  assert.deepEqual(presentationUnits([], book), []);
});
