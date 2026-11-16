import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { PDFDocument, PDFName, PDFDict, PDFStream } from 'pdf-lib';
import { _electron } from 'playwright-core';
import { closeApp, testBook } from './ui-actions.mjs';

// An image/svg+xml picture from <RenderedImage> is placed in the page as SVG: it prints as vectors, two copies on a
// page keep their own ids, and scripts and event handlers in it are removed.
const root = fileURLToPath(new URL('../', import.meta.url));
const work = await mkdtemp(join(root, '.build/rendered-vectors-'));
let app = await _electron.launch({ executablePath: electron, args: [join(root, '.build/desktop'), '--user-data-dir=' + join(work, 'profile')],
  env: { ...process.env, IMAGEFLOW_HIDE_WINDOW: '1' } });
try {
  const folder = join(work, 'vectors.imageflow');
  const output = join(work, 'vectors.pdf');
  await mkdir(join(folder, 'template'), { recursive: true });
  await writeFile(join(folder, 'template/index.tsx'), `import {defineTemplate,mm,printFormat,RenderedImage,Spread} from 'imageflow';
const svg = (fill) => '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" onload="window.vectorScript=1">' +
  '<script>window.vectorScript=1</script><defs><clipPath id="half"><rect width="50" height="100"/></clipPath></defs>' +
  '<rect width="100" height="100" fill="' + fill + '" clip-path="url(#half)"/></svg>';
const Picture = ({ fill, left }) => <RenderedImage label="Vector" inputs={{ fill }}
  style={{ position: 'absolute', left, top: '20mm', width: '30mm', height: '30mm' }}
  draw={async () => new Blob([svg(fill)], { type: 'image/svg+xml' })} />;
export default defineTemplate({id:'vectors',version:'1',contract:1,
format:printFormat({label:'Vectors',trim:{width:mm(100),height:mm(100)},bleed:{all:mm(3),binding:mm(0)},safe:mm(5),ends:'inside-covers',pageCount:{min:2,max:20,step:2}}),
spreads:{page:{label:'Page',render:()=><Spread><Picture fill="#284d43" left="20mm" /><Picture fill="#c8432b" left="120mm" /></Spread>}}});`);
  await writeFile(join(folder, 'project.json'), JSON.stringify({ schemaVersion: 1, title: 'vectors', template: { id: 'vectors', version: '1' }, spreads: [{ id: 'one', definition: 'page' }] }));
  await writeFile(join(folder, 'photos.json'), '{}');
  const page = await testBook(app, folder);
  await page.waitForFunction(() => window.imageflow.currentProject);
  const frame = page.frameLocator('.canvas iframe.book-frame-book[data-current][data-ready]');
  await frame.locator('.if-rendered-image[data-rendered="ready"][data-vector]').nth(1).waitFor();
  const placed = await frame.locator('body').evaluate(() => ({
    ids: [...document.querySelectorAll('.if-rendered-vector clipPath')].map(({ id }) => id),
    references: [...document.querySelectorAll('.if-rendered-vector rect[clip-path]')].map((node) => node.getAttribute('clip-path')),
    scripts: document.querySelectorAll('.if-rendered-vector script, .if-rendered-vector [onload]').length,
    ran: 'vectorScript' in window,
    images: document.querySelectorAll('.if-rendered-image img[src]').length,
  }));
  assert.equal(new Set(placed.ids).size, 2, 'Each copy has its own clip path id: ' + JSON.stringify(placed));
  assert.deepEqual(placed.references, placed.ids.map((id) => 'url(#' + id + ')'), 'References follow the renamed ids');
  assert.equal(placed.scripts, 0, 'Scripts and event handlers are removed');
  assert.equal(placed.ran, false, 'No script in the picture ran');
  assert.equal(placed.images, 0, 'Vector pictures are not shown as images');

  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    dialog.showMessageBox = async () => ({ response: 0 });
  }, output);
  const result = await page.evaluate(async () => window.imageflow.exportBook((await window.imageflow.currentProject()).value.id));
  assert.deepEqual(result.value?.errors, [], JSON.stringify(result));
  const pdf = await PDFDocument.load(await readFile(output));
  const images = pdf.context.enumerateIndirectObjects().filter(([, object]) =>
    (object instanceof PDFStream ? object.dict : object instanceof PDFDict ? object : undefined)?.get(PDFName.of('Subtype')) === PDFName.of('Image'));
  assert.equal(images.length, 0, 'The PDF draws the pictures as vectors, without images');
  console.log('Rendered vectors passed: SVG pictures inline with unique ids, without scripts, and print as vectors.');
  await closeApp(app);
  app = undefined;
  await findings();
  console.log('Rendered image findings passed: output, raster and oversized notes, font coverage and stroked text.');
} finally {
  if (app) await closeApp(app);
  await rm(work, { recursive: true, force: true });
}

