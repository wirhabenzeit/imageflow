import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contactSheetLayout } from '../src/authoring-artwork';
import { parseMcpArguments } from '../src/mcp-contract';
import { parsePreviewRequest } from '../src/preview';

test('contact sheets stay bounded for all grid sizes, narrow pages and minimum resolution', () => {
  for (const count of [1, 2, 3, 7, 12]) for (const columns of [1, 2, 3, 4]) for (const maxEdge of [128, 1000, 1600]) {
    const sizes = Array.from({ length: count }, (_, i) => ({ widthMm: i % 2 ? 1 : 600, heightMm: i % 2 ? 600 : 1 }));
    const grid = contactSheetLayout(sizes, maxEdge, columns);
    assert.ok(grid.width > 0 && grid.width <= maxEdge && grid.height > 0 && grid.height <= maxEdge);
    for (const cell of grid.cells) {
      assert.ok(cell.width > 0 && cell.height > 0 && cell.x >= 0 && cell.y >= 0);
      assert.ok(cell.x + cell.width <= grid.width && cell.y + cell.height <= grid.height);
      assert.ok(cell.label.y + cell.label.height <= grid.height);
      assert.ok(cell.y + cell.height <= cell.label.y);
    }
  }
});

test('feedback contracts bound targets and require drafts for aliases everywhere', () => {
  const project = 'handle', expectedRevision = 'a'.repeat(64);
  assert.throws(() => parsePreviewRequest({ target: { spreads: Array(13).fill('one') } }));
  assert.throws(() => parsePreviewRequest({ target: { spreads: ['one'] }, maxEdge: 127 }));
  assert.throws(() => parsePreviewRequest({ target: { spread: 'one', box: 'hero', element: 'caption' } }));
  assert.throws(() => parsePreviewRequest({ target: { spread: 'one', box: 'hero', paddingMm: 100 } }));
  for (const extra of [{ preview: { target: { spreads: ['$new'] } } }, { inspect: { spread: '$new' } }]) {
    assert.throws(() => parseMcpArguments('check_book', { project, ...extra }), /Batch references/);
    assert.doesNotThrow(() => parseMcpArguments('check_book', { project, expectedRevision, ...extra,
      draft: { operations: [{ op: 'insert_spread', definition: 'chapter', ref: 'new' }] } }));
  }
  assert.throws(() => parseMcpArguments('inspect_book', { project, view: 'elements' }), /spread/);
  assert.throws(() => parseMcpArguments('inspect_book', { project, view: 'sources', box: 'hero' }), /elements view/);
  assert.doesNotThrow(() => parseMcpArguments('check_book', { project, typescript: true,
    preview: { target: { spread: 'one', element: 'caption' } }, inspect: { spread: 'one', element: 'caption' } }));
});
