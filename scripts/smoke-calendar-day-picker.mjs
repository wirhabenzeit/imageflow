import { testBook } from './ui-actions.mjs';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';

// #92: the calendar's day picker is a document editor for the marked dates. Clicking a month page's days opens it
// with that page's context; a click marks a date once; yearly dates show as marked and are removed explicitly. The
// open picker follows the book (a reorder moves it to another month) but stops when its own values change elsewhere,
// and closes when its page is deleted.
// `--screenshots <folder>` also saves the open picker there, for reviewing the design.
const flag = process.argv.indexOf('--screenshots');
const screenshots = flag >= 0 ? process.argv[flag + 1] : undefined;
const root = fileURLToPath(new URL('../', import.meta.url));
const build = join(root, '.build');
const work = await mkdtemp(join(build, 'calendar-day-picker-'));
const project = join(work, 'Calendar.imageflow');
if (screenshots) await mkdir(screenshots, { recursive: true });
await cp(join(root, 'sample', 'calendar'), project, { recursive: true, filter: (path) => basename(path) !== '.imageflow' });
const file = join(project, 'project.json');
const read = async () => JSON.parse(await readFile(file, 'utf8'));
const write = (state) => writeFile(file, JSON.stringify(state, null, 2) + '\n');
const sample = '17.05, 24.12, 25.12, 26.12, 31.12';

