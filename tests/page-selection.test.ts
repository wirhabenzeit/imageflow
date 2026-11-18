import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pageSelectionRect, pageSelectionSide, pageSideAt, stepPageSelection } from '../src/page-selection';
const sheet = { x: 20, y: 40, width: 200, height: 120 };
test('canvas selection distinguishes halves, labels, single ends and non-facing pages', () => {
  assert.equal(pageSideAt(sheet, { left: 2, right: 3 }, 30, 50), 'left');
  assert.equal(pageSideAt(sheet, { left: 2, right: 3 }, 130, 50), 'right');
  assert.equal(pageSideAt(sheet, { left: 2, right: 3 }, 130, 30), undefined);
  assert.equal(pageSideAt(sheet, { right: 1 }, 30, 50), 'right');
  assert.equal(pageSideAt(sheet, { left: 4 }, 180, 50), 'left');
  assert.equal(pageSideAt(sheet, { number: 1 }, 180, 50), undefined);
  assert.deepEqual(pageSelectionRect(sheet, 'right'), { x: 120, y: 40, width: 100, height: 120 });
  for (const side of [undefined, 'left', 'right'] as const) {
    assert.deepEqual(pageSelectionRect(sheet, pageSelectionSide({ right: 1 }, side)),
      { x: 120, y: 40, width: 100, height: 120 });
    assert.deepEqual(pageSelectionRect(sheet, pageSelectionSide({ left: 4 }, side)),
      { x: 20, y: 40, width: 100, height: 120 });
  }
  assert.equal(pageSelectionSide({ left: 2, right: 3 }), undefined);
  assert.equal(pageSelectionSide({}), undefined);
});
test('arrow selection follows pages through single ends and across sheets', () => {
  const sheets = [{ id: 'open', page: { right: 1 } }, { id: 'middle', page: { left: 2, right: 3 } }, { id: 'close', page: { left: 4 } }];
  assert.deepEqual(stepPageSelection(sheets, { spread: 'open', side: 'right' }, 1), { spread: 'middle', side: 'left' });
  assert.deepEqual(stepPageSelection(sheets, { spread: 'middle', side: 'left' }, 1), { spread: 'middle', side: 'right' });
  assert.deepEqual(stepPageSelection(sheets, { spread: 'middle', side: 'right' }, 1), { spread: 'close', side: 'left' });
  assert.deepEqual(stepPageSelection(sheets, { spread: 'close', side: 'left' }, -1), { spread: 'middle', side: 'right' });
  assert.equal(stepPageSelection(sheets, { spread: 'open', side: 'right' }, -1), undefined);
});

test('arrow navigation ignores a former side after switching to a format without facing pages', () => {
  assert.equal(pageSelectionSide({ number: 1 }, 'right'), undefined);
  assert.equal(pageSelectionSide({ left: 4 }, 'right'), 'left');
  const sheets = [{ id: 'one', page: { number: 1 } }, { id: 'two', page: { number: 2 } }];
  assert.deepEqual(stepPageSelection(sheets, { spread: 'one', side: 'right' }, 1), { spread: 'two' });
  assert.deepEqual(stepPageSelection(sheets, { spread: 'two', side: 'left' }, -1), { spread: 'one' });
});
