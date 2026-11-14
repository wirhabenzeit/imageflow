import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureViewAnchor, restoreViewAnchor } from '../src/view-anchor';
const sheets = [0, 1, 2].map((i) => ({ spread: 's' + i, x: 20, y: 20 + i * 240, width: 400, height: 200 }));

test('format and zoom changes preserve a fractional position in the visible sheet', () => {
  const anchor = captureViewAnchor(sheets, { x: 0, y: 260, width: 440, height: 160 }, 's1')!;
  assert.equal(anchor.spread, 's1');
  assert.equal(anchor.y, .4);
  assert.deepEqual(restoreViewAnchor(anchor, sheets.map((sheet) => ({ ...sheet, y: sheet.y * 2, height: sheet.height * 2 })), { width: 440, height: 160 }),
    { left: 0, top: 600 });
});
test('a selection outside the viewport does not pull the user away from the visible spread', () => {
  assert.equal(captureViewAnchor(sheets, { x: 0, y: 260, width: 440, height: 160 }, 's0')!.spread, 's1');
});
test('removed spreads fall back to the page number after a format restructures the book', () => {
  const anchor = captureViewAnchor(sheets, { x: 0, y: 260, width: 440, height: 160 }, 's1', { s1: 3 })!;
  const replacements = [{ ...sheets[1], spread: 'new' }];
  assert.deepEqual(restoreViewAnchor(anchor, replacements, { width: 440, height: 160 }, { new: [2, 3] }), { left: 0, top: 260 });
  assert.equal(restoreViewAnchor(anchor, [], { width: 440, height: 160 }), undefined);
});
test('panel height changes retain the anchor at the same relative place in the viewport', () => {
  const anchor = captureViewAnchor(sheets, { x: 0, y: 260, width: 440, height: 160 })!;
  assert.deepEqual(restoreViewAnchor(anchor, sheets, { width: 440, height: 80 }), { left: 0, top: 300 });
});