let app;
try {
  app = await _electron.launch({ executablePath: electron, args: [join(build, 'desktop'), '--user-data-dir=' + join(work, 'profile')],
    env: { ...process.env, ...(screenshots ? {} : { IMAGEFLOW_HIDE_WINDOW: '1' }) }, timeout: 15000 });
  const w = await testBook(app, project, false);
  w.setDefaultTimeout(30000);
  await w.setViewportSize({ width: 1600, height: 1000 }).catch(() => {});
  const ready = () => w.waitForSelector('iframe.book-frame-book[data-current][data-ready]');
  const frame = w.frameLocator('iframe.book-frame-book[data-current]');
  const dialog = w.getByRole('dialog', { name: 'Marked days' });
  const picker = w.frameLocator('iframe.element-editor-frame');
  const waitFor = async (check, message) => {
    for (let i = 0; i < 100; i++) {
      if (check(await read())) return;
      await w.waitForTimeout(100);
    }
    const panel = (await dialog.innerText().catch(() => '(no panel)')) + '\n' + (await picker.locator('body').innerText().catch(() => '(no picker)')) +
      '\n' + (await w.locator('.status').textContent().catch(() => ''));
    assert.fail(message + ": " + JSON.stringify((await read()).params) + "\n" + panel);
  };
  // Clicks in the picker wait for the book and the panel to be idle: the panel pauses while the book re-renders.
  const idle = async () => {
    await ready();
    await w.waitForFunction(() => !document.querySelector('.preview-state, .preview-message, .element-editor .ee-status.muted') &&
      !document.querySelector('iframe.element-editor-frame')?.inert);
    // The panel grows with the picker's content, moving its buttons; click once its height has settled.
    await w.waitForFunction(() => {
      const panel = document.querySelector('.element-editor')?.getBoundingClientRect();
      const heights = (window.__pickerHeights ??= []);
      heights.push(panel ? panel.top + ':' + panel.height : '');
      if (heights.length > 4) heights.shift();
      const stable = heights.length === 4 && heights.every((h) => h && h === heights[0]);
      if (stable) window.__pickerHeights = [];
      return stable;
    }, null, { polling: 100 });
  };
  const press = async (name) => {
    await idle();
    await picker.getByRole('button', { name, exact: true }).click();
  };
  const openPicker = async (spread) => {
    await ready();
    await w.waitForFunction(() => !document.querySelector('.preview-state, .preview-message'));
    const days = frame.locator('[data-spread="' + spread + '"] .days');
    await days.scrollIntoViewIfNeeded();
    await w.waitForTimeout(150);
    const box = await days.boundingBox();
    await w.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await dialog.waitFor();
    await w.waitForFunction(() => !document.querySelector('.element-editor .ee-status.muted'));
    await picker.locator('.marked-days-editor').waitFor();
  };
  const close = async () => {
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
  };

  await ready();
  // The marked dates have no field in Book settings; the settings say where they are edited.
  await w.getByText('Book settings', { exact: true }).click();
  await w.getByText('Marked days is edited on the page with Marked days', { exact: false }).waitFor();
  assert.equal(await w.getByLabel('Marked days', { exact: true }).count(), 0);

  // Clicking February's days opens the picker for February, from the page's position in the book.
  await openPicker('feb');
  assert.equal(await picker.locator('h3').textContent(), 'February 2027');
  // A click marks that date once, for the year shown, and the page shows it while the picker stays open.
  await press('14');
  await waitFor((state) => state.params.markedDates === sample + ', 2027-02-14', 'a click marks a one-off date');
  await frame.locator('[data-spread="feb"] .marked').first().waitFor();
  assert.deepEqual(await frame.locator('[data-spread="feb"] .marked .day').allTextContents(), ['14']);
  assert.equal(await dialog.getByRole('alert').count(), 0, 'Own saves do not invalidate the picker');
  if (screenshots) {
    await idle();
    await w.screenshot({ path: join(screenshots, 'day-picker.png') });
  }
  // Clicking it again unmarks it.
  await press('14');
  await waitFor((state) => state.params.markedDates === sample, 'a second click unmarks the date');

  // Moving the page to the front makes it January: the open picker follows, keeping its place, and is not stale.
  const saved = await read();
  const reordered = structuredClone(saved);
  reordered.spreads.splice(1, 0, ...reordered.spreads.splice(reordered.spreads.findIndex(({ id }) => id === 'feb'), 1));
  await write(reordered);
  await picker.locator('h3', { hasText: 'January 2027' }).waitFor();
  assert.equal(await dialog.getByRole('alert').count(), 0, 'A reorder refreshes the context without a conflict');
  await press('6');
  await waitFor((state) => state.params.markedDates === sample + ', 2027-01-06', 'the refreshed picker marks the new month');
  await close();
  await write({ ...saved, params: { markedDates: sample } });
  await frame.locator('[data-spread="feb"] .month-name', { hasText: 'FEB' }).waitFor();

  // A yearly date shows as marked and is not toggled by a click; the picker offers to remove the yearly entry.
  await openPicker('may');
  assert.equal(await picker.locator('h3').textContent(), 'May 2027');
  const seventeenth = picker.getByRole('button', { name: '17', exact: true });
  assert.equal(await seventeenth.getAttribute('class'), 'yearly');
  assert.equal(await seventeenth.isDisabled(), true);
  await press('Unmark every year');
  await waitFor((state) => state.params.markedDates === '24.12, 25.12, 26.12, 31.12', 'the yearly entry is removed');
  // A one-off date can become a yearly one.
  await press('9');
  await waitFor((state) => state.params.markedDates.endsWith('2027-05-09'), 'a one-off date');
  await press('Mark every year');
  await waitFor((state) => state.params.markedDates === '24.12, 25.12, 26.12, 31.12, 09.05', 'the date repeats every year');

  // A change to the marked dates from elsewhere stops the picker: it saves nothing until it is reopened.
  const external = await read();
  external.params.markedDates = '01.05';
  await write(external);
  await dialog.getByRole('alert').filter({ hasText: 'Marked days changed while this editor was open' }).waitFor();
  await waitFor((state) => state.params.markedDates === '01.05', 'the outside change is kept');
  await close();

  // Deleting the page the picker was opened from closes it.
  await openPicker('mar');
  const withoutMarch = await read();
  withoutMarch.spreads = withoutMarch.spreads.filter(({ id }) => id !== 'mar');
  await write(withoutMarch);
  await dialog.waitFor({ state: 'detached' });
  assert.equal((await read()).params.markedDates, '01.05');
  console.log('ImageFlow calendar day picker passed.');
} finally {
  await app?.close();
}