// output="vector" with markup and an <svg> element, a vector picture that returns pixels, an undeclared raster
// picture, an oversized one, and SVG text the bundled font cannot set or that is stroked.
async function findings() {
  const folder = join(work, 'findings.imageflow');
  const output = join(work, 'findings.pdf');
  await mkdir(join(folder, 'template/fonts'), { recursive: true });
  await writeFile(join(folder, 'template/fonts/inter.woff2'), await readFile(join(root, 'sample/starter/template/fonts/inter-latin-500-normal.woff2')));
  await writeFile(join(folder, 'template/styles.css'), '@font-face { font-family: "Book Sans"; src: url("./fonts/inter.woff2") format("woff2"); font-weight: 500; }\n.page { font: 500 10pt "Book Sans"; }');
  await writeFile(join(folder, 'template/index.tsx'), `import {defineTemplate,fonts,mm,printFormat,RenderedImage,Spread,Element} from 'imageflow';
import './styles.css';
const box = (left) => ({ position: 'absolute', left, top: '20mm', width: '30mm', height: '30mm' });
const canvas = (target, scale = 1) => { const c = document.createElement('canvas'); c.width = Math.ceil(target.width * target.pixelRatio * scale);
  c.height = Math.ceil(target.height * target.pixelRatio * scale); c.getContext('2d').fillRect(0, 0, c.width, c.height); return c; };
const label = (text, extra = '') => '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text x="10" y="50" font-family="Book Sans" font-weight="500" ' + extra + '>' + text + '</text></svg>';
export default defineTemplate({id:'findings',version:'1',contract:1,
format:printFormat({label:'Findings',trim:{width:mm(100),height:mm(100)},bleed:{all:mm(3),binding:mm(0)},safe:mm(5),ends:'inside-covers',pageCount:{min:2,max:20,step:2}}),
spreads:{page:{label:'Page',elements:{markup:{label:'Markup'},element:{label:'Element'},pixels:{label:'Pixels'},raster:{label:'Raster'},big:{label:'Big'},imagery:{label:'Imagery'}},
render:(ctx)=>{ window.__missing = fonts.missing('Bishkek Бишкек', { family: 'Book Sans', weight: 500 }); window.__settable = fonts.settable('Oş Бишкек', { family: 'Book Sans', weight: 500 });
 return <Spread className="page">
  <ctx.Element id="markup"><RenderedImage label="Markup" output="vector" inputs={{}} style={box('5mm')} draw={async (t) => { window.__vectorRatio = t.pixelRatio; return label('Bishkek Бишкек'); }} /></ctx.Element>
  <ctx.Element id="element"><RenderedImage label="Element" output="vector" inputs={{}} style={box('40mm')} draw={async () => new DOMParser().parseFromString(label('Halo', 'stroke="#fff" stroke-width="2"'), 'image/svg+xml').documentElement} /></ctx.Element>
  <ctx.Element id="pixels"><RenderedImage label="Pixels" output="vector" inputs={{}} style={box('75mm')} draw={async (t) => canvas(t)} /></ctx.Element>
  <ctx.Element id="raster"><RenderedImage label="Raster" inputs={{}} style={box('110mm')} draw={async (t) => canvas(t)} /></ctx.Element>
  <ctx.Element id="big"><RenderedImage label="Big" output="raster" inputs={{}} style={box('145mm')} draw={async (t) => canvas(t, 3)} /></ctx.Element>
  <ctx.Element id="imagery"><RenderedImage label="Imagery" output="raster" inputs={{}} style={box('180mm')} draw={async (t) => canvas(t)} /></ctx.Element>
 </Spread>; }}}});`);
  await writeFile(join(folder, 'project.json'), JSON.stringify({ schemaVersion: 1, title: 'findings', template: { id: 'findings', version: '1' }, spreads: [{ id: 'one', definition: 'page' }] }));
  await writeFile(join(folder, 'photos.json'), '{}');
  app = await _electron.launch({ executablePath: electron, args: [join(root, '.build/desktop'), '--user-data-dir=' + join(work, 'profile-findings')],
    env: { ...process.env, IMAGEFLOW_HIDE_WINDOW: '1' } });
  const page = await testBook(app, folder);
  await page.waitForFunction(() => window.imageflow.currentProject);
  const frame = page.frameLocator('.canvas iframe.book-frame-book[data-current][data-ready]');
  await frame.locator('[data-element="markup"] .if-rendered-image[data-rendered="ready"]').waitFor();
  const inFrame = await frame.locator('body').evaluate(() => ({ missing: window.__missing, settable: window.__settable, ratio: window.__vectorRatio }));
  assert.deepEqual(inFrame.missing, ['Б', 'и', 'ш', 'к', 'е'], 'fonts.missing names the Cyrillic letters once each');
  assert.equal(inFrame.settable, 'Os ', 'fonts.settable drops what cannot be set and falls back to base letters');
  assert.equal(inFrame.ratio, 1, 'a declared vector picture draws at a pixel ratio of 1');
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    dialog.showMessageBox = async () => ({ response: 1 });
  }, output);
  const result = await page.evaluate(async () => window.imageflow.exportBook((await window.imageflow.currentProject()).value.id));
  const { errors, warnings } = result.value;
  const codes = (list, code) => list.filter((issue) => issue.code === code).map((issue) => issue.element ?? issue.location?.element).sort();
  assert.deepEqual(codes(errors, 'rendered-image-failed'), ['pixels'], 'a vector picture that returns pixels fails: ' + JSON.stringify(errors));
  assert.deepEqual(codes(warnings, 'rendered-image-raster'), ['raster'], 'only the undeclared raster picture is asked to become vectors');
  assert.deepEqual(codes(warnings, 'rendered-image-oversized'), ['big'], 'the oversized picture is reported: ' + JSON.stringify(warnings));
  assert.deepEqual(codes(warnings, 'font-coverage'), ['markup'], 'SVG text the bundled font cannot set is reported');
  assert.match(warnings.find((issue) => issue.code === 'font-coverage').details.characters, /Б/);
  assert.deepEqual(codes(warnings, 'text-stroked'), ['element'], 'stroked SVG text is reported');
  // The oversized picture reached the PDF at the resolution the format asks for, not 3×.
  const pdf = await PDFDocument.load(await readFile(output));
  const widths = pdf.context.enumerateIndirectObjects().flatMap(([, object]) => object instanceof PDFStream && object.dict.get(PDFName.of('Subtype')) === PDFName.of('Image')
    ? [object.dict.get(PDFName.of('Width'))?.asNumber?.() ?? 0] : []);
  const target = Math.ceil(30 / 25.4 * 300);
  assert.ok(widths.length >= 3 && widths.every((width) => width <= target * 1.05), 'raster pictures are placed at the target resolution: ' + widths.join(', '));
}
