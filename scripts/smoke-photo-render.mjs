import { exportAction, testBook } from './ui-actions.mjs';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { PDFDict, PDFDocument, PDFName } from 'pdf-lib';
import { _electron } from 'playwright-core';

// #104: a PhotoBox render callback draws the photo through the template's SVG mask in the book view, follows a crop
// gesture before it is saved, saves the crop as an ordinary crop, and exports with its image loaded.
const root = fileURLToPath(new URL('../', import.meta.url));
const work = await mkdtemp(join(root, '.build', 'photo-render-'));
const project = join(work, 'Book.imageflow');
await cp(join(root, 'sample', 'starter'), project, { recursive: true, filter: (path) => basename(path) !== '.imageflow' });
// The starter's story layout draws its main photo through a circular SVG mask.
const source = join(project, 'template', 'index.tsx');
const template = await readFile(source, 'utf8');
const plain = `<ctx.PhotoBox id="hero" rect={ctx.geometry.page('left', 'bleed')} />`;
assert.ok(template.includes(plain));
await writeFile(source, template.replace(plain, `<ctx.PhotoBox id="hero" rect={ctx.geometry.page('left', 'bleed')}>{(photo, box) =>
            <svg className="smoke-mask" width={photo.box.width} height={photo.box.height}>
              <clipPath id={box.uid}><circle cx={photo.box.width / 2} cy={photo.box.height / 2} r={photo.box.width / 3} /></clipPath>
              <image className="smoke-image" href={photo.src} x={photo.image.x} y={photo.image.y} width={photo.image.width}
                height={photo.image.height} preserveAspectRatio="none" clipPath={'url(#' + box.uid + ')'} />
            </svg>}</ctx.PhotoBox>`));
const read = async () => JSON.parse(await readFile(join(project, 'project.json'), 'utf8'));

