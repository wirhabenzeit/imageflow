import assert from 'node:assert/strict';
import { test } from 'node:test';
import { coverTrimBox, printSpecificationSchema, resolveCover } from '../src/cover';
import { mm, pageSequence, pdfPoints, printFormat, pt } from '../src/format';
import type { PrintSpecification } from '../src/cover';
import type { Span } from '../src/format';

type Wrap = NonNullable<PrintSpecification['cover']>;
const all = (length: ReturnType<typeof mm>) => ({ top: length, right: length, bottom: length, left: length });
const output = { container: 'pdf', colorSpace: 'sRGB', transparency: 'allow' } as const;

const whiteWall = {
  interior: printFormat({
    label: 'WhiteWall Gallery Square on Fuji photo paper',
    trim: { width: mm(290), height: mm(290) }, bleed: { all: mm(3), binding: mm(0) }, safe: mm(5),
    pageCount: { min: 28, max: 112, step: 4 },
  }),
  cover: {
    kind: 'wrap',
    height: mm(296), panels: { back: mm(296), front: mm(296) },
    widths: {
      kind: 'page-bands',
      bands: Array.from({ length: 11 }, (_, i) => {
        const from = 28 + 8 * i;
        return { from, to: from + 4, value: { spine: mm(11 + 1.5 * i) } };
      }),
    },
    outer: { kind: 'wrap', insets: all(mm(10)) },
    safe: { back: all(mm(5)), spine: all(mm(2)), front: all(mm(5)) },
    foldAvoidance: { back: mm(12), front: mm(12) },
    output: { ...output, maximumFileSize: 250_000_000 },
  },
} satisfies { interior: PrintSpecification['interior']; cover: Wrap };

const blurb = {
  interior: printFormat({
    label: 'Blurb Large Square Hardcover Dust Jacket on Premium Matte',
    trim: { width: pt(846), height: pt(846) }, bleed: { all: pt(9), binding: pt(0) },
    safe: { all: pt(18), binding: pt(36) }, pageCount: { min: 20, max: 240, step: 2 },
  }),
  cover: {
    kind: 'wrap',
    height: pt(864), panels: { back: pt(879), front: pt(879) },
    widths: {
      kind: 'page-bands',
      bands: [
        { from: 20, to: 50, spine: 33, flap: 284 },
        { from: 52, to: 100, spine: 41, flap: 280 },
        { from: 102, to: 160, spine: 54, flap: 273 },
        { from: 162, to: 200, spine: 66, flap: 267 },
        { from: 202, to: 240, spine: 79, flap: 261 },
      ].map(({ from, to, spine, flap }) => ({ from, to, value: { spine: pt(spine), flaps: { back: pt(flap), front: pt(flap) } } })),
    },
    outer: { kind: 'bleed', insets: all(pt(9)) },
    safe: { back: all(pt(18)), spine: all(pt(0)), front: all(pt(18)) },
    flaps: { safe: { back: all(pt(18)), front: all(pt(18)) } },
    output,
  },
} satisfies { interior: PrintSpecification['interior']; cover: Wrap };

function interiorSequence(spec: PrintSpecification, spreads: number) {
  return pageSequence(['right', ...Array<Span>(spreads).fill('spread'), 'left'], spec.interior);
}

test('the WhiteWall wrap uses the physical cover panels and grows at the expected interior page count', () => {
  const spec = printSpecificationSchema.parse(whiteWall);
  const first = resolveCover(spec, interiorSequence(spec, 15).count);
  assert.equal(first.status, 'ready');
  assert.equal(first.interiorPages, 32);
  const { sheet, regions, safe, folds, avoid, output } = first.geometry;
  assert.deepEqual(sheet, { x: -10, y: -10, width: 623, height: 316 });
  assert.deepEqual(coverTrimBox(first), { x: 10, y: 10, width: 603, height: 296 });
  assert.deepEqual(Object.keys(regions), ['back', 'spine', 'front']);
  assert.deepEqual(folds, [296, 307]);
  assert.deepEqual(regions.front, { x: 307, y: 0, width: 296, height: 296 });
  assert.deepEqual(safe.spine, { x: 298, y: 2, width: 7, height: 292 });
  assert.deepEqual(avoid, [
    { x: 284, y: 0, width: 12, height: 296 },
    { x: 307, y: 0, width: 12, height: 296 },
  ]);
  assert.equal(output.maximumFileSize, 250_000_000);

  const interim = resolveCover(spec, interiorSequence(spec, 16).count);
  assert.equal(interim.status, 'provisional');
  assert.equal(interim.interiorPages, 34);
  assert.equal(interim.previewPages, 28);
  assert.deepEqual(interim.geometry.sheet, sheet);

  const next = resolveCover(spec, interiorSequence(spec, 17).count);
  assert.equal(next.status, 'ready');
  assert.equal(next.interiorPages, 36);
  assert.equal(next.geometry.regions.spine.width, 12.5);
  assert.deepEqual(next.geometry.sheet, { ...sheet, width: 624.5 });
});

