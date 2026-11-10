import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';

// Layout switching (#22): a spread keeps one state for all its layouts; the layout picks what is shown.
const root = fileURLToPath(new URL('../', import.meta.url));
const work = await mkdtemp(join(root, '.build', 'layouts-'));
const project = join(work, 'Book');
const read = async () => JSON.parse(await readFile(join(project, 'project.json'), 'utf8'));
const settlements = async () => (await read()).spreads.find(({ id }) => id === 'settlements');
const app = await _electron.launch({ executablePath: electron, args: [join(root, '.build/desktop'), '--user-data-dir=' + join(work, 'profile')],
  env: { ...process.env, IMAGEFLOW_HIDE_WINDOW: '1' } });
try {
  const w = await app.firstWindow();
  w.setDefaultTimeout(20000);
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
  const section = (label) => w.locator('.inspector details').filter({ has: w.locator(':scope > summary', { hasText: new RegExp('^' + label + '$') }) });
  const setCrop = async (box, values) => {
    const owner = section(box);
    if (await owner.locator('.crop-values').getAttribute('open') === null) await owner.locator('.crop-values > summary').click();
    for (const [label, value] of Object.entries(values)) {
      await rerendered(async () => {
        await owner.getByRole('spinbutton', { name: label, exact: true }).fill(String(value));
        await owner.getByRole('spinbutton', { name: label, exact: true }).press('Enter');
      });
    }
  };
  const kept = () => w.locator('.inspector').getByText(/^Saved outside this layout/).textContent();

  await rerendered(() => button('New project…').click());
  await button('Photo grid 6–7').click();
  await w.locator('[data-spread="settlements"][aria-current="page"]').waitFor();

  // Only layouts with the same footprint are offered: no single title or closing page for a full spread.
  assert.deepEqual(await picker.getByRole('radio').evaluateAll((items) => items.map((item) => item.getAttribute('aria-label'))),
    ['Photo and story', 'Panorama', 'Photo grid', 'Two photos', 'Text spread', 'Calendar spread']);

  // Crops are set per layout; the one set last is the focus other layouts fill around.
  await setCrop('Upper left', { Zoom: 2, Horizontal: 0.3 });
  await setCrop('Lower left', { Zoom: 1.5 });
  assert.deepEqual((await settlements()).boxes.hero.crops, { grid: { centerX: 0.3, centerY: 0.5, zoom: 2 } });
  assert.deepEqual((await settlements()).boxes.hero.focus, { centerX: 0.3, centerY: 0.5 });

  // Pointing at a layout says what switching does, without changing anything.
  const before = await read();
  await layout('Two photos').hover();
  assert.equal(await w.locator('#layout-consequence').textContent(), 'Two photos · 2 photos carried over · 2 photos kept outside this layout');
  await layout('Text spread').focus();
  assert.equal(await w.locator('#layout-consequence').textContent(), 'Text spread · 4 photos kept outside this layout');
  assert.deepEqual(await read(), before);

  // A → B: the shared boxes show, the others stay on the spread without Book check warnings.
  await rerendered(() => layout('Two photos').click());
  assert.equal(await statusLine(), 'Two photos · 2 photos carried over · 2 photos kept outside this layout');
  let state = await settlements();
  assert.equal(state.definition, 'pair');
  assert.deepEqual(Object.fromEntries(Object.entries(state.boxes).map(([id, box]) => [id, box.photo])),
    { hero: 'segla', second: 'shore', third: 'cottage', fourth: 'light' });
  assert.equal(await kept(), 'Saved outside this layout · 2 photos');
  assert.deepEqual((await status()).warnings, []);
  assert.match(await section('Left photo').locator('.crop-controls > p').textContent(), /^Fills the frame · moved · from another layout$/);

  // Undo restores the previous layout in one step, and closes crop mode opened on the switched spread.
  await section('Left photo').getByRole('button', { name: 'Adjust crop…' }).click();
  await w.locator('.crop-editor').waitFor();
  await rerendered(() => button('Undo').click());
  await w.waitForFunction(() => !document.querySelector('.crop-editor'));
  assert.equal((await settlements()).definition, 'grid');
  await rerendered(() => button('Redo').click());
  assert.equal((await settlements()).definition, 'pair');

  // Replacing a photo starts its crop over; removing one is a real edit.
  const replace = section('Left photo').getByRole('combobox', { name: 'Replace photo in Left photo' });
  const replacement = await replace.locator('option:not([value=""]):not([disabled])').first().getAttribute('value');
  await rerendered(() => replace.selectOption(replacement));
  assert.deepEqual((await settlements()).boxes.hero, { photo: replacement, params: {} });
  await rerendered(() => section('Right photo').getByRole('button', { name: 'Remove' }).click());

  // B → C (no photo boxes) → A: the replacement and removal hold, the other photos and their crops return.
  await rerendered(() => layout('Text spread').click());
  assert.equal(await kept(), 'Saved outside this layout · 3 photos');
  await rerendered(() => layout('Photo grid').click());
  assert.equal(await statusLine(), 'Photo grid · 3 photos shown again');
  state = await settlements();
  assert.deepEqual(Object.fromEntries(Object.entries(state.boxes).map(([id, box]) => [id, box.photo])),
    { hero: replacement, second: undefined, third: 'cottage', fourth: 'light' });
  assert.deepEqual(state.boxes.third.crops, { grid: { centerX: 0.5, centerY: 0.5, zoom: 1.5 } });
  assert.equal(await w.locator('.inspector').getByText(/^Saved outside this layout/).count(), 0);

  // Everything above is in project.json: reloading shows the same book.
  await rerendered(() => button('Reload').click());
  assert.deepEqual(await settlements(), state);
  assert.deepEqual((await status()).errors, []);

  // Kept content: Place in… moves it into an empty box, or swaps with what a box shows; it never appears twice.
  const title = async (photo) => JSON.parse(await readFile(join(project, 'photos.json'), 'utf8'))[photo].title;
  const replacedTitle = await title(replacement);
  await rerendered(() => layout('Two photos').click());
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

  // An ID with two parameter types is a template error naming both layouts.
  const templateFile = join(project, 'template', 'index.tsx');
  const templateSource = await readFile(templateFile, 'utf8');
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
