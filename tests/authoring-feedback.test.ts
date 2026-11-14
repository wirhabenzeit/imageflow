import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contactSheetLayout } from '../src/authoring-artwork';
import { parseMcpArguments } from '../src/mcp-contract';
import { artworkTarget, parsePreviewRequest, PreviewError } from '../src/preview';
import { mm, pageSequence, printFormat } from '../src/format';

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

test('page previews accept the single-page side through the public MCP contract', () => {
  const preview = { target: { spread: 'cover', side: 'page' } };
  assert.equal((parsePreviewRequest(preview).target as { side: string }).side, 'page');
  assert.doesNotThrow(() => parseMcpArguments('check_book', { project: 'book', preview }));
  assert.throws(() => parsePreviewRequest({ target: { spread: 'cover', side: 'spread' } }));
});

test('requesting a page side in a facing-pages format explains the supported alternatives', () => {
  const format = printFormat({ label: 'Facing pages', trim: { width: mm(100), height: mm(100) },
    bleed: mm(0), safe: mm(5), ends: 'inside-covers', pageCount: { min: 2, max: 20, step: 2 } });
  const spreads = [{ id: 'one' }];
  const sequence = pageSequence(['spread'], format);
  assert.throws(() => artworkTarget(spreads, sequence, { spread: 'one', side: 'page' }),
    (error) => error instanceof PreviewError && error.code === 'preview-target-not-found' &&
      error.message === 'Spread one is in a facing-pages format; use left, right or omit side.');
  assert.equal(artworkTarget(spreads, sequence, { spread: 'one', side: 'left' }).side, 'left');
  assert.equal(artworkTarget(spreads, sequence, { spread: 'one', side: 'right' }).side, 'right');
  assert.equal(artworkTarget(spreads, sequence, { spread: 'one' }).side, 'spread');
});
