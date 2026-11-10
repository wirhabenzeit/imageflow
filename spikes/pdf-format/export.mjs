// Renders small HTML test documents to PDF (and JPEG) with headless Chrome.
// Each document isolates one format question; analyze.py inspects the output.
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const root = new URL('./', import.meta.url);
const out = new URL('out/', root);
await mkdir(out, { recursive: true });

const fonts = `
@font-face { font-family: 'Source Serif 4'; font-weight: 400; src: url(../node_modules/@fontsource/source-serif-4/files/source-serif-4-latin-400-normal.woff2); }
@font-face { font-family: 'Source Serif 4'; font-weight: 700; src: url(../node_modules/@fontsource/source-serif-4/files/source-serif-4-latin-700-normal.woff2); }
@font-face { font-family: 'Source Serif 4'; font-style: italic; src: url(../node_modules/@fontsource/source-serif-4/files/source-serif-4-latin-400-italic.woff2); }
@font-face { font-family: 'Inter'; font-weight: 400; src: url(../node_modules/@fontsource/inter/files/inter-latin-400-normal.woff2); }
@font-face { font-family: 'Inter Variable'; font-weight: 100 900; src: url(../node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2); }
`;

// Page sizes from docs/print-targets.md.
const sizes = {
  whitewallPage: ['293mm', '296mm'],
  saalSpread: ['594mm', '300mm'],
  blurbPage: ['855pt', '864pt'],
};

