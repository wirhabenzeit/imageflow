import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { printSpecificationSchema, resolveCover } from '../src/cover';
import type { CoverFormat, PrintSpecification } from '../src/cover';
import type { FacingFormat } from '../src/format';

// The Photobook starter's print presets are template code: they import `imageflow`, which only the renderer provides.
// Bundle them against the app's own `mm`, `pt` and `printFormat`, then check every preset against the raw printer
// measurements in spikes/cover-sizing rather than against numbers copied from the presets.
type Preset = { format: FacingFormat; coverFormat: CoverFormat; researched: string; sources: string[] };
type Presets = {
  whiteWallGallerySquare(options: { paper: WhiteWallPaper }): Preset;
  blurbLargeSquare(options: { paper: BlurbPaper; cover: 'imageWrap' | 'dustJacket' }): Preset;
};
async function loadPresets(): Promise<Presets> {
  const folder = await mkdtemp(join(tmpdir(), 'imageflow-presets-'));
  try {
    const outfile = join(folder, 'print-presets.mjs');
    await build({
      entryPoints: [resolve('sample/starter/template/print-presets.ts')], outfile, bundle: true, platform: 'node',
      format: 'esm', logLevel: 'silent', alias: { imageflow: resolve('src/format.ts') },
    });
    return await import(pathToFileURL(outfile).href);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}
const presets = loadPresets();
const spike = async (name: string) => JSON.parse(await readFile(resolve('spikes/cover-sizing', name), 'utf8'));

const whiteWallPapers = {
  'paper-fujiCrystal-glossy': 'fujiCrystalArchive', 'paper-fujiCrystal-semi-matte': 'fujiCrystalArchive',
  'paper-fujiCrystal-velvet': 'fujiCrystalArchive', 'paper-digital-glossy': 'fedrigoniGloss',
  'paper-digital-highgloss': 'fedrigoniGloss', 'paper-digital-matte': 'sappiSilkMatt',
} as const;
const blurbPapers = {
  standard: 'standard', 'premium-matte': 'premiumMatte', 'pro-medium-gloss-paper': 'proPhotoPearl',
  'pro-uncoated-paper': 'superfineEggshell', pro_photo_layflat: 'proPhotoPearlLayflat', pro_uncoated_layflat: 'superfineEggshellLayflat',
} as const;
type BlurbPaper = typeof blurbPapers[keyof typeof blurbPapers];
type WhiteWallPaper = typeof whiteWallPapers[keyof typeof whiteWallPapers];

const spec = ({ format, coverFormat }: Preset): PrintSpecification => ({ interior: format, cover: coverFormat });
const ready = (preset: Preset, pages: number) => {
  const result = resolveCover(spec(preset), pages);
  assert.equal(result.status, 'ready', `${preset.format.label} at ${pages} pages`);
  return result.geometry;
};
const points = (millimetres: number) => Math.round(millimetres * 72 / 25.4 * 1000) / 1000;
const close = (actual: number, expected: number, message: string) => assert.ok(Math.abs(actual - expected) < 1e-6, `${message}: ${actual} ≠ ${expected}`);

test('every preset is a valid print specification whose bands cover every allowed page count', async () => {
  const { blurbLargeSquare, whiteWallGallerySquare } = await presets;
  const all = [
    ...Object.values(whiteWallPapers).map((paper) => whiteWallGallerySquare({ paper })),
    ...Object.values(blurbPapers).flatMap((paper: BlurbPaper) => [blurbLargeSquare({ paper, cover: 'imageWrap' }),
      ...(paper.endsWith('Layflat') ? [] : [blurbLargeSquare({ paper, cover: 'dustJacket' })])]),
  ];
  for (const preset of all) {
    const parsed = printSpecificationSchema.safeParse(spec(preset));
    assert.ok(parsed.success, preset.format.label + ': ' + parsed.error?.message);
    assert.match(preset.researched, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(preset.sources.length > 0 && preset.sources.every((url) => url.startsWith('https://')));
  }
  assert.throws(() => blurbLargeSquare({ paper: 'proPhotoPearlLayflat', cover: 'dustJacket' }), /ImageWrap only/);
});

test('WhiteWall Gallery Square matches every official cover template', async () => {
  const { whiteWallGallerySquare } = await presets;
  const samples: { url: string; trimWidth: number; trimHeight: number; bleed: Record<string, number>; guides: number[] }[] =
    await spike('whitewall-samples.json');
  let checked = 0;
  for (const sample of samples) {
    const [size, paper, count] = sample.url.split('/').at(-1)!.slice(6, -5).split('_');
    if (size !== 'A3square') continue;
    const pages = Number(count);
    const preset = whiteWallGallerySquare({ paper: whiteWallPapers[paper as keyof typeof whiteWallPapers] });
    const { trim, sheet, regions } = ready(preset, pages);
    close(trim.width, sample.trimWidth, sample.url + ' trim width');
    close(trim.height, sample.trimHeight, sample.url + ' trim height');
    assert.deepEqual([-sheet.x, -sheet.y, sheet.width - trim.width + sheet.x, sheet.height - trim.height + sheet.y],
      [sample.bleed.InsideOrLeft, sample.bleed.Top, sample.bleed.OutsideOrRight, sample.bleed.Bottom], sample.url);
    // The template's middle spine guides are the spine edges.
    close(regions.spine.x, sample.guides[1], sample.url + ' spine start');
    close(regions.spine.x + regions.spine.width, sample.guides[4], sample.url + ' spine end');
    checked++;
  }
  assert.equal(checked, 198);
  // The page-count range follows the paper: photo paper stops at 112, inkjet papers at 200.
  assert.equal(whiteWallGallerySquare({ paper: 'fujiCrystalArchive' }).format.structure.pageCount.max, 112);
  assert.equal(whiteWallGallerySquare({ paper: 'sappiSilkMatt' }).format.structure.pageCount.max, 200);
});

test('Blurb Large Square matches every calculator response and recovered spine table', async () => {
  const { blurbLargeSquare } = await presets;
  const samples: { size: string; paper: keyof typeof blurbPapers; cover: string; pages: number; specification: string }[] =
    await spike('blurb-samples.json');
  let checked = 0;
  for (const sample of samples) {
    if (sample.size !== 'large_square') continue;
    const paper = blurbPapers[sample.paper];
    const preset = blurbLargeSquare({ paper, cover: sample.cover === 'lithowrap' ? 'imageWrap' : 'dustJacket' });
    const [interior, cover] = sample.specification.split('Cover Specifications');
    const number = (text: string, label: string) => Number(new RegExp(label + '\\D*(\\d+)').exec(text)![1]);
    const pair = (text: string, label: string) => new RegExp(label + '\\D*(\\d+) x (\\d+)').exec(text)!.slice(1).map(Number);
    const { format } = preset;
    assert.deepEqual(pair(interior, 'trim line'), [format.trim.width.value, format.trim.height.value]);
    assert.equal(format.bleed.outside.value, number(interior, 'Bleed'));
    assert.equal(format.safe.outside.value, number(interior, 'Outside Edge\\)'));
    assert.equal(format.safe.binding.value, number(interior, 'Binding Edge\\)'), sample.specification);

    const { sheet, trim, regions } = ready(preset, sample.pages);
    const [pdfWidth, pdfHeight] = pair(cover, 'should measure \\(w x h\\)');
    const [trimWidth, trimHeight] = pair(cover, 'trim line \\(w x h\\)');
    const message = `${sample.paper} ${sample.cover} at ${sample.pages} pages`;
    assert.deepEqual([sheet.width, sheet.height].map(points), [pdfWidth, pdfHeight], message);
    assert.deepEqual([trim.width, trim.height].map(points), [trimWidth, trimHeight], message);
    assert.equal(points(regions.spine.width), pair(cover, 'Spine \\(w x h\\)')[0], message);
    const flaps = /Flaps[^)]*\) (\d+) x/.exec(cover);
    assert.equal(regions.frontFlap && points(regions.frontFlap.width), flaps ? Number(flaps[1]) : undefined, message);
    checked++;
  }
  assert.equal(checked, 279);

  // The tables themselves, including every boundary the probe verified on both sides.
  for (const [file, paper] of Object.entries(blurbPapers)) {
    const { bands } = await spike(`blurb-bands-${file}.json`) as { bands: { min: number; max: number; spine: number }[] };
    const widths = blurbLargeSquare({ paper, cover: 'imageWrap' }).coverFormat.widths;
    assert.equal(widths.kind, 'page-bands');
    assert.deepEqual(widths.bands.map(({ from, to, value }) => ({ min: from, max: to, spine: value.spine.value })), bands, paper);
  }
});

test('the cover plan’s printer test cases hold for the presets', async () => {
  const { blurbLargeSquare, whiteWallGallerySquare } = await presets;
  const whiteWall = whiteWallGallerySquare({ paper: 'fujiCrystalArchive' });
  assert.deepEqual(ready(whiteWall, 32).sheet, { x: -10, y: -10, width: 623, height: 316 });
  assert.equal(ready(whiteWall, 36).sheet.width, 624.5);
  assert.equal(resolveCover(spec(whiteWall), 34).status, 'provisional');

  const jacket = blurbLargeSquare({ paper: 'premiumMatte', cover: 'dustJacket' });
  for (const [pages, spine, flap, width] of [[50, 33, 284, 2377], [52, 41, 280, 2377], [102, 54, 273, 2376]]) {
    const { sheet, regions } = ready(jacket, pages);
    assert.deepEqual([regions.spine.width, regions.backFlap!.width, regions.frontFlap!.width, sheet.width, sheet.height].map(points),
      [spine, flap, flap, width, 882], `${pages} pages`);
  }
});
