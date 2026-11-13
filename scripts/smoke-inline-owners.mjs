import { testBook, menuAction } from './ui-actions.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import electron from 'electron';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright-core';

// Every box, element and marked node of a spread has an editor that opens from the sidebar's list, by identity:
// elements sharing a rectangle each edit their own values, one the layout leaves off the page still opens, a
// setting marked on a photo stays editable in the photo's toolbar, and standalone ctx.Text nodes are reachable
// from the keyboard. A field shown twice keeps the selected occurrence outlined, and Tab reaches both.
const root = fileURLToPath(new URL('../', import.meta.url));
const work = await mkdtemp(join(root, '.build', 'owners-'));
const project = join(work, 'Book.imageflow');
const read = async () => JSON.parse(await readFile(join(project, 'project.json'), 'utf8'));
const app = await _electron.launch({ executablePath: electron, args: [join(root, '.build/desktop'), '--user-data-dir=' + join(work, 'profile')],
  env: { ...process.env, IMAGEFLOW_HIDE_WINDOW: '1' } });
try {
  const w = await testBook(app, project, true);
  w.setDefaultTimeout(20000);
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, project);
  const ready = () => w.waitForSelector('iframe.book-frame-book[data-current][data-ready]');
  await ready();
  const saved = (text) => w.waitForFunction((text) => document.querySelector('.status')?.textContent === text, text);
  const docked = async (panel) => {
    const canvas = await w.locator('.canvas-wrap').boundingBox(), controls = await panel.boundingBox();
    assert.ok(Math.abs(controls.x + controls.width / 2 - canvas.x - canvas.width / 2) < 2, 'Item controls are centered in the canvas');
    assert.ok(Math.abs(canvas.y + canvas.height - controls.y - controls.height - 16) < 2, 'Item controls share the bottom inset');
    assert.ok(controls.y >= canvas.y && controls.x >= canvas.x && controls.x + controls.width <= canvas.x + canvas.width, 'Controls fit inside the canvas');
  };

  // Probes: two elements at the same rectangle and one never rendered on the title page; a spread setting marked
  // on the story's photo.
  const templateFile = join(project, 'template', 'index.tsx');
  const source = await readFile(templateFile, 'utf8');
  const titleParameters = "parameters: { heading, subtitle: p.string({ label: 'Subtitle', default: 'A book made in ImageFlow' }) },";
  const titleText = `<ctx.Text parameter="subtitle" className="subtitle" rect={at.right(margin, 238, page - 2 * margin, 20)} />`;
  const storyParameters = 'parameters: { heading, textSize },';
  const storyPhoto = `<ctx.PhotoBox id="hero" rect={ctx.geometry.page('left', 'bleed')} />`;
  const probe = (label, value) => `{ label: '${label}', parameters: { value: p.string({ label: 'Value', default: '${value}' }) } }`;
  const probed = source
    .replace(titleParameters, titleParameters.replace('heading, ', "heading, showExtra: p.boolean({ label: 'Show extra', default: false }), ") + `
      elements: { firstProbe: ${probe('First probe', 'first')}, secondProbe: ${probe('Second probe', 'second')}, hiddenProbe: ${probe('Hidden probe', 'hidden')} },`)
    .replace(titleText, titleText + `
          <ctx.Text parameter="subtitle" className="subtitle" rect={at.right(margin, 30, page - 2 * margin, 20)} />
          {ctx.params.showExtra && <div {...ctx.edit('subtitle', 'showExtra')} style={ctx.geometry.css(at.right(150, 5, 100, 10))}>extra</div>}
          <div {...ctx.edit('subtitle', 'showExtra')} style={ctx.geometry.css(at.right(150, 270, 100, 10))}>stable</div>
          <ctx.Element id="firstProbe" rect={at.right(margin, 270, 60, 10)}>{ctx.elements.firstProbe.params.value}</ctx.Element>
          <ctx.Element id="secondProbe" rect={at.right(margin, 270, 60, 10)}>{ctx.elements.secondProbe.params.value}</ctx.Element>`)
    .replace(storyParameters, "parameters: { heading, textSize, extraProbe: p.string({ label: 'Extra probe', default: 'extra' }) },")
    .replace(storyPhoto, `<ctx.PhotoBox id="hero" {...ctx.edit('extraProbe')} rect={ctx.geometry.page('left', 'bleed')} />`);
  for (const part of [titleParameters, titleText, storyParameters, storyPhoto]) assert.ok(source.includes(part), part);
  const previous = await w.locator('iframe.book-frame-book[data-current]').getAttribute('src');
  await writeFile(templateFile, probed);
  await w.waitForFunction((url) => { const f = document.querySelector('iframe.book-frame-book[data-current][data-ready]'); return f && f.getAttribute('src') !== url; }, previous, { timeout: 30000 });
  const status = await w.frameLocator('iframe.book-frame-book[data-current]').locator('body').evaluate(() => window.imageflowRenderStatus);
  assert.deepEqual(status.errors, []);

  await w.locator('[data-spread="title"].spread-thumb').click();
  const list = w.locator('.inspector').getByRole('region', { name: 'On this spread' });
  // Standalone ctx.Text nodes are listed first, in reading order, and open from the keyboard.
  const entries = await list.getByRole('button').evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label')));
  assert.deepEqual(entries, ['Edit Heading', 'Edit Subtitle', 'Edit Subtitle, Show extra', 'Edit First probe', 'Edit Second probe', 'Edit Hidden probe']);
  await list.getByRole('button', { name: 'Edit Subtitle', exact: true }).focus();
  await w.keyboard.press('Enter');
  const subtitle = w.getByRole('dialog', { name: 'Edit Subtitle' });
  await subtitle.waitFor();
  const subtitleInput = subtitle.getByRole('textbox', { name: 'Subtitle' });
  assert.equal(await subtitleInput.evaluate((el) => el === document.activeElement), true);
  await subtitleInput.fill('Typed from the list');
  await subtitleInput.press('Enter');
  await saved('Subtitle updated');
  assert.equal((await read()).spreads[0].params.subtitle, 'Typed from the list');
  await ready();

  // The subtitle is shown twice; selection follows the occurrence clicked while the controls keep their position.
  // Tab steps through both in reading order.
  const frame = w.frameLocator('iframe.book-frame-book[data-current]');
  const subtitles = frame.locator('[data-spread="title"] [data-edit="subtitle"]');
  assert.equal(await subtitles.count(), 2);
  const centre = async (locator) => {
    const rect = await locator.boundingBox();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  };
  // The outline follows the book's geometry, which a resize updates a moment later, so this waits for it to settle.
  const anchoredAt = async (node) => {
    await w.waitForFunction(() => !!document.querySelector('.edit-target.active'));
    let active, expected;
    for (let tries = 0; tries < 20; tries++) {
      [active, expected] = [await centre(w.locator('.edit-target.active')), await centre(node)];
      if (Math.abs(active.x - expected.x) < 6 && Math.abs(active.y - expected.y) < 6) return;
      await w.waitForTimeout(250);
    }
    assert.fail(`editor anchored at ${JSON.stringify(active)}, expected ${JSON.stringify(expected)}`);
  };
  await subtitles.nth(1).scrollIntoViewIfNeeded();
  await w.waitForTimeout(150);
  const repeated = await centre(subtitles.nth(1));
  await w.mouse.click(repeated.x, repeated.y);
  const repeatedEditor = w.getByRole('dialog', { name: 'Edit Subtitle' });
  await repeatedEditor.waitFor();
  await docked(repeatedEditor);
  const scrollTop = await w.locator('.canvas').evaluate((node) => { const top = node.scrollTop; node.scrollTop += 120; return top; });
  await docked(repeatedEditor);
  await w.locator('.canvas').evaluate((node, top) => { node.scrollTop = top; }, scrollTop);
  await anchoredAt(subtitles.nth(1));
  await repeatedEditor.getByRole('textbox', { name: 'Subtitle' }).press('Tab');
  await w.getByRole('dialog', { name: 'Edit Heading' }).waitFor();
  await w.getByRole('dialog', { name: 'Edit Heading' }).getByRole('textbox', { name: 'Heading' }).press('Shift+Tab');
  await w.getByRole('dialog', { name: 'Edit Subtitle' }).waitFor();
  await anchoredAt(subtitles.nth(1));
  await w.keyboard.press('Escape');
  await w.waitForFunction(() => !document.querySelector('.edit-target.active'));
  const original = await centre(subtitles.nth(0));
  await w.mouse.click(original.x, original.y);
  await w.getByRole('dialog', { name: 'Edit Subtitle' }).waitFor();
  await anchoredAt(subtitles.nth(0));
  await w.keyboard.press('Escape');

  // A node with the same fields appearing earlier on the sheet renumbers the occurrences while an editor is open.
  // The editor stays on the node it opened at and keeps the text typed but not yet applied.
  const marked = frame.locator('[data-spread="title"] [data-edit="subtitle showExtra"]');
  assert.equal(await marked.count(), 1);
  const stable = await centre(marked.first());
  await w.mouse.click(stable.x, stable.y);
  const both = w.getByRole('dialog', { name: 'Edit Subtitle, Show extra' });
  await both.waitFor();
  await anchoredAt(marked.first());
  await both.getByRole('textbox', { name: 'Subtitle' }).fill('Not applied yet');
  await both.getByRole('checkbox', { name: 'Show extra' }).click();
  await saved('Show extra updated');
  await ready();
  await marked.nth(1).waitFor();
  assert.equal(await both.getByRole('textbox', { name: 'Subtitle' }).inputValue(), 'Not applied yet');
  await anchoredAt(marked.nth(1));
  await both.getByRole('textbox', { name: 'Subtitle' }).fill('Typed from the list');
  // Resizing the window moves and scales the sheets; the editor stays on the lower node.
  const owner = await app.browserWindow(w);
  const size = await owner.evaluate((window) => window.getContentSize());
  for (const width of [size[0] - 360, size[0]]) {
    await owner.evaluate((window, [width, height]) => window.setContentSize(width, height), [width, size[1]]);
    await w.waitForTimeout(800);
    await anchoredAt(marked.nth(1));
    await docked(both);
  }
  // Clicking the node that appeared, which now holds the number the editor opened with, opens it there. The open
  // popover can cover that node, depending on the window size, and a click on the popover is not a click on the page;
  // then the sidebar, which opens the first occurrence, opens it instead.
  await marked.nth(0).scrollIntoViewIfNeeded();
  await w.waitForTimeout(150);
  const appeared = await centre(marked.nth(0));
  const covered = await w.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('.edit-popover'), appeared);
  if (covered) await list.getByRole('button', { name: 'Edit Subtitle, Show extra', exact: true }).click();
  else await w.mouse.click(appeared.x, appeared.y);
  await w.getByRole('dialog', { name: 'Edit Subtitle, Show extra' }).waitFor({ timeout: 5000 }).catch(async (error) => {
    const hit = await w.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.outerHTML.slice(0, 200), appeared);
    throw new Error(`No editor opened ${covered ? 'from the sidebar' : 'by clicking at ' + JSON.stringify(appeared) + ' on ' + hit}`, { cause: error });
  });
  await anchoredAt(marked.nth(0));
  await w.keyboard.press('Escape');
  assert.equal((await read()).spreads[0].params.subtitle, 'Typed from the list');

  // The second of two elements at the same place edits its own value, not the first one's.
  await list.getByRole('button', { name: 'Edit Second probe', exact: true }).click();
  const second = w.getByRole('dialog', { name: 'Edit Second probe' });
  await second.waitFor();
  const secondInput = second.getByRole('textbox', { name: 'Value' });
  assert.equal(await secondInput.inputValue(), 'second');
  await secondInput.fill('changed');
  await secondInput.press('Enter');
  await saved('Value updated');
  const afterSecond = (await read()).spreads[0].elements;
  assert.equal(afterSecond.secondProbe.params.value, 'changed');
  assert.equal(afterSecond.firstProbe?.params?.value, undefined);
  await ready();

  // Clicking the overlapping elements on the page opens the one drawn on top, the second, and saves only its value.
  const secondNode = frame.locator('[data-spread="title"] [data-element="secondProbe"]');
  await secondNode.scrollIntoViewIfNeeded();
  await w.waitForTimeout(150);
  const box = await secondNode.boundingBox();
  await w.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const onCanvas = w.getByRole('dialog', { name: 'Edit Second probe' });
  await onCanvas.waitFor();
  const canvasInput = onCanvas.getByRole('textbox', { name: 'Value' });
  assert.equal(await canvasInput.inputValue(), 'changed');
  await canvasInput.fill('from the canvas');
  await canvasInput.press('Enter');
  await saved('Value updated');
  const afterCanvas = (await read()).spreads[0].elements;
  assert.equal(afterCanvas.secondProbe.params.value, 'from the canvas');
  assert.equal(afterCanvas.firstProbe?.params?.value, undefined);
  await ready();

  // An element the layout does not render uses the same controls and explains that it is hidden.
  await list.getByRole('button', { name: 'Edit Hidden probe', exact: true }).click();
  const hidden = w.getByRole('dialog', { name: 'Edit Hidden probe' });
  await hidden.waitFor();
  await docked(hidden);
  assert.equal(await hidden.getByText('Not on the page in this layout right now', { exact: true }).count(), 0);
  await hidden.getByRole('textbox', { name: 'Value' }).fill('kept');
  await hidden.getByRole('textbox', { name: 'Value' }).press('Enter');
  await saved('Value updated');
  assert.equal((await read()).spreads[0].elements.hiddenProbe.params.value, 'kept');
  await ready();

  // A setting marked on a photo is edited in the selected photo's toolbar.
  await w.locator('[data-spread="arriving"].spread-thumb').click();
  await w.locator('.inspector').getByRole('button', { name: 'Edit Main photo', exact: true }).click();
  const extra = w.locator('.crop-params').getByRole('textbox', { name: 'Extra probe' });
  await extra.waitFor();
  await docked(w.locator('.crop-toolbar'));
  assert.equal(await extra.inputValue(), 'extra');
  await extra.fill('from the toolbar');
  await extra.press('Enter');
  await saved('Extra probe updated');
  assert.equal((await read()).spreads[1].params.extraProbe, 'from the toolbar');
  await ready();
  await w.locator('.crop-toolbar').waitFor();
  await w.keyboard.press('Escape');
  await w.locator('.crop-editor').waitFor({ state: 'detached' });
  await list.getByRole('button', { name: 'Edit Story', exact: true }).click();
  const textControls = w.getByRole('dialog', { name: 'Edit Story', exact: true });
  await textControls.waitFor();
  await docked(textControls);
  await w.screenshot({ path: join(root, '.build', 'item-controls-text.png'), animations: 'disabled' });
  // A short canvas keeps long control panels reachable through their own scrolling area.
  await owner.evaluate((window) => window.setContentSize(940, 650));
  await w.getByRole('separator', { name: 'Resize Sources' }).focus();
  // Focus alone preserves the editor; resizing with the keyboard leaves the canvas controls open.
  for (let i = 0; i < 13; i++) await w.keyboard.press('ArrowUp');
  await docked(textControls);
  const lastControl = textControls.locator('button,select,input,textarea').last();
  await lastControl.focus();
  const lastBounds = await lastControl.boundingBox();
  const canvasBounds = await w.locator('.canvas-wrap').boundingBox();
  assert.ok(lastBounds.y >= canvasBounds.y && lastBounds.y + lastBounds.height <= canvasBounds.y + canvasBounds.height, 'Compact controls remain reachable in a short canvas');
  await w.screenshot({ path: join(root, '.build', 'item-controls-small.png'), animations: 'disabled' });
  console.log('ImageFlow inline owners passed: item identity, editing, and shared control placement across scrolling and resizing.');
} finally {
  await app.close();
  await rm(work, { recursive: true, force: true });
}