test('the Blurb dust jacket resizes the flaps and preserves calculator rounding in points', () => {
  const spec = printSpecificationSchema.parse(blurb);
  const inPoints = (value: number) => Number(pdfPoints(value).toFixed(9));
  for (const { pages, spine, flap, width } of [
    { pages: 50, spine: 33, flap: 284, width: 2377 },
    { pages: 52, spine: 41, flap: 280, width: 2377 },
    { pages: 102, spine: 54, flap: 273, width: 2376 },
  ]) {
    const sequence = interiorSequence(spec, (pages - 2) / 2);
    assert.equal(sequence.count, pages);
    const result = resolveCover(spec, sequence.count);
    assert.equal(result.status, 'ready');
    const { regions, folds, sheet } = result.geometry;
    assert.deepEqual(Object.keys(regions), ['backFlap', 'back', 'spine', 'front', 'frontFlap']);
    assert.deepEqual(folds.map(inPoints), [flap, flap + 879, flap + 879 + spine, flap + 1758 + spine]);
    assert.equal(inPoints(regions.spine.width), spine);
    assert.equal(inPoints(regions.frontFlap!.width), flap);
    assert.equal(inPoints(regions.backFlap!.width), flap);
    assert.equal(inPoints(sheet.width), width);
    assert.equal(inPoints(sheet.height), 882);
    assert.equal(inPoints(coverTrimBox(result).width), width - 18);
  }
});

test('fixed dimensions still respect the interior page-count rule and allow a narrow spine', () => {
  const spec = printSpecificationSchema.parse({
    ...whiteWall,
    cover: {
      ...whiteWall.cover,
      widths: { kind: 'fixed', value: { spine: mm(4) } },
      outer: { kind: 'wrap', insets: { top: mm(11), right: mm(20), bottom: mm(7), left: mm(3) } },
    },
  });
  const ready = resolveCover(spec, 36);
  assert.equal(ready.status, 'ready');
  assert.equal(ready.geometry.safe.spine, null);
  assert.equal(Object.hasOwn(ready.geometry.safe, 'frontFlap'), false);
  assert.deepEqual(coverTrimBox(ready), { x: 3, y: 7, width: 596, height: 296 });
  for (const count of [0, 34, 36.5, 116]) {
    const result = resolveCover(spec, count);
    assert.equal(result.status, 'provisional');
    assert.equal(result.previewPages, 28);
  }
});

test('a format without a physical cover returns no cover geometry', () => {
  const interior = printFormat({
    label: 'Calendar', facingPages: false, trim: { width: mm(420), height: mm(297) }, bleed: mm(3),
    safe: mm(5), pageCount: { min: 1, max: 100, step: 1 },
  });
  const spec = printSpecificationSchema.parse({ interior });
  assert.deepEqual(resolveCover(spec, pageSequence(Array<Span>(13).fill('page'), interior).count), { status: 'unavailable' });
});

test('cover declarations reject gaps, overlaps, mismatched flap widths, and unprintable sheets', () => {
  const bands = whiteWall.cover.widths.bands;
  const checkBands = (bands: typeof whiteWall.cover.widths.bands, message: RegExp) => {
    const cover = { ...whiteWall.cover, widths: { kind: 'page-bands', bands } };
    assert.throws(() => printSpecificationSchema.parse({ interior: whiteWall.interior, cover }), message);
  };
  checkBands(bands.slice(1), /every permitted interior page count/);
  checkBands(bands.slice(0, -1), /every permitted interior page count/);
  checkBands([bands[0], ...bands.slice(2)], /every permitted interior page count/);
  checkBands([...bands, { ...bands[1], from: bands[0].to }], /bands overlap/);
  checkBands([{ ...bands[0], from: 24 }, ...bands.slice(1)], /within the interior range/);
  checkBands([...bands.slice(0, -1), { ...bands.at(-1)!, value: { spine: mm(400) } }], /10 and 1000 mm/);
  assert.throws(() => printSpecificationSchema.parse({ ...blurb, cover: { ...blurb.cover, flaps: undefined } }), /both flap widths/);
  assert.throws(() => printSpecificationSchema.parse({
    ...blurb,
    cover: { ...blurb.cover, widths: { kind: 'fixed', value: { spine: pt(33) } } },
  }), /both flap widths/);
  assert.throws(() => printSpecificationSchema.parse({
    ...whiteWall, cover: { ...whiteWall.cover, foldAvoidance: { back: mm(297), front: mm(0) } },
  }), /Fold avoidance extends beyond its cover panel/);
});