function doc([width, height], pages, extraCss = '') {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
${fonts}
@page { size: ${width} ${height}; margin: 0; }
html, body { margin: 0; padding: 0; }
body { font-family: 'Source Serif 4'; color: #000; }
.page { position: relative; width: ${width}; height: ${height}; overflow: hidden; break-after: page; background: #f6f2e8; }
.page:last-child { break-after: auto; }
.bleed-img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.label { position: absolute; left: 20mm; bottom: 20mm; font: 14pt 'Inter'; background: #fff; padding: 2mm 4mm; }
${extraCss}
</style></head><body>${pages.join('\n')}</body></html>`;
}

const page = (inner) => `<div class="page">${inner}</div>`;
const label = (text) => `<div class="label">${text}</div>`;
const fullImage = (src, extra = '') => `<img class="bleed-img" src="../assets/${src}" ${extra}>`;

const body = `<p style="position:absolute;left:30mm;top:30mm;width:120mm;font-size:11pt;line-height:1.45">
The road narrowed as it followed the fjord. By the time we reached the last bend, the clouds had dropped low enough to hide the mountains, leaving just the water and a white house on the shore.</p>`;

const documents = {
  // Geometry: page sizes in mm and pt, single pages and spreads.
  'geometry-whitewall-pages': doc(sizes.whitewallPage, [
    page(fullImage('chart-srgb.jpg') + label('WhiteWall page 293 × 296 mm')),
    page(body + label('page 2')),
  ]),
  'geometry-saal-spread': doc(sizes.saalSpread, [
    page(fullImage('chart-srgb.jpg') + label('Saal spread 594 × 300 mm')),
  ]),
  'geometry-blurb-pages': doc(sizes.blurbPage, [
    page(fullImage('chart-srgb.jpg') + label('Blurb page 855 × 864 pt')),
  ]),

  // Baseline: opaque photo and black text only, no CSS effects.
  plain: doc(sizes.whitewallPage, [
    page(`<img src="../assets/chart-srgb.jpg" style="position:absolute;left:30mm;top:80mm;width:150mm;height:150mm;object-fit:cover">` + body),
  ]),

  // Images: colour profiles, orientation, resolution, cropping, CSS backgrounds.
  images: doc(sizes.whitewallPage, [
    page(fullImage('chart-srgb.jpg') + label('sRGB')),
    page(fullImage('chart-p3.jpg') + label('Display P3 tag')),
    page(fullImage('chart-adobergb.jpg') + label('Adobe RGB tag')),
    page(fullImage('chart-untagged.jpg') + label('untagged')),
    page(fullImage('chart-orient6.jpg') + label('EXIF orientation 6')),
    page(fullImage('chart-7200.jpg') + label('7200 px on 293 mm')),
    page(fullImage('chart-900.jpg') + label('900 px on 293 mm')),
    page(fullImage('chart-srgb.jpg', 'style="object-position: 20% 50%; transform: scale(1.6)"') + label('crop and zoom')),
    page(`<div style="position:absolute;inset:0;background:url(../assets/chart-srgb.jpg) center/cover"></div>` + label('CSS background')),
  ]),

  // Cropping a 4000 × 3000 photo into a square page in different ways:
  // which variants keep the original JPEG and which re-encode it?
  crops: doc(sizes.whitewallPage, [
    page(fullImage('photo.jpg') + label('object-fit: cover')),
    page(`<img src="../assets/photo.jpg" style="position:absolute;top:0;left:-50%;height:100%;width:auto">` + label('overflow clip, natural aspect')),
    page(`<img src="../assets/photo.jpg" style="position:absolute;top:0;left:0;height:100%;width:auto;transform:translateX(-30%) scale(1.4);transform-origin:center">` + label('overflow clip + transform')),
    page(`<img src="../assets/photo.jpg" style="position:absolute;inset:0;width:100%;height:100%;object-fit:fill;clip-path:inset(0 30% 0 0)">` + label('clip-path, distorted fill')),
    page(`<img src="../assets/photo.jpg" style="position:absolute;left:20mm;top:20mm;width:200mm;height:auto">` + label('uncropped, scaled')),
    page(fullImage('photo-square.jpg') + label('square photo, 1% crop')),
    page(fullImage('chart-43.jpg') + label('4:3 chart, 25% crop')),
  ]),

  // A realistic page with one translucent caption over a photo, for flattening cost.
  'photo-caption': doc(sizes.whitewallPage, [
    page(fullImage('photo-square.jpg') + `<div style="position:absolute;left:20mm;bottom:20mm;width:180mm;padding:5mm 7mm;background:rgba(255,255,255,.75);font-size:11pt;line-height:1.45">${'The road narrowed as it followed the fjord. '.repeat(3)}</div>`),
  ]),

  // Transparency and effects, one per page.
  effects: doc(sizes.whitewallPage, [
    page(fullImage('chart-srgb.jpg') + `<div style="position:absolute;left:30mm;top:30mm;width:200mm;padding:8mm;background:#fff;opacity:.7">opacity: .7</div>`),
    page(fullImage('chart-srgb.jpg') + `<div style="position:absolute;left:30mm;top:30mm;width:200mm;padding:8mm;background:rgba(255,255,255,.7)">rgba background</div>`),
    page(`<div style="position:absolute;left:40mm;top:40mm;width:150mm;height:150mm;background:#fff;box-shadow:0 4mm 12mm rgba(0,0,0,.35)"></div>` + label('box-shadow')),
    page(fullImage('chart-srgb.jpg') + `<div style="position:absolute;left:30mm;top:30mm;width:200mm;height:100mm;background:#c86;mix-blend-mode:multiply"></div>` + label('mix-blend-mode')),
    page(fullImage('chart-srgb.jpg', 'style="filter: blur(3mm)"') + label('filter: blur')),
    page(`<div style="position:absolute;inset:0;background:linear-gradient(135deg,#1d3557,#f1faee)"></div>` + label('opaque gradient')),
    page(`<img src="../assets/alpha.png" style="position:absolute;left:40mm;top:40mm;width:150mm">` + label('PNG alpha')),
    page(`<svg style="position:absolute;left:40mm;top:40mm" width="150mm" height="150mm" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="#e63946" fill-opacity=".5"/></svg>` + label('SVG fill-opacity')),
    page(`<img src="../assets/chart-srgb.jpg" style="position:absolute;left:40mm;top:40mm;width:150mm;height:150mm;object-fit:cover;border-radius:12mm">` + label('rounded clip')),
  ]),

  // Fonts: static, variable, italic, system font, and a missing glyph.
  fonts: doc(sizes.whitewallPage, [
    page(`<div style="padding:30mm;font-size:16pt;line-height:1.5">
      <p style="font-family:'Source Serif 4'">Source Serif 4 regular – Mefjordvær</p>
      <p style="font-family:'Source Serif 4';font-weight:700">Source Serif 4 bold</p>
      <p style="font-family:'Source Serif 4';font-style:italic">Source Serif 4 italic</p>
      <p style="font-family:'Inter'">Inter static 400</p>
      <p style="font-family:'Inter Variable';font-weight:550">Inter variable at 550</p>
      <p style="font-family:Georgia">Georgia (system font)</p>
      <p style="font-family:'Inter'">Fallback glyphs: → ★ 日本</p>
      <p style="font-family:'Source Serif 4';color:#000">Black text #000</p>
      <p style="font-family:'Source Serif 4';font-size:8pt">8 pt minimum size check</p>
    </div>`),
  ]),
};

const browser = await chromium.launch({ channel: 'chrome' });
const context = await browser.newContext();
const tab = await context.newPage();

async function load(name) {
  const file = new URL(`${name}.html`, out);
  await writeFile(file, documents[name]);
  await tab.goto(pathToFileURL(file.pathname).href);
  await tab.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].map((img) => img.decode().catch(() => {})));
  });
}

for (const name of Object.keys(documents)) {
  await load(name);
  await tab.pdf({ path: new URL(`${name}.pdf`, out).pathname, preferCSSPageSize: true, printBackground: true });
  console.log('pdf', name);
}

// Raster delivery: the Saal spread as a 300-dpi JPEG (CSS px are 1/96 in).
await load('geometry-saal-spread');
const scaled = await browser.newContext({ deviceScaleFactor: 300 / 96, viewport: { width: 2246, height: 1134 } });
const rasterTab = await scaled.newPage();
await rasterTab.goto(pathToFileURL(new URL('geometry-saal-spread.html', out).pathname).href);
await rasterTab.evaluate(async () => {
  await document.fonts.ready;
  await Promise.all([...document.images].map((img) => img.decode().catch(() => {})));
});
// Saal's table asks for exactly 7016 × 3543 px; clip in CSS px so that px × 300/96 is exact.
await rasterTab.screenshot({
  path: new URL('saal-spread-300dpi.jpg', out).pathname,
  type: 'jpeg',
  quality: 95,
  clip: { x: 0, y: 0, width: 7016 / (300 / 96), height: 3543 / (300 / 96) },
});
console.log('jpeg saal-spread-300dpi');

// Preview reference for the plain page at 96 dpi, to compare with the rasterized PDF.
const preview = await browser.newContext({ deviceScaleFactor: 1, viewport: { width: 1108, height: 1119 } });
const previewTab = await preview.newPage();
await previewTab.goto(pathToFileURL(new URL('plain.html', out).pathname).href);
await previewTab.evaluate(() => document.fonts.ready);
await previewTab.locator('.page').first().screenshot({ path: new URL('plain-preview-96dpi.png', out).pathname });
console.log('png plain-preview-96dpi');

await browser.close();
