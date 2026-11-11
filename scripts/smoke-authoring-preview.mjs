import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';
import sharp from 'sharp';

const root = fileURLToPath(new URL('../', import.meta.url));
const build = join(root, '.build');
const work = await mkdtemp(join(build, 'authoring-preview-'));
const project = join(work, 'book');
const entry = join(project, 'template', 'index.tsx');
const story = { text: 'story' };
const template = `import { defineTemplate, mm, Spread, MarkdownBox, PhotoBox } from 'imageflow';
import './style.css';

const story = (left) => <MarkdownBox id="story" className="story" style={{ left }} />;
const marker = (left, color) => <div style={{ position: 'absolute', left, top: '32mm', width: '10mm', height: '10mm', background: color }} />;
const sheet = (...children) => <Spread><div className="bleed" /><div className="trim" />{children}</Spread>;
const textBox = { type: 'markdown', label: 'Story' };

export default defineTemplate({
  id: 'artwork-smoke', version: '1', contract: 1,
  format: {
    label: 'Artwork smoke', trim: { width: mm(100), height: mm(75) },
    bleed: { top: mm(3), bottom: mm(5), outside: mm(7), binding: mm(4) },
    safe: { top: mm(2), bottom: mm(2), outside: mm(2), binding: mm(2) },
    structure: { delivery: 'pages', ends: 'single-pages', pageCount: { min: 6, max: 12, step: 2 } },
    output: { container: 'pdf', colorSpace: 'sRGB', transparency: 'allow' },
  },
  spreads: {
    opening: { label: 'Opening', span: 'right', boxes: { story: textBox, blank: { type: 'photo', label: 'Empty photo' } },
      render: () => sheet(story('110mm'), marker('108mm', '#0000ff'),
        <PhotoBox id="blank" style={{ position: 'absolute', left: '165mm', top: '50mm', width: '20mm', height: '20mm' }} />) },
    middle: { label: 'Middle', boxes: { story: textBox, photo: { type: 'photo', label: 'Photo' } },
      render: () => sheet(story('10mm'), marker('150mm', '#9900dd'),
        <PhotoBox id="photo" style={{ position: 'absolute', left: '45mm', top: '32mm', width: '10mm', height: '10mm' }} />) },
    closing: { label: 'Closing', span: 'left', render: () => sheet(marker('45mm', '#ff8800')) },
  },
});
`;

async function fixture() {
  await Promise.all(['template', 'photos', 'texts'].map((folder) => mkdir(join(project, folder), { recursive: true })));
  await Promise.all([
    writeFile(join(project, 'project.json'), JSON.stringify({
      schemaVersion: 1, title: 'Artwork test', template: { id: 'artwork-smoke', version: '1' },
      texts: { story: 'texts/story.md' }, spreads: [
        { id: 'first', definition: 'opening', boxes: { story } },
        { id: 'later', definition: 'middle', boxes: { story, photo: { photo: 'art' } } },
        { id: 'last', definition: 'closing' },
      ],
    })),
    writeFile(join(project, 'photos.json'), JSON.stringify({ art: { path: 'photos/art.png' } })),
    writeFile(join(project, 'texts', 'story.md'), '**First chapter**\n\n*Later continuation*\n'),
    writeFile(entry, template),
    writeFile(join(project, 'template', 'style.css'), `
      @font-face { font-family: Artwork; src: url('./artwork.woff2'); }
      .if-spread > .bleed { background: #00ffff; }
      .trim { position: absolute; inset: 0; background: #fff; }
      .story { position: absolute; top: 10mm; width: 70mm; height: 12mm; font: 20px/28px Artwork, serif; }
      .story p { margin: 0 0 12px; }
      .story strong { color: #ff0000; }
      .story em { color: #00b000; }
    `),
    copyFile(join(root, 'sample', 'starter', 'template', 'fonts', 'source-serif-4-latin-400-normal.woff2'),
      join(project, 'template', 'artwork.woff2')),
    sharp({ create: { width: 100, height: 100, channels: 3, background: '#ff00ff' } }).png().toFile(join(project, 'photos', 'art.png')),
  ]);
}

async function raster(image, { width, height, mimeType }) {
  assert.deepEqual({ width: image.width, height: image.height, mimeType: image.mimeType }, { width, height, mimeType });
  const encoded = sharp(Buffer.from(image.data, 'base64'));
  const metadata = await encoded.metadata();
  assert.equal(metadata.format, mimeType.split('/')[1]);
  const { data, info } = await encoded.removeAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual({ width: info.width, height: info.height, channels: info.channels }, { width, height, channels: 3 });
  return {
    pixel(x, y) {
      const offset = (Math.floor(y * height) * width + Math.floor(x * width)) * info.channels;
      return [...data.subarray(offset, offset + info.channels)];
    },
    count(matches) {
      let count = 0;
      for (let offset = 0; offset < data.length; offset += info.channels) {
        if (matches(data[offset], data[offset + 1], data[offset + 2])) count++;
      }
      return count;
    },
  };
}

