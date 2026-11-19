import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';
import { PDFDocument } from 'pdf-lib';
import { copySample } from '../desktop/sample-book.mjs';
import { closeApp, exportAction, menuAction, pickLayout, testBook } from './ui-actions.mjs';

// ADR 0009 phases 3–5: page checks, selection, Inspector, layout changes, swap, Undo and export through the real app.
const root = fileURLToPath(new URL('../', import.meta.url));
const work = await mkdtemp(join(root, '.build', 'page-layouts-'));
const folder = join(work, 'Pages.imageflow');
let app;
try {
  await copySample(join(root, 'sample/starter'), folder);
  await writeFile(join(folder, 'template/index.tsx'), `import { box, defineTemplate, issue, mm, p, Page, Spread, printFormat } from 'imageflow';
import './styles.css';
import type { RenderContext } from 'imageflow';
const full = (ctx: RenderContext) => <Spread style={{ fontFamily: 'Field Serif' }}><ctx.Text parameter="heading" rect={ctx.geometry.page('left', 'safe')} /></Spread>;
const pageSettings = { heading: p.string({ label: 'Heading', default: '' }), note: p.string({ label: 'Page note', default: '' }) };
const settings = { hidden: p.boolean({ label: 'Spread-only option', default: false }), heading: p.string({ label: 'Heading', default: '' }) };
export default defineTemplate({ id: 'page-smoke', version: '1', contract: 1,
  format: printFormat({ label: 'Pages', trim: { width: mm(100), height: mm(100) }, bleed: { all: mm(3), binding: mm(0) },
    safe: mm(8), ends: 'inside-covers', pageCount: { min: 4, max: 4, step: 2 } }),
  layoutFamilies: { full: { label: 'Full layouts', picker: { component: ({ variants, current, choose }) => <div>{variants.map(variant => <button key={variant.id} type="button" aria-pressed={current === variant.id} onClick={() => choose(variant.id)}>{variant.label}</button>)}</div> } },
    text: { label: 'Text', picker: { component: ({ variants, current, choose }) => <div>{variants.map(variant => <button key={variant.id} type="button" aria-pressed={current === variant.id} onClick={() => choose(variant.id)}>{variant.label}</button>)}</div> } } },
  spreads: ({ spread, page }) => ({ full: spread({ label: 'Full', family: 'full', variant: { kind: 'full' }, parameters: settings, render: full }),
    other: spread({ label: 'Other', family: 'full', variant: { kind: 'other' }, parameters: settings, render: full }),
    text: page({ label: 'Text', family: 'text', variant: { kind: 'default' }, parameters: pageSettings,
      render: ctx => { ctx.book.anchor('missing'); return <Page style={{ fontFamily: 'Field Serif' }}>
        <div {...issue({ code: 'page-warning', message: 'Page warning', parameter: 'heading' })} />
        <ctx.Text parameter="heading" rect={ctx.geometry.page('safe')} />
      </Page>; } }),
    textAlt: page({ label: 'Text alternate', family: 'text', variant: { kind: 'alternate' }, parameters: pageSettings, render: ctx => <Page style={{ fontFamily: 'Field Serif' }}><ctx.Text parameter="heading" rect={ctx.geometry.page('safe')} /></Page> }),
    leftOnly: page({ label: 'Left only', sides: ['left'], parameters: pageSettings, render: ctx => <Page><ctx.Text parameter="heading" rect={ctx.geometry.page('safe')} /></Page> }),
    story: page({ label: 'Story', parameters: pageSettings, boxes: { story: box.markdown('Story') }, render: ctx => <Page style={{ fontFamily: 'Field Serif' }}><ctx.MarkdownBox id="story" rect={ctx.geometry.page('safe')} /></Page> })
  }) });`);
  const page = (heading) => ({ definition: 'text', params: { heading, note: heading + ' note' }, boxes: {}, elements: {} });
  const sheet = (id, pages) => ({ id, definition: 'full', split: true, params: {}, boxes: {}, elements: {}, pages });
  await writeFile(join(folder, 'project.json'), JSON.stringify({ schemaVersion: 2, title: 'Pages', template: { id: 'page-smoke', version: '1' },
    texts: { arrival: 'texts/arrival.md', notebook: 'texts/notebook.md' },
    spreads: [{ ...sheet('pair', { left: page('Left'), right: page('Right') }), displaced: [
      { from: 'left', box: 'story', state: { text: 'arrival', params: {} } },
      { from: 'right', box: 'story', state: { text: 'notebook', params: {} } },
    ] }, sheet('blank', { left: page('Alone') })] }));
  app = await _electron.launch({ executablePath: electron, args: [join(root, '.build/desktop'), '--user-data-dir=' + join(work, 'profile')],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, IMAGEFLOW_HIDE_WINDOW: '1' } });
  const w = await testBook(app, folder);
  const ready = 'iframe.book-frame-book[data-current][data-ready]';
  await w.waitForSelector(ready, { state: 'attached' });
  const frame = w.frameLocator(ready);
  const status = await frame.locator('body').evaluate(() => window.imageflowRenderStatus);
  assert.equal(status.state, 'ready', JSON.stringify(status));
  assert.deepEqual(status.errors, []);
  assert.equal(status.pages, 4);
  for (const code of ['template:page-warning', 'anchor-missing']) {
    assert.deepEqual(status.warnings.filter(f => f.spread === 'pair' && f.code === code).map(f => f.page).sort(), ['left', 'right']);
  }
  assert.equal(await frame.locator('.if-sheet').count(), 2);
  assert.equal(await frame.locator('[data-if-page]').count(), 4);
  assert.equal(await frame.locator('[data-spread="pair"] [data-if-page="left"] [data-edit="heading"]').textContent(), 'Left');
  assert.equal(await frame.locator('[data-spread="pair"] [data-if-page="right"] [data-edit="heading"]').textContent(), 'Right');
  assert.equal(await frame.locator('[data-spread="blank"] [data-if-page="right"] .if-page').count(), 0);
  const inspector = w.getByRole('complementary', { name: 'Inspector', exact: true });
  const readBook = async () => JSON.parse(await readFile(join(folder, 'project.json'), 'utf8'));
  const rerendered = async (action) => {
    const before = await w.locator(ready).getAttribute('data-revision');
    await action();
    await w.waitForFunction((before) => {
      const frame = document.querySelector('iframe.book-frame-book[data-current][data-ready]');
      return frame && frame.getAttribute('data-revision') !== before;
    }, before);
  };
  const choose = async (name) => rerendered(() => inspector.getByRole('radio', { name, exact: true }).click());
  const selectSide = async (id, side) => {
    await w.locator('.sheet-label[data-canvas-spread="' + id + '"]').scrollIntoViewIfNeeded();
    const rect = await frame.locator('[data-spread="' + id + '"] .if-sheet').boundingBox();
    assert.ok(rect);
    // Select the side on paper outside any editable artwork.
    await w.mouse.click(rect.x + rect.width * (side === 'left' ? .2 : .8), rect.y + 5);
  };
  await selectSide('pair', 'left');
  assert.equal(await inspector.locator('.inspector-layout-structure').count(), 0);
  assert.equal(await w.locator('.sheet-label.selected .sheet-layout-mode').getAttribute('aria-label'), 'Two page layouts');
  assert.equal(await w.locator('.facing-page-selection').count(), 1);
  const modeIcon = w.locator('.sheet-label.selected .sheet-layout-mode');
  assert.equal(await modeIcon.locator('[data-page-side=left]').getAttribute('stroke'), 'var(--accent)');
  assert.equal(await modeIcon.locator('[data-page-side=right]').getAttribute('stroke'), 'var(--muted)');
  const pairedOutline = await w.locator('.sheet-selection').boundingBox();
  const pairedSheet = await frame.locator('[data-spread="pair"] .if-sheet').boundingBox();
  assert.ok(Math.abs(pairedOutline.width * 2 - pairedSheet.width) < 2);
  await inspector.getByRole('textbox', { name: 'Page note', exact: true }).waitFor();
  assert.equal(await inspector.getByRole('textbox', { name: 'Page note', exact: true }).inputValue(), 'Left note');
  assert.equal(await inspector.getByRole('checkbox', { name: 'Spread-only option', exact: true }).count(), 0);
  await inspector.getByRole('radio', { name: 'Text', exact: true }).waitFor();
  assert.equal(await inspector.getByRole('radio', { name: 'Text', exact: true }).getAttribute('aria-checked'), 'true');
  await inspector.getByRole('radiogroup', { name: 'Layout', exact: true }).waitFor();
  assert.equal(await inspector.getByRole('radio').evaluateAll(nodes => nodes.some(node => node.hasAttribute('title'))), false);
  assert.equal(await inspector.locator('.layout-option-variants svg').first().getAttribute('width'), '16');
  const previewSelector = 'iframe[title="Layout previews"][data-current][data-ready]';
  await inspector.locator(previewSelector).waitFor({ state: 'attached' });
  const previews = inspector.frameLocator(previewSelector);
  assert.equal(await previews.locator('body').evaluate(() => window.imageflowRenderStatus.state), 'ready');
  const geometry = await previews.locator('.if-spread-container').evaluateAll(nodes => nodes.map(node => ({
    units: Number(node.dataset.layoutUnits), id: node.dataset.spread, rect: (() => { const r = node.querySelector('.if-sheet').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })(),
  })));
  const full = geometry.find(item => item.units === 2), single = geometry.find(item => item.units === 1);
  assert.ok(full && single);
  assert.ok(Math.abs(full.rect.width - (single.rect.width * 2 + 10)) < 2, 'One grid fits two spreads or four pages with the same gap');
  assert.ok(geometry.some(item => item.id === '__blank__' && item.units === 1));
  assert.equal(await previews.locator('.if-blank-layout').count(), 1);
  assert.equal(await inspector.getByRole('radio', { name: 'Blank page', exact: true }).count(), 1);
  await w.locator('main.canvas').focus();
  await w.keyboard.press('ArrowRight');
  await w.waitForFunction(() => [...document.querySelectorAll('.inspector input')].some(input => input.value === 'Right note'));
  assert.equal(await modeIcon.locator('[data-page-side=right]').getAttribute('stroke'), 'var(--accent)');
  assert.equal(await modeIcon.locator('[data-page-side=left]').getAttribute('stroke'), 'var(--muted)');
  await w.keyboard.press('ArrowLeft');
  await w.waitForFunction(() => [...document.querySelectorAll('.inspector input')].some(input => input.value === 'Left note'));
  const remembered = inspector.getByRole('radio', { name: 'Full layouts', exact: true });
  assert.equal(await remembered.getAttribute('aria-checked'), 'false');
  const stablePageNames = await inspector.getByRole('radio').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')));
  await selectSide('pair', 'right');
  assert.equal(await inspector.getByRole('radio', { name: 'Left only', exact: true }).isDisabled(), true);
  assert.deepEqual(await inspector.getByRole('radio').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label'))), stablePageNames);
  const note = inspector.getByRole('textbox', { name: 'Page note', exact: true });
  assert.equal(await note.inputValue(), 'Right note');
  await rerendered(async () => { await note.fill('Right Inspector edit'); await note.press('Tab'); });
  assert.equal((await readBook()).spreads[0].pages.right.params.note, 'Right Inspector edit');
  assert.equal((await readBook()).spreads[0].pages.left.params.note, 'Left note');
  console.log('Page layout render, side selection and Inspector checks passed.');
  const beforePageVariant = (await readBook()).spreads[0];
  const pageFamily = inspector.frameLocator('iframe.element-editor-frame');
  await pageFamily.getByRole('button', { name: 'Text alternate', exact: true }).waitFor();
  await pickLayout(w, pageFamily.getByRole('button', { name: 'Text alternate', exact: true }));
  assert.equal((await readBook()).spreads[0].pages.right.definition, 'textAlt');
  assert.deepEqual((await readBook()).spreads[0].pages.left, beforePageVariant.pages.left);
  await rerendered(() => menuAction(app, 'Undo Book Edit'));
  assert.deepEqual((await readBook()).spreads[0], beforePageVariant);
  console.log('Page family picker and Undo passed.');
  // The normal page popover edits only the clicked side.
  const text = frame.locator('[data-spread="pair"] [data-if-page="right"] [data-edit="heading"]');
  const box = await text.boundingBox();
  assert.ok(box);
  await w.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await w.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const input = w.locator('.edit-popover').getByRole('textbox', { name: 'Heading', exact: true });
  const beforeSave = await w.locator(ready).getAttribute('data-revision');
  await input.fill('Edited right');
  await input.press('Enter');
  await w.keyboard.press('Escape');
  await w.waitForFunction((before) => {
    const frame = document.querySelector('iframe.book-frame-book[data-current][data-ready]');
    return frame && frame.getAttribute('data-revision') !== before;
  }, beforeSave);
  const saved = JSON.parse(await readFile(join(folder, 'project.json'), 'utf8'));
  assert.equal(saved.spreads[0].pages.right.params.heading, 'Edited right');
  assert.equal(saved.spreads[0].pages.left.params.heading, 'Left');
  assert.deepEqual(saved.spreads[0].params, {});
  const pdfPath = join(work, 'Pages.pdf');
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, pdfPath);
  await exportAction(w);
  await w.waitForFunction(() => document.querySelector('.status-error') || (document.querySelector('.status')?.textContent ?? '').startsWith('PDF saved'), null, { timeout: 120000 });
  assert.match(await w.locator('.status').textContent(), /^PDF saved/);
  assert.equal((await PDFDocument.load(await readFile(pdfPath))).getPageCount(), 4);
  console.log('Independent inline editing and PDF export passed.');
  assert.equal(await inspector.getByRole('button', { name: 'Swap pages', exact: true }).count(), 0);
  assert.equal(await inspector.locator('details > summary').first().textContent(), 'Layout');
  // Swap whole page states through Book > Swap Pages; Undo restores them exactly.
  const beforeSwap = (await readBook()).spreads[0];
  await rerendered(() => menuAction(app, 'Swap Pages'));
  let changed = (await readBook()).spreads[0];
  assert.deepEqual(changed.pages.left, beforeSwap.pages.right);
  assert.deepEqual(changed.pages.right, beforeSwap.pages.left);
  await rerendered(() => menuAction(app, 'Undo Book Edit'));
  assert.deepEqual((await readBook()).spreads[0], beforeSwap);

  // Choosing a spread layout merges from the selected right page, with one-step Undo.
  await choose('Full layouts');
  let merged = (await readBook()).spreads[0];
  assert.equal(merged.split, undefined);
  assert.equal(await inspector.locator('.inspector-layout-structure').count(), 0);
  assert.equal(await w.locator('.sheet-label.selected .sheet-layout-mode').getAttribute('aria-label'), 'Spread layout');
  assert.equal(await w.locator('.facing-page-selection').count(), 0);
  const fullOutline = await w.locator('.sheet-selection').boundingBox();
  const fullSheet = await frame.locator('[data-spread="pair"] .if-sheet').boundingBox();
  assert.ok(Math.abs(fullOutline.width - fullSheet.width) < 2);
  const activeHalf = w.locator('.active-spread-page');
  assert.equal(await activeHalf.getAttribute('data-page'), 'right');
  assert.ok(Math.abs((await activeHalf.boundingBox()).width * 2 - fullSheet.width) < 2);
  await selectSide('pair', 'left');
  assert.equal(await activeHalf.getAttribute('data-page'), 'left');
  await selectSide('pair', 'right');
  assert.equal(await activeHalf.getAttribute('data-page'), 'right');

  assert.equal(merged.params.heading, 'Edited right');
  assert.equal(await inspector.getByRole('checkbox', { name: 'Spread-only option', exact: true }).isEnabled(), true);
  const family = inspector.frameLocator('iframe.element-editor-frame');
  await family.getByRole('button', { name: 'Other', exact: true }).waitFor();
  await pickLayout(w, family.getByRole('button', { name: 'Other', exact: true }));
  assert.equal((await readBook()).spreads[0].definition, 'other');
  await rerendered(() => menuAction(app, 'Undo Book Edit'));
  assert.deepEqual((await readBook()).spreads[0], merged);

  await rerendered(() => menuAction(app, 'Undo Book Edit'));
  assert.deepEqual((await readBook()).spreads[0], beforeSwap);

  // The blank page keeps remembered content; changing the other page never changes the facing page.
  await choose('Blank page');
  changed = (await readBook()).spreads[0];
  assert.equal(changed.pages.right.definition, undefined);
  assert.deepEqual(changed.pages.left, beforeSwap.pages.left);
  await choose('Text');
  assert.deepEqual((await readBook()).spreads[0].pages.left, beforeSwap.pages.left);
  assert.equal((await readBook()).spreads[0].pages.right.params.heading, 'Edited right');

  await selectSide('pair', 'left');
  await choose('Left only');
  assert.equal(await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('swap-pages').enabled), false);
  await rerendered(() => menuAction(app, 'Undo Book Edit'));

  // Merge, then use the page-layout radio to split the right half through the real editor.
  await selectSide('pair', 'right');
  await choose('Full layouts');
  const beforeSplit = (await readBook()).spreads[0];
  await choose('Text');
  changed = (await readBook()).spreads[0];
  assert.equal(changed.split, true);
  assert.equal(changed.pages.right.definition, 'text');
  assert.equal(changed.pages.right.params.heading, 'Edited right');
  await rerendered(() => menuAction(app, 'Undo Book Edit'));
  assert.deepEqual((await readBook()).spreads[0], beforeSplit);
  await rerendered(() => menuAction(app, 'Undo Book Edit'));

  // Dragging a page layout to the opposite half uses the pointer's side, not current selection.
  await selectSide('pair', 'left');
  const rect = await frame.locator('[data-spread="pair"] .if-sheet').boundingBox();
  assert.ok(rect);
  const drag = await w.evaluateHandle(() => new DataTransfer());
  await inspector.getByRole('radio', { name: 'Story', exact: true }).dispatchEvent('dragstart', { dataTransfer: drag });
  await rerendered(async () => {
    await w.locator('main.canvas').dispatchEvent('drop', { dataTransfer: drag, clientX: rect.x + rect.width * .75, clientY: rect.y + 10 });
  });
  changed = (await readBook()).spreads[0];
  assert.equal(changed.pages.right.definition, 'story');
  assert.equal(changed.pages.left.definition, 'text');
  // Replaced assignments are addressed by their own location/index even when both have the same box ID.
  const displacedBefore = structuredClone(changed.displaced);
  await inspector.locator('details.kept-content').filter({ hasText: 'Replaced' }).locator('summary').click();
  const arrival = inspector.locator('.kept-item').filter({ hasText: 'arrival.md' });
  await rerendered(() => arrival.locator('select').selectOption({ index: 1 }));
  changed = (await readBook()).spreads[0];
  assert.equal(changed.pages.right.boxes.story.text, 'arrival');
  assert.equal(changed.displaced.length, 1);
  assert.equal(changed.displaced[0].state.text, 'notebook');
  await rerendered(() => menuAction(app, 'Undo Book Edit'));
  assert.deepEqual((await readBook()).spreads[0].displaced, displacedBefore);
  const notebook = inspector.locator('.kept-item').filter({ hasText: 'notebook.md' });
  await rerendered(() => notebook.getByRole('button', { name: 'Discard notebook.md', exact: true }).click());
  assert.equal((await readBook()).spreads[0].displaced.length, 1);
  assert.equal((await readBook()).spreads[0].displaced[0].state.text, 'arrival');
  await rerendered(() => menuAction(app, 'Undo Book Edit'));
  assert.deepEqual((await readBook()).spreads[0].displaced, displacedBefore);
  await drag.dispose();
  await rerendered(() => menuAction(app, 'Undo Book Edit'));

  console.log('Layout switching, drag targeting and replaced content passed.');
  // Opening and closing units use ordinary page layouts, without creating a split state.
  const endsFolder = join(work, 'Ends.imageflow');
  await copySample(join(root, 'sample/starter'), endsFolder);
  const templateSource = await readFile(join(folder, 'template/index.tsx'), 'utf8');
  await writeFile(join(endsFolder, 'template/index.tsx'), templateSource.replace("ends: 'inside-covers'", "ends: 'single-pages'"));
  await writeFile(join(endsFolder, 'project.json'), JSON.stringify({ schemaVersion: 2, title: 'End pages', template: { id: 'page-smoke', version: '1' },
    spreads: [{ id: 'opening', ...page('Opening') }, sheet('middle', { left: page('Middle left'), right: page('Middle right') }), { id: 'closing', ...page('Closing') }] }));
  const endsWindow = await testBook(app, endsFolder);
  await endsWindow.waitForSelector(ready, { state: 'attached' });
  const endsInspector = endsWindow.getByRole('complementary', { name: 'Inspector', exact: true });
  assert.equal(await endsInspector.locator('.inspector-layout-structure').count(), 0);
  assert.equal(await endsWindow.locator('.facing-page-selection').count(), 0);
  await endsInspector.getByRole('textbox', { name: 'Page note', exact: true }).waitFor();
  assert.equal(await endsInspector.getByRole('textbox', { name: 'Page note', exact: true }).inputValue(), 'Opening note');
  assert.equal(await endsInspector.getByRole('radio', { name: 'Left only', exact: true }).isDisabled(), true);
  await endsInspector.getByRole('radio', { name: 'Story', exact: true }).click();
  await endsWindow.frameLocator(ready).locator('[data-spread="opening"] [data-box="story"]').waitFor();
  const endsSaved = JSON.parse(await readFile(join(endsFolder, 'project.json'), 'utf8'));
  assert.equal(endsSaved.spreads[0].definition, 'story');
  assert.equal(endsSaved.spreads[0].split, undefined);
  assert.equal(endsSaved.spreads[0].pages, undefined);
  assert.equal(endsSaved.spreads[0].params.note, 'Opening note');
  assert.equal(endsSaved.spreads[2].definition, 'text');

  // A template containing only page() layouts can create a book without a dummy spread layout.
  for (const endStyle of ['inside-covers', 'single-pages']) {
    console.log('Checking page-only creation: ' + endStyle);
    const onlyFolder = join(work, 'Only-' + endStyle + '.imageflow');
    await copySample(join(root, 'sample/starter'), onlyFolder);
    await writeFile(join(onlyFolder, 'template/index.tsx'), `import { defineTemplate, mm, p, Page, printFormat } from 'imageflow';
import './styles.css';
export default defineTemplate({ id: 'only-pages', version: '1', contract: 1,
  format: printFormat({ label: 'Only pages', trim: { width: mm(100), height: mm(100) }, bleed: mm(3), safe: mm(8),
    ends: '${endStyle}', pageCount: { min: 2, max: 100, step: 2 } }),
  spreads: ({ page }) => ({ only: page({ label: 'Only page', parameters: { heading: p.string({ label: 'Heading', default: 'New page' }) },
    render: ctx => <Page style={{ fontFamily: 'Field Serif' }}><ctx.Text parameter="heading" rect={ctx.geometry.page('safe')} /></Page> }) }) });`);
    await writeFile(join(onlyFolder, 'project.json'), JSON.stringify({ schemaVersion: 1, title: 'Only pages',
      template: { id: 'only-pages', version: '1' }, spreads: [] }));
    const onlyWindow = await testBook(app, onlyFolder);
    await onlyWindow.getByRole('group', { name: 'Layouts for the first spread' }).getByRole('button', { name: 'Only page', exact: true }).click().catch(async error => { console.error(await onlyWindow.locator('body').innerText()); throw error; });
    const onlyFrame = onlyWindow.frameLocator(ready);
    await onlyFrame.locator('.if-sheet').waitFor();
    let onlySaved = JSON.parse(await readFile(join(onlyFolder, 'project.json'), 'utf8'));
    assert.equal(onlySaved.spreads.length, 1);
    if (endStyle === 'inside-covers') {
      assert.equal(onlySaved.spreads[0].split, true);
      assert.equal(onlySaved.spreads[0].pages.left.definition, 'only');
      assert.equal(onlySaved.spreads[0].pages.right?.definition, undefined);
    } else {
      assert.equal(onlySaved.spreads[0].definition, 'only');
      assert.equal(onlySaved.spreads[0].split, undefined);
    }
    await onlyWindow.getByRole('button', { name: 'Add', exact: true }).click();
    await onlyFrame.locator('.if-sheet').nth(1).waitFor();
    onlySaved = JSON.parse(await readFile(join(onlyFolder, 'project.json'), 'utf8'));
    assert.equal(onlySaved.spreads.length, 2);
    assert.equal(onlySaved.spreads[1].split, endStyle === 'inside-covers' ? true : undefined);
    if (endStyle === 'inside-covers') assert.equal(onlySaved.spreads[1].pages.left.definition, 'only');
    else {
      assert.equal(onlySaved.spreads[1].definition, 'only');
      await onlyWindow.getByRole('button', { name: 'Add', exact: true }).click();
      await onlyFrame.locator('.if-sheet').nth(2).waitFor();
      onlySaved = JSON.parse(await readFile(join(onlyFolder, 'project.json'), 'utf8'));
      assert.equal(onlySaved.spreads.length, 3);
      assert.equal(onlySaved.spreads[0].split, undefined);
      assert.equal(onlySaved.spreads[1].split, true);
      assert.equal(onlySaved.spreads[1].pages.left.definition, 'only');
      assert.equal(onlySaved.spreads[2].split, undefined);
    }
  }

  console.log('Page layouts: side selection, page Inspector, unified preview grid, split/merge, blank pages, swap restrictions, drag targeting, replaced-content placement/discard, end pages, page-only book creation, Undo and four-page PDF passed.');
} finally {
  if (app) await closeApp(app);
  await rm(work, { recursive: true, force: true });
}
