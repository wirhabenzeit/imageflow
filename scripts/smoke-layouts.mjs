import { testBook, menuAction, popupAction } from './ui-actions.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';

// Layout switching (#22): a spread keeps one state for all its layouts; the layout picks what is shown.
const root = fileURLToPath(new URL('../', import.meta.url));
const work = await mkdtemp(join(root, '.build', 'layouts-'));
const project = join(work, 'Book.imageflow');
const read = async () => JSON.parse(await readFile(join(project, 'project.json'), 'utf8'));
const settlements = async () => (await read()).spreads.find(({ id }) => id === 'settlements');
const app = await _electron.launch({ executablePath: electron, args: [join(root, '.build/desktop'), '--user-data-dir=' + join(work, 'profile')],
  env: { ...process.env, IMAGEFLOW_HIDE_WINDOW: '1' } });
try {
  const w = await testBook(app, project, true);
  w.setDefaultTimeout(20000);
  // Register before the app's message listener so a preview can be held deterministically.
  await w.addInitScript(() => {
    if (location.hostname !== 'editor') return;
    window.__layoutMessages = [];
    window.addEventListener('message', (event) => {
      const candidate = document.querySelector('iframe.book-frame-layouts[data-current]');
      if (!window.__holdLayouts || event.origin !== 'imageflow://render' || event.source !== candidate?.contentWindow) return;
      event.stopImmediatePropagation();
      window.__layoutMessages.push({ data: event.data, origin: event.origin, source: event.source });
    });
  });
  await w.reload();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1400, 900));
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, project);
  const frame = w.frameLocator('iframe.book-frame-book[data-current]');
  const status = () => frame.locator('body').evaluate(() => window.imageflowRenderStatus);
  const statusLine = () => w.locator('.status').textContent();
  // Runs a change and waits for the book frame that renders its result.
  const rerendered = async (change) => {
    const old = await w.evaluate(() => document.querySelector('iframe.book-frame-book[data-current]')?.getAttribute('src') ?? null);
    await change();
    await w.waitForFunction((url) => {
      const current = document.querySelector('iframe.book-frame-book[data-current][data-ready]');
      return current && current.getAttribute('src') !== url;
    }, old, { timeout: 30000 });
  };
  const button = (name) => w.getByRole('button', { name, exact: true });
  const picker = w.getByRole('radiogroup', { name: 'Layout' });
  const layout = (name) => picker.getByRole('radio', { name, exact: true });
  // The sidebar lists the spread's boxes; each opens its editor on the page. A placed photo is selected, with its
  // photo choice, Remove and crop values in the crop toolbar.
  const ready = () => w.waitForSelector('iframe.book-frame-book[data-current][data-ready]');
  const openBox = async (label) => {
    await ready();
    await w.locator('.inspector').getByRole('button', { name: 'Edit ' + label, exact: true }).click();
    await w.locator('.crop-editor, .edit-popover').first().waitFor();
  };
  const closeBox = async () => {
    if (await w.locator('.crop-action-panel').count()) await w.keyboard.press('Escape');
    await w.keyboard.press('Escape');
    await w.waitForFunction(() => !document.querySelector('.crop-editor, .edit-popover'));
  };
  const setCrop = async (box, values) => {
    await openBox(box);
    const toolbar = w.locator('.crop-content');
    await popupAction(app, w, toolbar.locator('.crop-more .action-menu-trigger'), 'Crop values…');
    for (const [label, value] of Object.entries(values)) {
      await rerendered(async () => {
        await toolbar.getByRole('spinbutton', { name: label, exact: true }).fill(String(value));
        await toolbar.getByRole('spinbutton', { name: label, exact: true }).press('Enter');
      });
    }
    await closeBox();
  };
  const kept = () => w.locator('.inspector').getByText(/^Set aside/).textContent();

  await w.locator('iframe.book-frame-book[data-current][data-ready]').waitFor();
  const layoutReady = async (spread) => {
    await w.waitForFunction((spread) => {
      const frame = document.querySelector('iframe.book-frame-layouts[data-current][data-ready]:not([aria-hidden])');
      return frame && new URL(frame.src).searchParams.get('spread') === spread;
    }, spread);
  };
  const pickerHasNoOverlap = () => picker.getByRole('radio').evaluateAll((items) => {
    const bounds = items.map((item) => item.getBoundingClientRect());
    return bounds.every((a, i) => bounds.slice(i + 1).every((b) =>
      Math.min(a.right, b.right) - Math.max(a.left, b.left) <= 1 || Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) <= 1));
  });
  await w.locator('.spread-thumb[data-spread="last-notes"]').click();
  await layoutReady('last-notes');
  await w.locator('.spread-thumb[data-spread="closing"]').click();
  await layoutReady('closing');
  // Hold the next frame's real messages so the transition is checked even on a fast computer.
  await w.evaluate(() => {
    window.__layoutMessages = [];
    window.__holdLayouts = true;
  });
  await w.locator('.spread-thumb[data-spread="last-notes"]').click();
  await w.waitForFunction(() => window.__layoutMessages.some(({ data }) => data.state === 'ready'));
  await w.screenshot({ path: join(root, '.build', 'layout-picker-transition.png') });
  assert.equal(await pickerHasNoOverlap(), true, 'Layout labels must not overlap while the next preview is pending.');
  assert.equal(await picker.getAttribute('aria-busy'), 'true');
  assert.equal(await picker.getByRole('radio').evaluateAll((items) => items.every((item) => item.disabled)), true);
  assert.equal(await w.locator('iframe.book-frame-layouts[data-current]').getAttribute('data-ready'), null,
    'A recreated iframe cannot reuse readiness from its previous mount.');
  await w.evaluate(() => {
    window.__holdLayouts = false;
    for (const message of window.__layoutMessages) window.dispatchEvent(new MessageEvent('message', message));
    window.__layoutMessages = [];
  });
  await layoutReady('last-notes');
  assert.equal(await pickerHasNoOverlap(), true);
  assert.equal(await picker.getByRole('radio').count(), 8);
  await w.locator('.inspector').screenshot({ path: join(root, '.build', 'layout-picker-ready.png') });
  // Revisit cached URLs across single-page and full-spread choice sets.
  for (const spread of ['closing', 'last-notes', 'title', 'last-notes', 'closing', 'last-notes']) {
    await w.locator('.spread-thumb[data-spread="' + spread + '"]').click();
    await layoutReady(spread);
    assert.equal(await pickerHasNoOverlap(), true);
  }
  await button('Photo grid 2×2 6–7').click();
  await w.locator('[data-spread="settlements"][aria-current="page"]').waitFor();

  // Only layouts with the same footprint are offered: no single title or closing page for a full spread. The grid
  // family has its own picker, so its 2×2 and 3×3 variants are one preview, named after the family.
  assert.deepEqual(await picker.getByRole('radio').evaluateAll((items) => items.map((item) => item.getAttribute('aria-label'))),
    ['Photo and story', 'Panorama', 'Map', 'Photo grid', 'Two photos', 'Text spread', 'Calendar spread', 'Contents']);

  // A new book revision with unchanged preview inputs reuses the same iframe, including its map drawing.
  await w.locator('iframe.book-frame-layouts[data-current][data-ready]').waitFor();
  const previewBefore = await w.locator('iframe.book-frame-layouts[data-current]').getAttribute('src');
  await w.locator('iframe.book-frame-layouts[data-current]').evaluate((frame) => { frame.dataset.reuseProbe = 'retained'; });
  const metadata = await read();
  metadata.title = 'Metadata-only save';
  await rerendered(() => writeFile(join(project, 'project.json'), JSON.stringify(metadata, null, 2)));
  assert.equal(await w.locator('iframe.book-frame-layouts[data-current]').getAttribute('src'), previewBefore);
  assert.equal(await w.locator('iframe.book-frame-layouts[data-current]').getAttribute('data-reuse-probe'), 'retained');

  // Crops are set per layout; the one set last is the focus other layouts fill around.
  await setCrop('Upper left', { Zoom: 2, Horizontal: 0.3 });
  await setCrop('Lower left', { Zoom: 1.5 });
  assert.deepEqual((await settlements()).boxes.hero.crops, { grid: { centerX: 0.3, centerY: 0.5, zoom: 2 } });
  assert.deepEqual((await settlements()).boxes.hero.focus, { centerX: 0.3, centerY: 0.5 });

  // Pointing at a layout says what switching does, without changing anything.
  const before = await read();
  await layout('Two photos').hover();
  assert.equal(await w.locator('#layout-consequence').textContent(), 'Two photos · 2 photos set aside');
  await layout('Text spread').focus();
  assert.equal(await w.locator('#layout-consequence').textContent(), 'Text spread · 4 photos set aside');
  assert.deepEqual(await read(), before);

  // A → B: the shared boxes show, the others stay on the spread without Book check warnings.
  await rerendered(() => layout('Two photos').click());
  assert.equal(await statusLine(), 'Two photos · 2 photos set aside');
  let state = await settlements();
  assert.equal(state.definition, 'pair');
  assert.deepEqual(Object.fromEntries(Object.entries(state.boxes).map(([id, box]) => [id, box.photo])),
    { hero: 'segla', second: 'shore', third: 'cottage', fourth: 'light' });
  assert.equal(await kept(), 'Set aside · 2 photos');
  assert.deepEqual((await status()).warnings, []);
  // The pair layout has no crop of its own: it fills around the focus set in the grid.
  assert.equal(Object.hasOwn((await settlements()).boxes.hero.crops ?? {}, 'pair'), false);

  // Undo restores the previous layout in one step, and closes crop mode opened on the switched spread.
  await openBox('Left photo');
  await w.locator('.crop-editor').waitFor();
  await rerendered(() => button('Undo').click());
  await w.waitForFunction(() => !document.querySelector('.crop-editor'));
  assert.equal((await settlements()).definition, 'grid');
  await rerendered(() => button('Redo').click());
  assert.equal((await settlements()).definition, 'pair');

  // Replacing a photo starts its crop over; removing one is a real edit.
  await openBox('Left photo');
  await popupAction(app, w, w.locator('.crop-more .action-menu-trigger'), 'Replace photo…');
  const replace = w.getByRole('dialog', { name: 'Replace photo in Left photo' }).locator('[data-photo]:not(:disabled)').first();
  const replacement = await replace.getAttribute('data-photo');
  await rerendered(() => replace.click());
  assert.deepEqual((await settlements()).boxes.hero, { photo: replacement, params: {} });
  await w.waitForFunction(() => !document.querySelector('.crop-editor'));
  await openBox('Right photo');
  await rerendered(() => popupAction(app, w, w.locator('.crop-more .action-menu-trigger'), 'Remove photo'));

  // B → C (no photo boxes) → A: the replacement and removal hold, the other photos and their crops return.
  await rerendered(() => layout('Text spread').click());
  assert.equal(await kept(), 'Set aside · 3 photos');
  // The family's preview opens its picker, which starts on the first variant for a spread outside the family.
  const pickerRegion = w.getByRole('region', { name: 'Grid size' });
  const pickerFrame = w.frameLocator('.inline-layout-picker iframe');
  const gridSize = (name) => pickerFrame.getByRole('radio', { name, exact: true });
  const pickerReady = async () => {
    await pickerRegion.waitFor();
    await gridSize('2 × 2').waitFor();
    await w.waitForFunction(() => !document.querySelector('.inline-layout-picker')?.textContent.includes('Loading…'));
  };
  await layout('Photo grid').click();
  await pickerReady();
  assert.equal(await w.locator('dialog.layout-picker-dialog').count(), 0);
  // The canvas and sidebar remain interactive while the inline picker is open.
  assert.equal(await button('Add').isEnabled(), true);
  await rerendered(() => gridSize('2 × 2').click());
  assert.equal(await statusLine(), '');
  state = await settlements();
  assert.deepEqual(Object.fromEntries(Object.entries(state.boxes).map(([id, box]) => [id, box.photo])),
    { hero: replacement, second: undefined, third: 'cottage', fourth: 'light' });
  assert.deepEqual(state.boxes.third.crops, { grid: { centerX: 0.5, centerY: 0.5, zoom: 1.5 } });
  assert.equal(await w.locator('.inspector').getByText(/^Set aside/).count(), 0);

  await rerendered(() => menuAction(app, 'Reload'));
  assert.deepEqual(await settlements(), state);
  assert.deepEqual((await status()).errors, []);
  // A variant is an immediate, single Undo step. No Cancel/Done round trip.
  if (!(await pickerRegion.count())) await button('Grid size…').click();
  await pickerReady();
  assert.equal(await gridSize('2 × 2').getAttribute('aria-checked'), 'true');
  await rerendered(() => gridSize('3 × 3').click());
  assert.equal(await statusLine(), '');
  assert.equal((await settlements()).definition, 'grid9');
  assert.equal(await frame.locator('[data-spread="settlements"] [data-box]').count(), 9);
  assert.equal(await layout('Photo grid').getAttribute('aria-checked'), 'true');
  assert.equal(await picker.getByRole('radio').count(), 8);
  assert.deepEqual((await status()).warnings, []);
  await rerendered(() => button('Undo').click());
  assert.deepEqual(await settlements(), state);

  // Kept content: Place in… moves it into an empty box, or swaps with what a box shows; it never appears twice.
  const title = async (photo) => JSON.parse(await readFile(join(project, 'photos.json'), 'utf8'))[photo].title;
  const replacedTitle = await title(replacement);
  await rerendered(() => layout('Two photos').click());
  assert.equal(await w.locator('.kept-content').getAttribute('open'), null);
  assert.ok(await w.locator('.spread-contents').evaluate((node) => !!(node.compareDocumentPosition(document.querySelector('.kept-content')) & Node.DOCUMENT_POSITION_FOLLOWING)));
  await w.locator('.kept-content > summary').click();
  await w.locator('.spread-thumb[data-spread="arriving"]').click();
  await w.locator('.spread-thumb[data-spread="settlements"]').click();
  assert.equal(await w.locator('.kept-content').getAttribute('open'), '');
  await w.locator('.kept-content > summary').click();
  await w.locator('.spread-thumb[data-spread="arriving"]').click();
  await w.locator('.spread-thumb[data-spread="settlements"]').click();
  assert.equal(await w.locator('.kept-content').getAttribute('open'), null);
  await w.locator('.kept-content > summary').click();
  const keptNames = () => w.locator('.kept-content .kept-name').allTextContents();
  assert.deepEqual(await keptNames(), ['Cottage', 'Evening light']);
  await rerendered(() => w.getByRole('combobox', { name: 'Place Cottage in' }).selectOption('second'));
  assert.equal(await statusLine(), 'Cottage placed in Right photo');
  state = await settlements();
  assert.deepEqual(state.boxes.second, { params: {}, photo: 'cottage', focus: { centerX: 0.5, centerY: 0.5 } });
  assert.deepEqual(state.boxes.third, { params: {} });
  assert.deepEqual(await keptNames(), ['Evening light']);
  const swap = w.getByRole('combobox', { name: 'Place Evening light in' });
  assert.deepEqual(await swap.locator('option').allTextContents(),
    ['Place in…', 'Left photo · swap with ' + replacedTitle, 'Right photo · swap with Cottage']);
  await rerendered(() => swap.selectOption('hero'));
  assert.equal(await statusLine(), 'Evening light placed in Left photo; ' + replacedTitle + ' is saved outside this layout');
  assert.deepEqual(await keptNames(), [replacedTitle]);

  // Dragging a kept item onto a box of its spread moves it the same way.
  const target = await frame.locator('[data-spread="settlements"] [data-box="second"]').boundingBox();
  await rerendered(() => w.evaluate(({ x, y }) => {
    const data = new DataTransfer();
    document.querySelector('.kept-item').dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: data }));
    document.querySelector('main').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: data }));
  }, { x: target.x + target.width / 2, y: target.y + target.height / 2 }));
  assert.equal(await statusLine(), replacedTitle + ' placed in Right photo; Cottage is saved outside this layout');
  assert.equal((await settlements()).boxes.second.photo, replacement);
  assert.deepEqual(await keptNames(), ['Cottage']);

  // Discard removes kept content from the spread (the source stays); Undo brings it back.
  await rerendered(() => w.getByRole('button', { name: 'Discard Cottage' }).click());
  assert.equal(await statusLine(), 'Cottage removed from this spread');
  assert.equal(await w.locator('.kept-content').count(), 0);
  assert.ok(JSON.parse(await readFile(join(project, 'photos.json'), 'utf8')).cottage);
  await rerendered(() => button('Undo').click());
  assert.deepEqual(await keptNames(), ['Cottage']);

  // Story and text spreads declare chapter anchors on the page with their heading; a Contents layout lists them.
  const chapters = [['Arriving', 3], ['A turn in the path', 9], ['From the notebook', 12], ['When it got quiet', 17], ['The last notes', 26]];
  assert.deepEqual((await status()).anchors.map(({ id, title, page }) => [id, title, page]), chapters.map((entry) => ['chapter', ...entry]));
  await rerendered(() => layout('Contents').click());
  assert.deepEqual(await frame.locator('[data-spread="settlements"] .contents li').evaluateAll((items) =>
    items.map((item) => [item.firstElementChild.textContent, Number(item.lastElementChild.textContent)])), chapters);
  await rerendered(() => button('Undo').click());
  assert.equal((await settlements()).definition, 'pair');

  // An ID with two parameter types is a template error naming both layouts.
  const templateFile = join(project, 'template', 'index.tsx');
  const templateSource = await readFile(templateFile, 'utf8');

  // A lookup of an anchor no spread declares is a Book check warning on the spread that asked.
  const contentsLookup = "const chapters = ctx.book.anchors('chapter');";
  assert.ok(templateSource.includes(contentsLookup));
  await rerendered(() => writeFile(templateFile, templateSource.replace(contentsLookup,
    "const chapters = [ctx.book.anchor('map'), ...ctx.book.anchors('chapter')].filter(Boolean);")));
  await rerendered(() => layout('Contents').click());
  const missing = (await status()).warnings.filter(({ code }) => code === 'anchor-missing');
  assert.deepEqual(missing.map(({ spread, details }) => [spread, details.anchor]), [['settlements', 'map']]);
  await rerendered(() => button('Undo').click());
  await rerendered(() => writeFile(templateFile, templateSource));
  const pairParameters = "parameters: { framed: p.boolean({ label: 'White frame', default: false }) },";
  assert.ok(templateSource.includes(pairParameters));
  await writeFile(templateFile, templateSource.replace(pairParameters,
    "parameters: { framed: p.boolean({ label: 'White frame', default: false }), heading: p.integer({ label: 'Heading', default: 1 }) },"));
  await w.waitForFunction(() => /Parameter heading is a string in Title page but an integer in Two photos/
    .test(document.querySelector('.status-error')?.textContent ?? ''), null, { timeout: 30000 });
  await rerendered(() => writeFile(templateFile, templateSource));
  await w.waitForFunction(() => !document.querySelector('.status-error'), null, { timeout: 30000 });
  console.log('ImageFlow layout switching passed.');
} finally {
  await app.close();
  await rm(work, { recursive: true, force: true });
}
