import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mm, resolveFormat } from '../src/format';
import type { PrintFormat } from '../src/format';
import { geometry } from '../src/geometry';
import { capabilities, runtimeExports } from '../src/runtime-exports';
import { box, issue, runtime, templateIssueSchema, templateSchema } from '../src/template';

// Asymmetric insets and a binding bleed, so a helper that mirrors or ignores them fails.
const format = resolveFormat({
  label: 'Asymmetric', trim: { width: mm(200), height: mm(150) },
  bleed: { top: mm(3), bottom: mm(5), outside: mm(4), binding: mm(2) },
  safe: { top: mm(10), bottom: mm(12), outside: mm(8), binding: mm(15) },
  structure: { delivery: 'pages', ends: 'single-pages', pageCount: { min: 2, max: 20, step: 2 } },
  output: { container: 'pdf', colorSpace: 'sRGB', transparency: 'allow' },
} as PrintFormat);

test('page and spread areas follow trim, asymmetric safe insets and outer bleed', () => {
  assert.deepEqual(geometry.page(format, 'left'), { x: 0, y: 0, width: 200, height: 150 });
  assert.deepEqual(geometry.page(format, 'right'), { x: 200, y: 0, width: 200, height: 150 });
  // Safe insets mirror: outside on the left page's left edge, binding next to the fold.
  assert.deepEqual(geometry.page(format, 'left', 'safe'), { x: 8, y: 10, width: 177, height: 128 });
  assert.deepEqual(geometry.page(format, 'right', 'safe'), { x: 215, y: 10, width: 177, height: 128 });
  // Bleed extends the outer edges only; the binding bleed shows the facing page.
  assert.deepEqual(geometry.page(format, 'left', 'bleed'), { x: -4, y: -3, width: 204, height: 158 });
  assert.deepEqual(geometry.page(format, 'right', 'bleed'), { x: 200, y: -3, width: 204, height: 158 });
  assert.deepEqual(geometry.spread(format), { x: 0, y: 0, width: 400, height: 150 });
  assert.deepEqual(geometry.spread(format, 'safe'), { x: 8, y: 10, width: 384, height: 128 });
  assert.deepEqual(geometry.spread(format, 'bleed'), { x: -4, y: -3, width: 408, height: 158 });
  assert.equal(geometry.spread(format, 'bleed').width, format.spreadWidth);
});

test('insets, grids and design coordinates are explicit millimetre arithmetic', () => {
  const area = { x: 10, y: 20, width: 100, height: 60 };
  assert.deepEqual(geometry.inset(area, 5), { x: 15, y: 25, width: 90, height: 50 });
  assert.deepEqual(geometry.inset(area, { left: 10, bottom: 20 }), { x: 20, y: 20, width: 90, height: 40 });
  const cells = geometry.grid(area, { columns: 3, rows: 2, columnGap: 5, rowGap: 10 });
  assert.equal(cells.length, 6);
  assert.deepEqual(cells[0], { x: 10, y: 20, width: 30, height: 25 });
  assert.deepEqual(cells[4], { x: 45, y: 55, width: 30, height: 25 });
  assert.deepEqual(geometry.grid(area, { columns: 2, gap: 10 }).map(({ x, width, height }) => [x, width, height]), [[10, 45, 60], [65, 45, 60]]);
  // A 100 × 100 design canvas on a 200 × 150 trim: x scales by 2, y by 1.5; the right page starts at the trim width.
  const design = geometry.design(format, { width: 100, height: 100 });
  assert.deepEqual(design.left(10, 10, 50, 20), { x: 20, y: 15, width: 100, height: 30 });
  assert.deepEqual(design.right(10, 10, 50, 20), { x: 220, y: 15, width: 100, height: 30 });
  assert.equal(design.width(5), 10);
  assert.equal(design.height(4), 6);
  assert.deepEqual(geometry.css({ x: -4, y: 2.5, width: 10, height: 20 }), { position: 'absolute', left: '-4mm', top: '2.5mm', width: '10mm', height: '20mm' });
});

test('box helpers keep IDs at the declaration and issue() encodes a structured finding', () => {
  assert.deepEqual(box.photo('Hero'), { type: 'photo', label: 'Hero', parameters: {} });
  assert.deepEqual(box.markdown('Story', { flowOrder: 2 }), { type: 'markdown', label: 'Story', parameters: {}, flowOrder: 2 });
  const attributes = issue({ code: 'gpx-invalid', message: 'Bad track.', element: 'route', parameter: 'track', file: 'fl-1', details: { line: 3 } });
  assert.equal(attributes['data-issue'], 'Bad track.');
  assert.deepEqual(templateIssueSchema.parse(JSON.parse(attributes['data-issue-info'])),
    { code: 'gpx-invalid', message: 'Bad track.', severity: 'warning', element: 'route', parameter: 'track', file: 'fl-1', details: { line: 3 } });
  assert.equal(templateIssueSchema.safeParse({ code: 'Not A Code', message: 'x' }).success, false);
});

test('the runtime exports exactly the listed helpers and checks a template\'s required capabilities', () => {
  assert.deepEqual(Object.keys(runtime).sort(), [...runtimeExports].sort());
  const template = (requires?: string[]) => ({
    id: 'needs', version: '1', contract: 1, ...(requires ? { requires } : {}), parameters: {},
    format: { label: 'F', trim: { width: mm(100), height: mm(100) },
      bleed: { top: mm(0), bottom: mm(0), outside: mm(0), binding: mm(0) }, safe: { top: mm(5), bottom: mm(5), outside: mm(5), binding: mm(5) },
      structure: { delivery: 'pages', ends: 'inside-covers', pageCount: { min: 2, max: 20, step: 2 } },
      output: { container: 'pdf', colorSpace: 'sRGB', transparency: 'allow' } },
    spreads: { main: { label: 'Main', render: () => null } },
  });
  assert.ok(templateSchema.safeParse(template()).success);
  assert.ok(templateSchema.safeParse(template([...capabilities])).success);
  const missing = templateSchema.safeParse(template(['anchors', 'teleport', 'time-travel']));
  assert.equal(missing.success, false);
  assert.match(missing.error!.issues[0].message, /does not provide: teleport, time-travel\. Update ImageFlow/);
});