let app;
try {
  app = await _electron.launch({ executablePath: electron, args: [join(root, '.build/desktop'), '--user-data-dir=' + join(work, 'profile')],
    env: { ...process.env, IMAGEFLOW_HIDE_WINDOW: '1' }, timeout: 15000 });
  const w = await testBook(app, project, false);
  w.setDefaultTimeout(30000);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1400, 900));
  const ready = 'iframe.book-frame-book[data-current][data-ready]';
  await w.locator(ready).waitFor();
  const frame = w.frameLocator(ready);
  // Runs a change and waits for the book frame that renders its result.
  const rerendered = async (change) => {
    const old = await w.evaluate(() => document.querySelector('iframe.book-frame-book[data-current]')?.getAttribute('src') ?? null);
    await change();
    await w.waitForFunction((url) => {
      const current = document.querySelector('iframe.book-frame-book[data-current][data-ready]');
      return current && current.getAttribute('src') !== url;
    }, old, { timeout: 30000 });
  };
  const image = frame.locator('[data-spread="arriving"] [data-box="hero"][data-photo-render="custom"] svg.smoke-mask image.smoke-image');
  await image.waitFor();
  const x = () => w.frameLocator(ready).locator('[data-spread="arriving"] [data-box="hero"] image.smoke-image').evaluate((node) => Number(node.getAttribute('x')));
  const status = await frame.locator('body').evaluate(() => window.imageflowRenderStatus);
  assert.equal(status.state, 'ready');
  assert.deepEqual(status.errors.filter(({ code }) => /^photo-/.test(code ?? '')), [], 'no photo findings');
  // The SVG image has loaded: the browser decoded it through the host's photo URL.
  assert.match(await image.getAttribute('href'), /^imageflow:\/\/render\/.+\/photo\/segla$/);
  assert.equal(await frame.locator('[data-spread="arriving"] [data-box="hero"] > img').count(), 0);
  const before = await x();

  // Selecting the photo takes gestures over the box without covering the template's artwork with a plain copy.
  await w.locator('.spread-thumb[data-spread="arriving"]').click();
  await w.locator('.inspector').getByRole('button', { name: 'Edit Main photo', exact: true }).click();
  const window_ = w.locator('.crop-editor .crop-window.custom');
  await window_.waitFor();
  assert.equal(await window_.locator('img').count(), 0);
  // Zoom in first, so the photo can move sideways inside its frame.
  await rerendered(() => w.getByRole('button', { name: 'Zoom in', exact: true }).click());
  const zoomed = await read();
  assert.ok(zoomed.spreads.find(({ id }) => id === 'arriving').boxes.hero.crops?.story?.zoom > 1, 'zoom saved as a crop');
  const start = await x();
  assert.ok(start < before, 'zooming in enlarges the drawn photo: ' + start + ' < ' + before);

  // During the drag the template draws the gesture's crop, before anything is saved.
  const box = await window_.boundingBox();
  await w.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await w.mouse.down();
  for (let i = 1; i <= 8; i++) await w.mouse.move(box.x + box.width / 2 + i * 12, box.y + box.height / 2);
  const live = w.frameLocator(ready).locator('[data-spread="arriving"] [data-box="hero"] image.smoke-image');
  await live.evaluate((node, start) => new Promise((resolve, reject) => {
    const deadline = Date.now() + 10000;
    const poll = () => Number(node.getAttribute('x')) > start + 1 ? resolve() : Date.now() > deadline ? reject(new Error('x stayed ' + node.getAttribute('x'))) : setTimeout(poll, 30);
    poll();
  }), start);
  const dragged = await live.evaluate((node) => Number(node.getAttribute('x')));
  const crops = (await read()).spreads.find(({ id }) => id === 'arriving').boxes.hero.crops;
  assert.deepEqual(crops, zoomed.spreads.find(({ id }) => id === 'arriving').boxes.hero.crops, 'not saved during the gesture');
  await rerendered(() => w.mouse.up());

  // Releasing saves one crop; the re-rendered book draws it where the gesture left it.
  let saved;
  for (let i = 0; i < 100 && !saved; i++) {
    const next = (await read()).spreads.find(({ id }) => id === 'arriving').boxes.hero.crops.story;
    if (next.centerX !== zoomed.spreads.find(({ id }) => id === 'arriving').boxes.hero.crops.story.centerX) saved = next;
    else await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(saved, 'the drag saved a crop');
  assert.ok(saved.centerX < 0.5, 'dragging right shows more of the left: ' + saved.centerX);
  await w.keyboard.press('Escape');
  await w.waitForFunction(() => !document.querySelector('.crop-editor'));
  await w.locator(ready).waitFor();
  const settled = await w.frameLocator(ready).locator('[data-spread="arriving"] [data-box="hero"] image.smoke-image').evaluate((node) => Number(node.getAttribute('x')));
  assert.ok(Math.abs(settled - dragged) < 2, 'saved crop matches the gesture: ' + settled + ' ≈ ' + dragged);

  // Proof export waits for the SVG image and embeds it.
  const output = join(work, 'proof.pdf');
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, output);
  await exportAction(w, 'Export proof PDF');
  await w.waitForFunction(() => document.querySelector('.status-error') ||
    document.querySelector('.status')?.textContent?.startsWith('Proof PDF saved'), null, { timeout: 120000 });
  assert.match(await w.locator('.status').textContent(), /^Proof PDF saved\./);
  const pdf = await PDFDocument.load(await readFile(output));
  const units = status.units;
  const page = units.findIndex(({ spread, side }) => spread === 'arriving' && side === 'left');
  assert.ok(page >= 0);
  const resources = pdf.getPages()[page].node.Resources();
  const objects = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict);
  assert.ok(objects && objects.keys().length > 0, 'the masked photo is embedded on its page');
  console.log('PhotoBox render callback smoke test passed.');
} finally {
  await app?.close();
  await rm(work, { recursive: true, force: true });
}