function expectPixel(image, x, y, expected, message) {
  const actual = image.pixel(x, y);
  assert.ok(actual.every((channel, i) => Math.abs(channel - expected[i]) < 8),
    (message ? message + ' ' : '') + 'Expected ' + expected.join(', ') + ', received ' + actual.join(', ') + '.');
}

let app;
try {
  await fixture();
  app = await _electron.launch({ executablePath: electron,
    args: [join(build, 'desktop'), '--user-data-dir=' + join(work, 'profile')],
    env: { ...process.env, IMAGEFLOW_HIDE_WINDOW: '1' }, timeout: 15000 });
  const w = await app.firstWindow();
  w.setDefaultTimeout(30000);
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, project);
  await w.getByRole('button', { name: 'Open project…' }).click();
  const ready = 'iframe.book-frame-book[data-current][data-ready]';
  const displayed = 'iframe.book-frame-book[data-ready]:not([aria-hidden="true"])';
  const frame = w.frameLocator(ready);
  const check = async (request = {}) => {
    const result = await w.evaluate(async ({ displayed, request }) => {
      const id = new URL(document.querySelector(displayed).src).pathname.split('/').at(-1);
      return window.imageflow.checkBook(id, request);
    }, { displayed, request });
    assert.ok('value' in result, result.error);
    return result.value;
  };
  const preview = async (options) => {
    const result = await check({ preview: options });
    assert.equal(result.state, 'ready', JSON.stringify(result.diagnostics));
    assert.ok(result.image);
    return result.image;
  };

  const continued = await frame.locator('[data-spread="later"] [data-box="story"]').textContent();
  assert.match(continued, /Later continuation/);
  assert.doesNotMatch(continued, /First chapter/);
  const checked = await check();
  assert.equal(checked.state, 'ready');
  assert.match(checked.revision, /^[a-f0-9]{64}$/);
  assert.deepEqual(checked.checks, { bundle: 'passed', declarations: 'passed', layout: 'completed', typescript: 'not-run', fixtures: 'not-run', print: 'not-run' });
  assert.equal(checked.render.pages, 4);
  assert.equal(checked.image, undefined);
  assert.ok(checked.diagnostics.some(({ severity, message }) => severity === 'error' && /Page count is 4/.test(message)));

  const result = await check({ expectedRevision: checked.revision, preview: { target: { spread: 'later', side: 'left' }, maxEdge: 400 } });
  assert.equal(result.state, 'ready', JSON.stringify(result.diagnostics));
  assert.equal(result.revision, checked.revision);
  assert.equal(result.image.bounds, 'trim');
  assert.deepEqual(result.image.page, { left: 2 });
  assert.equal(result.image.widthMm, 100);
  assert.equal(result.image.heightMm, 75);
  const later = await raster(result.image, { width: 400, height: 300, mimeType: 'image/png' });
  assert.ok(later.count((r, g, b) => r < 60 && g > 100 && b < 60) > 25, 'The later Markdown fragment must render in green.');
  assert.equal(later.count((r, g, b) => r > 230 && g < 80 && b < 80), 0, 'The first fragment must stay on page 1.');
  expectPixel(later, .5, .5, [255, 0, 255], 'The assigned photo must be decoded.');

  const opening = await preview({ target: { page: 1 }, maxEdge: 400 });
  assert.equal(opening.side, 'right');
  assert.equal(opening.spread, 'first');
  assert.deepEqual(opening.page, { right: 1 });
  const first = await raster(opening, { width: 400, height: 300, mimeType: 'image/png' });
  assert.ok(first.count((r, g, b) => r > 230 && g < 80 && b < 80) > 25);
  expectPixel(first, .12, .5, [0, 0, 255]);
  expectPixel(first, .75, .8, [255, 255, 255], 'Empty boxes must show clean artwork.');

  const openingBleed = await preview({ target: { spread: 'first' }, bounds: 'bleed', maxEdge: 400 });
  assert.deepEqual([openingBleed.side, openingBleed.widthMm, openingBleed.heightMm], ['right', 111, 83]);
  const bleed = await raster(openingBleed, { width: 400, height: 299, mimeType: 'image/png' });
  expectPixel(bleed, .99, .5, [0, 255, 255]);
  expectPixel(bleed, .01, .5, [255, 255, 255], 'Right-page binding bleed starts inside the facing page.');
  expectPixel(bleed, .14, .5, [0, 0, 255]);

  const spreadImage = await preview({ target: { spread: 'later' }, maxEdge: 400 });
  assert.equal(spreadImage.side, 'spread');
  assert.deepEqual(spreadImage.page, { left: 2, right: 3 });
  const spread = await raster(spreadImage, { width: 400, height: 150, mimeType: 'image/png' });
  expectPixel(spread, .775, .5, [153, 0, 221]);

  const closing = await preview({ target: { spread: 'last' }, format: 'jpeg', maxEdge: 1600 });
  assert.equal(closing.side, 'left');
  assert.deepEqual(closing.page, { left: 4 });
  const last = await raster(closing, { width: 1600, height: 1200, mimeType: 'image/jpeg' });
  expectPixel(last, .5, .5, [255, 136, 0]);

  const inactive = await check({ preview: { target: { spread: 'first', side: 'left' } } });
  // Detail crops and measured geometry come from the same fully flowed artwork, including asymmetric bleed.
  const detail = await check({ inspect: { spread: 'later', box: 'photo' },
    preview: { target: { spread: 'later', box: 'photo', paddingMm: 0 }, maxEdge: 300 } });
  assert.equal(detail.state, 'ready', JSON.stringify(detail.diagnostics));
  const measured = detail.render.inspection.items[0];
  assert.equal(measured.id, 'photo');
  assert.equal(measured.source, 'art');
  for (const [key, expected] of Object.entries({ x: 52, y: 35, width: 10, height: 10 })) {
    assert.ok(Math.abs(measured.boundsMm[key] - expected) < .1, JSON.stringify(measured));
  }
  const photoDetail = await raster(detail.image, { width: 300, height: 300, mimeType: 'image/png' });
  expectPixel(photoDetail, .5, .5, [255, 0, 255]);
  const sheetResult = await check({ preview: { target: { spreads: ['first', 'later', 'last'], columns: 2 }, maxEdge: 800 } });
  assert.equal(sheetResult.state, 'ready', JSON.stringify(sheetResult.diagnostics));
  const sheetImage = sheetResult.image;
  assert.equal(sheetImage.kind, 'contact-sheet');
  assert.deepEqual(sheetImage.cells.map(cell => cell.side), ['right', 'spread', 'left']);
  const collage = await raster(sheetImage, { width: sheetImage.width, height: sheetImage.height, mimeType: 'image/png' });
  if (process.env.IMAGEFLOW_PREVIEW_AUDIT === '1') {
    await writeFile(join(build, 'feedback-contact-sheet.png'), Buffer.from(sheetImage.data, 'base64'));
    await writeFile(join(build, 'feedback-detail.png'), Buffer.from(detail.image.data, 'base64'));
  }
  const cell = sheetImage.cells[1];
  expectPixel(collage, (cell.x + cell.width * .25) / sheetImage.width, (cell.y + cell.height * .5) / sheetImage.height, [255, 0, 255]);
  assert.ok(collage.count((r,g,b)=>r<60 && g>100 && b<60)>5, 'The contact sheet retains the later green text continuation.');
  const absentDetail = await check({ preview: { target: { spread: 'later', box: 'absent' } } });
  assert.equal(absentDetail.state, 'error');
  assert.equal(absentDetail.diagnostics[0].code, 'preview-target-not-found');
  assert.equal(inactive.state, 'error');
  assert.equal(inactive.diagnostics[0].code, 'preview-target-not-found');
  const oversized = await check({ preview: { target: { page: 2 }, maxEdge: 1601 } });
  assert.equal(oversized.state, 'error');
  assert.equal(oversized.diagnostics[0].code, 'invalid-check-request');

  // Simulate a renderer returning undersized metadata: ordinary pages and details must reject it.
  for (const target of [{ page: 2 }, { spread: 'later', box: 'photo' }]) {
    await app.evaluate(({ app }) => {
      app.once('browser-window-created', (_event, window) => {
        const execute = window.webContents.executeJavaScript.bind(window.webContents);
        window.webContents.executeJavaScript = async (...args) => {
          const result = await execute(...args);
          if (result?.preview?.state === 'ready') {
            result.preview.metadata.width = 100;
            result.preview.metadata.height = 100;
          }
          return result;
        };
      });
    });
    const undersized = await check({ preview: { target, maxEdge: 400 } });
    assert.equal(undersized.state, 'error');
    assert.equal(undersized.diagnostics[0].code, 'preview-capture-failed');
    assert.equal(undersized.image, undefined);
  }

  const proof = join(work, 'proof.pdf');
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, proof);
  await w.getByRole('button', { name: 'Export proof PDF' }).click();
  await w.waitForFunction(() => document.querySelector('.status')?.textContent?.startsWith('Proof PDF saved.'));
  const proofText = execFileSync('pdftotext', ['-f', '2', '-l', '2', proof, '-'], { encoding: 'utf8' });
  assert.match(proofText, /Later continuation/);
  assert.doesNotMatch(proofText, /First chapter/);

  await writeFile(entry, 'export default );\n');
  await w.locator('.status-error').waitFor();
  const stale = await check({ expectedRevision: checked.revision });
  assert.equal(stale.state, 'error');
  assert.notEqual(stale.revision, checked.revision);
  assert.equal(stale.diagnostics[0].code, 'revision-conflict');
  const failed = await check();
  assert.equal(failed.state, 'error');
  assert.equal(failed.revision, stale.revision);
  assert.equal(failed.diagnostics[0].code, 'template-compile-error');
  assert.equal(failed.diagnostics[0].location.path, 'template/index.tsx');
  assert.equal(failed.diagnostics[0].location.line, 1);
  assert.ok(failed.diagnostics[0].location.column > 0);

  const previousFrame = await w.locator(displayed).getAttribute('src');
  await writeFile(entry, template);
  await w.waitForFunction(({ ready, previousFrame }) => {
    const current = document.querySelector(ready);
    return current && current.getAttribute('src') !== previousFrame && !document.querySelector('.status-error');
  }, { ready, previousFrame });
  const recovered = await check({ expectedRevision: checked.revision });
  assert.equal(recovered.state, 'ready', JSON.stringify(recovered.diagnostics));

  // Findings carry stable codes, the box/source involved, measured values and a suggested fix.
  const diagnosed = template.replace("transparency: 'allow' }", "transparency: 'allow', resolution: { minimum: 300, target: 300, maximum: 600 } }");
  assert.notEqual(diagnosed, template);
  const previousDiagnosed = await w.locator(displayed).getAttribute('src');
  // A missing font file is a bundle error; a file that exists but cannot be decoded fails at render time.
  await writeFile(join(project, 'template', 'broken.woff2'), 'not a font');
  await writeFile(join(project, 'template', 'style.css'), `
    @font-face { font-family: Missing; src: url('./broken.woff2'); }
    .if-spread > .bleed { background: #00ffff; }
    .trim { position: absolute; inset: 0; background: #fff; }
    .story { position: absolute; top: 10mm; width: 70mm; height: 12mm; font: 20px/28px Missing, serif; }
  `);
  await writeFile(join(project, 'texts', 'story.md'), Array.from({ length: 40 }, (_, i) => 'Paragraph ' + i + ' of a story that cannot fit.').join('\n\n'));
  await writeFile(entry, diagnosed);
  await w.waitForFunction(({ displayed, previousDiagnosed }) => {
    const current = document.querySelector(displayed);
    return current && current.getAttribute('src') !== previousDiagnosed;
  }, { displayed, previousDiagnosed }).catch(async (error) => {
    throw new Error('The diagnostics fixture did not reload: ' + await w.locator('.status').textContent().catch(() => ''), { cause: error });
  });
  const findings = await check();
  assert.equal(findings.state, 'ready', JSON.stringify(findings.diagnostics));
  const finding = (code) => {
    const found = findings.diagnostics.find((diagnostic) => diagnostic.code === code);
    assert.ok(found, code + ' missing from ' + JSON.stringify(findings.diagnostics));
    assert.ok(found.suggestion, code + ' needs a suggested fix.');
    return found;
  };
  const overflow = finding('text-overflow');
  assert.deepEqual([overflow.severity, overflow.location.spread, overflow.location.box, overflow.location.source], ['error', 'later', 'story', 'story']);
  assert.ok(overflow.details.overflowCharacters > 0);
  assert.equal(overflow.details.boxes, 2);
  const lowResolution = finding('photo-resolution-low');
  assert.deepEqual([lowResolution.location.spread, lowResolution.location.box, lowResolution.location.source], ['later', 'photo', 'art']);
  assert.equal(lowResolution.details.minimumPpi, 300);
  assert.ok(lowResolution.details.ppi > 200 && lowResolution.details.ppi < 300, JSON.stringify(lowResolution.details));
  assert.ok(Math.abs(lowResolution.details.boxWidthMm - 10) <= .2, JSON.stringify(lowResolution.details));
  assert.equal(finding('font-load-failed').details.family, 'Missing');
  console.log('ImageFlow authoring preview passed.');
} finally {
  await app?.close();
  await rm(work, { recursive: true, force: true });
}
