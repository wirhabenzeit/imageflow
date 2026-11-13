import { testBook, menuAction } from './ui-actions.mjs';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';

// Generated files (ADR 0006): an element editor draws a PNG, stores it with saveFile and assigns it; the layout
// draws it with imageFile(); the Book check judges its resolution; Undo keeps it; closing collects unused files.
const root = fileURLToPath(new URL('../', import.meta.url));
const work = await mkdtemp(join(root, '.build', 'generated-files-'));
const folder = join(work, 'book.imageflow');
await mkdir(join(folder, 'template'), { recursive: true });
await writeFile(join(folder, 'template/index.tsx'), `import { defineTemplate, imageFile, mm, p, Spread, Element } from 'imageflow';
const parameters = { snapshot: p.file({ label: 'Snapshot', accept: ['.png'] }) };
// Draws a solid PNG of the given width and stores it in the book.
function SnapshotEditor({ set, saveFile }) {
  const generate = async (width) => {
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = Math.round(width / 2);
    const context = canvas.getContext('2d');
    context.fillStyle = '#2a7'; context.fillRect(0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    const id = await saveFile(blob, { name: 'snapshot.png' });
    if (id) set({ snapshot: id });
  };
  return <div>
    <button type="button" onClick={() => generate(40)}>Small snapshot</button>
    <button type="button" onClick={() => generate(1400)}>Large snapshot</button>
  </div>;
}
export default defineTemplate({ id: 'generated-files-test', version: '1', contract: 1, requires: ['image-files', 'editor-save-file'],
  format: { label: 'Square', trim: { width: mm(150), height: mm(150) },
    bleed: { top: mm(3), bottom: mm(3), outside: mm(3), binding: mm(0) }, safe: { top: mm(8), bottom: mm(8), outside: mm(8), binding: mm(8) },
    structure: { delivery: 'pages', ends: 'inside-covers', pageCount: { min: 2, max: 100, step: 2 } },
    output: { container: 'pdf', colorSpace: 'sRGB', transparency: 'allow', resolution: { minimum: 150, target: 300, maximum: 600 } } },
  spreads: { main: { label: 'Map', elements: { map: { label: 'Map', parameters,
    editor: { label: 'Edit snapshot', parameters: ['snapshot'], component: SnapshotEditor } } },
    render: (ctx) => {
      const image = imageFile(ctx.elements.map.params.snapshot);
      return <Spread><Element id="map" style={{ position: 'absolute', left: '20mm', top: '20mm', width: '100mm', height: '50mm', background: '#eee' }}>
        {image ? <img src={image.url} alt="" style={{ width: '100%', height: '100%', display: 'block' }} data-width={image.width} /> : 'No snapshot'}
      </Element></Spread>;
    } } } });
`);
await writeFile(join(folder, 'project.json'), JSON.stringify({ schemaVersion: 1, title: 'Generated', template: { id: 'generated-files-test', version: '1' },
  spreads: [{ id: 'one', definition: 'main' }] }));
await writeFile(join(folder, 'photos.json'), '{}');

const generatedFiles = async () => (await readdir(join(folder, 'files')).catch(() => [])).filter((name) => name.startsWith('gn-')).sort();
const saved = async () => JSON.parse(await readFile(join(folder, 'project.json'), 'utf8'));
const snapshot = async () => (await saved()).spreads[0].elements?.map?.params?.snapshot;
const exists = (path) => access(path).then(() => true, () => false);

const app = await _electron.launch({ executablePath: electron, args: [join(root, '.build/desktop'), '--user-data-dir=' + join(work, 'profile')],
  env: { ...process.env, IMAGEFLOW_HIDE_WINDOW: '1' } });
