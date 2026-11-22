import assert from 'node:assert/strict';
import { test } from 'node:test';
import { proofLayout, proofPhotoPixels, proofPixelRatio, proofSheet } from '../src/proof-sheet';
import { commandState, emptyMenuState } from '../src/commands';
import { presentationPhotoSource } from '../src/presentation-model';

const fits = (layout: ReturnType<typeof proofLayout>, unit: { width: number; height: number }) => {
  const { margin, header, label, gapX, gapY } = proofSheet;
  assert.ok(unit.width * layout.scale <= layout.cell.width + 1e-9);
  assert.ok(unit.height * layout.scale <= layout.cell.height - label + 1e-9);
  assert.ok(layout.columns * layout.cell.width + (layout.columns - 1) * gapX <= layout.page.width - 2 * margin + 1e-9);
  assert.ok(layout.rows * layout.cell.height + (layout.rows - 1) * gapY <= layout.page.height - 2 * margin - header + 1e-9);
};

test('a landscape spread proofs on landscape sheets, one or a grid to a sheet', () => {
  const spread = { width: 420, height: 297 };
  const one = proofLayout(spread, 1);
  assert.deepEqual([one.page.width, one.columns, one.rows], [297, 1, 1]);
  fits(one, spread);
  const four = proofLayout(spread, 4);
  assert.deepEqual([four.columns * four.rows >= 4, four.page.width], [true, 297]);
  fits(four, spread);
  const twelve = proofLayout(spread, 12);
  assert.ok(twelve.columns * twelve.rows >= 12);
  fits(twelve, spread);
  assert.ok(one.scale > four.scale && four.scale > twelve.scale);
});

test('a tall single page proofs on a portrait sheet when that shows it larger', () => {
  const page = { width: 210, height: 297 };
  const one = proofLayout(page, 1);
  assert.equal(one.page.width, 210);
  fits(one, page);
});

test('the grid never leaves a whole column empty', () => {
  for (const perPage of [1, 4, 12]) {
    const layout = proofLayout({ width: 400, height: 200 }, perPage);
    assert.ok(layout.columns * (layout.rows - 1) < perPage, String(perPage));
    assert.ok(Math.ceil(perPage / layout.columns) === layout.rows);
  }
});

test('proof photos and pictures use sizes the editor and presentation already make', () => {
  const pixels = proofPhotoPixels(420, proofLayout({ width: 420, height: 297 }, 1).scale);
  assert.ok(pixels > 1000 && pixels < 2048);
  // Rounded up to the presentation's 512-pixel steps, so one rendition serves both.
  assert.equal(presentationPhotoSource('imageflow://render/x/proof-photo/p1', pixels, false), 'imageflow://render/x/proof-photo/p1/' + Math.ceil(pixels / 512) * 512);
  assert.equal(proofPixelRatio(.2), .5);
  assert.equal(proofPixelRatio(.66), 1);
  assert.equal(proofPixelRatio(2), 2);
});

test('Export Proof needs a rendered book with spreads, not an exportable cover', () => {
  const book = { ...emptyMenuState, document: true, writable: true, canProof: true };
  assert.equal(commandState('export-proof', book).enabled, true);
  assert.equal(commandState('export-proof', { ...book, view: 'cover', canExport: false }).enabled, true, 'a cover that cannot export');
  assert.equal(commandState('export-proof', { ...book, canProof: false }).enabled, false);
  assert.equal(commandState('export-proof', { ...book, busy: true }).enabled, false);
});
