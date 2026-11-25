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
test('a selected spread at the edge does not displace the canvas center during resizing', () => {
  const anchor = captureViewAnchor(sheets, { x: 0, y: 190, width: 440, height: 400 }, 's0')!;
  assert.equal(anchor.spread, 's1');
  assert.equal(anchor.viewportY, .5);
  assert.equal(anchor.y, .65);
  assert.deepEqual(restoreViewAnchor(anchor, sheets, { width: 440, height: 200 }), { left: 0, top: 290 });
});

test('pinch retains the point under the pointer instead of the viewport centre', () => {
  const anchor = captureViewAnchor(sheets, { x: 0, y: 260, width: 440, height: 160 }, 's1', {}, { x: 120, y: 300 })!;
  assert.equal(anchor.x, .25);
  assert.equal(anchor.y, .2);
  const restored = restoreViewAnchor(anchor, sheets.map(sheet => ({ ...sheet, width: sheet.width * 2, height: sheet.height * 2 })),
    { width: 440, height: 160 })!;
  assert.ok(Math.abs(restored.left - 100) < 1e-8);
  assert.ok(Math.abs(restored.top - 300) < 1e-8);
});

test('an anchor taken at the pointer stays under it when a scrollbar makes the viewport smaller', () => {
  const sheet = (zoom: number) => [{ spread: 'a', x: 0, y: 100 * zoom, width: 400 * zoom, height: 200 * zoom }] as never;
  const viewport = { x: 0, y: 50, width: 489, height: 394 };
  const pointer = captureViewAnchor(sheet(1), viewport, undefined, {}, { x: 277, y: 174 })!;
  const position = restoreViewAnchor(pointer, sheet(2), { width: 489, height: 379 })!;
  // The point of the sheet that was under the pointer, 277 and 124 px into the viewport, still is.
  assert.deepEqual([277 * 2 - position.left, 100 * 2 + 74 * 2 - position.top], [277, 124]);
  // Without a pointer it keeps its share of the viewport, as when a panel is resized.
  const centre = captureViewAnchor(sheet(1), viewport)!;
  assert.equal(centre.pointer, undefined);
  assert.equal(restoreViewAnchor(centre, sheet(1), { width: 489, height: 200 })!.top - restoreViewAnchor(centre, sheet(1), { width: 489, height: 394 })!.top, 97);
});
