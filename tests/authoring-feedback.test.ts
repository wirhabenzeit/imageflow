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

test('a single page on a contact sheet is drawn at the spreads\u2019 scale and leaves no row half empty (API-012)', () => {
  const page = { widthMm: 290, heightMm: 381 }, spread = { widthMm: 580, heightMm: 381 };
  const grid = contactSheetLayout([page, ...Array(11).fill(spread)], 1600, 3);
  const [first, second] = grid.cells;
  assert.ok(second.width > 500, 'spreads use the width of their column: ' + second.width);
  assert.equal(first.height, second.height);
  assert.ok(Math.abs(first.width * 2 - second.width) <= 1);
  assert.ok(grid.cells.every((cell) => cell.label.y - cell.y - cell.height <= 1), 'every cell fills the height of its row');
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

test('detail previews and element inspection accept explicit facing pages without physical-page revisions', () => {
  for (const page of ['left', 'right'] as const) {
    for (const owner of [{ box: 'hero' }, { element: 'map' }]) {
      const preview = { target: { spread: 'one', page, ...owner } };
      assert.doesNotThrow(() => parseMcpArguments('check_book', { project: 'book', preview, inspect: { spread: 'one', page, ...owner } }));
      assert.doesNotThrow(() => parseMcpArguments('inspect_book', { project: 'book', view: 'elements', spread: 'one', page, ...owner }));
      const format = printFormat({ label: 'Facing', trim: { width: mm(100), height: mm(100) }, bleed: mm(0), safe: mm(5),
        ends: 'inside-covers', pageCount: { min: 2, max: 20, step: 2 } });
      assert.equal(artworkTarget([{ id: 'one' }], pageSequence(['spread'], format), parsePreviewRequest(preview).target as typeof preview.target).side, page);
    }
  }
});
