import assert from 'node:assert/strict';
import { test } from 'node:test';
import { countResolution, estimatedPrint, inspectionPrints, mergeResolution, newResolution, renderedPrint } from '../src/photo-resolution';

test('the photos of a render are counted with the one that prints at the fewest pixels', () => {
  const found = newResolution(180);
  countResolution(found, 300.4, { spread: 'a', box: 'hero', source: 'p1' });
  countResolution(found, 190.6, { spread: 'b', page: 'left', box: 'hero', source: 'p2' });
  countResolution(found, undefined, { spread: 'c', box: 'hero', source: 'p3' });
  countResolution(found, NaN, { spread: 'c', box: 'side', source: 'p4' });
  assert.deepEqual(found, { minimumPpi: 180, measured: 2, notMeasured: 2, lowest: { ppi: 191, spread: 'b', page: 'left', box: 'hero', source: 'p2' } });
  const cover = newResolution(undefined);
  assert.deepEqual(cover, { minimumPpi: null, measured: 0, notMeasured: 0 });
  countResolution(cover, 150, { cover: true, box: 'front', source: 'p1' });
  assert.deepEqual(mergeResolution(found, cover), { minimumPpi: 180, measured: 3, notMeasured: 2, lowest: { ppi: 150, cover: true, box: 'front', source: 'p1' } });
  assert.deepEqual(mergeResolution(undefined, cover), cover);
  assert.deepEqual(mergeResolution(found, undefined), found);
});

test('an inspected photo box gives its pixels and ppi, measured by the render or estimated from its size (API-021, 26 Nov)', () => {
  const placement = { centerX: 0.5, centerY: 0.5, zoom: 1 };
  // A 3:2 photo filling a 254 × 127 mm (10 × 5 in) box.
  const box = { width: 254, height: 127 };
  // Drawn: the render's measurement, by the original's size.
  assert.deepEqual(renderedPrint('301.6', { width: 6000, height: 4000 }, placement, box), { widthPx: 6000, heightPx: 4000, ppi: 302, measured: true });
  // Not measured: the crop and the box's own size go along for an estimate.
  const pending = renderedPrint(undefined, undefined, placement, box);
  assert.deepEqual(pending, { ppi: null, measured: false, placement, boxMm: box });
  // The crop is the photo's full width, 6000 px over 10 in.
  assert.deepEqual(estimatedPrint(pending, { width: 6000, height: 4000 }), { widthPx: 6000, heightPx: 4000, ppi: 600, measured: false });
  // Zoomed in twice: half the pixels across the same box.
  assert.equal(estimatedPrint(renderedPrint(undefined, undefined, { ...placement, zoom: 2 }, box), { width: 6000, height: 4000 }).ppi, 300);
  assert.deepEqual(estimatedPrint(pending, undefined), { ppi: null, measured: false });

  const inspection = { spread: 'a', items: [
    { id: 'hero', kind: 'photo', source: 'p1', boundsMm: box, print: renderedPrint('250', { width: 3000, height: 2000 }, placement, box) },
    { id: 'side', kind: 'photo', source: 'p2', boundsMm: box, print: pending },
    // Turned a quarter: its bounds on the sheet are 127 × 254 mm, but the photo fills the box's own 254 × 127 mm.
    { id: 'turned', kind: 'photo', source: 'p2', boundsMm: { width: 127, height: 254 }, print: pending },
    { id: 'empty', kind: 'photo', boundsMm: box },
    { id: 'body', kind: 'markdown', source: 't1', boundsMm: box },
  ] };
  const asked: string[] = [];
  const replied = inspectionPrints(inspection, (id) => { asked.push(id); return id === 'p2' ? { width: 6000, height: 4000 } : undefined; });
  assert.deepEqual(asked, ['p2', 'p2'], 'only an unmeasured photo is looked up');
  assert.deepEqual(replied.items.map(({ print }) => print), [
    { widthPx: 3000, heightPx: 2000, ppi: 250, measured: true },
    { widthPx: 6000, heightPx: 4000, ppi: 600, measured: false },
    { widthPx: 6000, heightPx: 4000, ppi: 600, measured: false },
    undefined, undefined,
  ]);
  assert.equal(/placement|boxMm/.test(JSON.stringify(replied)), false, 'what the estimate uses is not part of the reply');
});