try {
  const w = await testBook(app, folder);
  w.setDefaultTimeout(30000);
  if (process.env.DEBUG_SMOKE) w.on('console', (m) => console.log('console:', m.type(), m.text().slice(0, 300)));
  const frame = w.frameLocator('iframe.book-frame-book[data-current]');
  const editor = w.frameLocator('iframe.element-editor-frame');
  const dialog = w.getByRole('dialog', { name: 'Edit snapshot' });
  const until = async (check, message) => {
    for (let i = 0; i < 150; i++) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 100)); }
    assert.fail(message + ' Files: ' + (await generatedFiles()).join(', '));
  };
  await w.locator('iframe.book-frame-book[data-current][data-ready]').waitFor();
  // The canvas lies over the frame, so click where the element is drawn, as the editor's own tests do.
  const map = await frame.locator('[data-element="map"]').boundingBox();
  await w.mouse.click(map.x + map.width / 2, map.y + map.height / 2);
  await dialog.waitFor();
  await w.waitForFunction(() => !document.querySelector('.element-editor .ee-status.muted'));
  await editor.getByRole('button', { name: 'Small snapshot' }).waitFor();

  // Saving makes a new gn- file in files/ and the editor assigns it; the page draws it at its pixel size.
  await editor.getByRole('button', { name: 'Small snapshot' }).click();
  await until(async () => /^gn-/.test(await snapshot() ?? ''), 'The small snapshot was assigned.');
  const small = await snapshot();
  assert.deepEqual(await generatedFiles(), [small + '-snapshot.png']);
  const drawn = (id) => frame.locator('[data-element="map"] img[data-width]').evaluate((img, id) =>
    img.complete && img.naturalWidth > 0 && img.src.endsWith('/file/' + id) ? img.naturalWidth : 0, id).catch(() => 0);
  await until(async () => await drawn(small) === 40, 'The page draws the small snapshot.');

  // A second snapshot is another file; Undo can still restore the first, so both stay.
  await editor.getByRole('button', { name: 'Large snapshot' }).click();
  await until(async () => (await snapshot()) !== small, 'The large snapshot was assigned.');
  const large = await snapshot();
  assert.deepEqual(await generatedFiles(), [large + '-snapshot.png', small + '-snapshot.png'].sort());
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  await until(async () => await drawn(large) === 1400, 'The page draws the large snapshot.');

  // The Book check judges image files like photos: 40 px across 100 mm is far below 150 ppi.
  const check = (draft) => w.evaluate(async (draft) => {
    for (let i = 0; i < 100; i++) {
      // The newest book frame renders the active project; until it is current, the check names an older one.
      const frames = [...document.querySelectorAll('iframe.book-frame-book[data-ready]:not([aria-hidden="true"])')];
      const id = new URL(frames.at(-1).src).pathname.split('/').at(-1);
      const result = await window.imageflow.checkBook(id, draft ? { draft } : {});
      if (result.value) return result.value;
      if (!/finishing another operation|project changed/.test(result.error)) throw new Error(result.error);
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (i === 99) throw new Error(result.error + ' ' + frames.map((f) => f.getAttribute('src') + ' ' + f.className).join('; '));
    }
  }, draft);
  const lowFindings = (result) => result.diagnostics.filter((d) => d.code === 'file-image-resolution-low');
  assert.deepEqual(lowFindings(await check()), [], 'A 1400 px image across 100 mm is about 356 ppi.');
  await menuAction(app, 'Undo Project Edit');
  await until(async () => (await snapshot()) === small, 'Undo restores the small snapshot.');
  await until(async () => await drawn(small) === 40, 'The page draws the small snapshot again.');
  const low = lowFindings(await check());
  assert.equal(low.length, 1, JSON.stringify(low));
  assert.equal(low[0].severity, 'error');
  assert.equal(low[0].location.element, 'map');
  assert.equal(low[0].details.ppi, 10);
  // Redo can bring the large snapshot back, so it is kept until the window closes.
  assert.ok(await exists(join(folder, 'files', large + '-snapshot.png')));

  // Closing ends Undo and Redo: the large snapshot is no longer referenced and goes; the assigned one stays.
  await w.close({ runBeforeUnload: true });
  await until(async () => (await generatedFiles()).length === 1, 'Closing removes the unreferenced snapshot.');
  assert.deepEqual(await generatedFiles(), [small + '-snapshot.png']);
  assert.deepEqual(Object.keys((await saved()).files), [small]);
  console.log('ImageFlow generated files passed.');
} finally {
  await app.close();
  await rm(work, { recursive: true, force: true });
}
