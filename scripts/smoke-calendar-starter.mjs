import { exportAction, menuAction, testBook } from './ui-actions.mjs';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { PDFDocument } from 'pdf-lib';
import { _electron } from 'playwright-core';

// #27: the calendar starter opens without Book check findings, numbers its months from the page position, and
// exports a print PDF of single pages in both formats, with or without its cover. `--screenshots <folder>` also
// saves the editor and the print PDFs there, for reviewing the design.
const root = fileURLToPath(new URL('../', import.meta.url));
const build = join(root, '.build');
const flag = process.argv.indexOf('--screenshots');
const screenshots = flag >= 0 ? process.argv[flag + 1] : undefined;
const work = await mkdtemp(join(build, 'calendar-starter-'));
const project = join(work, 'Calendar.imageflow');
await cp(join(root, 'sample', 'calendar'), project, { recursive: true, filter: (path) => basename(path) !== '.imageflow' });
if (screenshots) await mkdir(screenshots, { recursive: true });

const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 0.5, message + ': ' + actual + ' ≉ ' + expected);
let app;
try {
  app = await _electron.launch({ executablePath: electron, args: [join(build, 'desktop'), '--user-data-dir=' + join(work, 'profile')],
    env: { ...process.env, ...(screenshots ? {} : { IMAGEFLOW_HIDE_WINDOW: '1' }) }, timeout: 15000 });
  const w = await testBook(app, project, false);
  w.setDefaultTimeout(30000);
  await w.setViewportSize({ width: 1600, height: 1000 }).catch(() => {});
  const ready = 'iframe.book-frame-book[data-current][data-ready]';
  const frame = w.frameLocator(ready);
  const renderStatus = () => frame.locator('body').evaluate(() => window.imageflowRenderStatus);
  const months = () => frame.locator('.month-name').allTextContents();
  const saveTo = (filePath) => app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, filePath);
  const exported = async (name, file, expected) => {
    await saveTo(file);
    await exportAction(w, name);
    await w.waitForFunction((expected) => document.querySelector('.status-error') ||
      (document.querySelector('.status')?.textContent ?? '').startsWith(expected), expected, { timeout: 120000 });
    assert.match(await w.locator('.status').textContent(), new RegExp('^' + expected));
    return PDFDocument.load(await readFile(file));
  };
  // Every day of January fits in the days element, above the bottom of the safe area.
  const daysFit = async () => {
    const january = frame.locator('.month').first();
    const [area, last] = [await january.locator('.days').boundingBox(), await january.locator('.days li').last().boundingBox()];
    assert.ok(last.y + last.height <= area.y + area.height + 1, 'day 31 fits: ' + JSON.stringify({ area, last }));
  };
  // The printer's sizes are 400 dpi pixels with 31 px of bleed on each side.
  const pixels = (value) => value * 72 / 400;
  const printed = async (format, size, pages = 13) => {
    const file = join(screenshots ?? work, 'calendar-' + format + '-' + pages + '.pdf');
    const pdf = await exported('Export print PDF', file, 'Print PDF saved');
    assert.equal(pdf.getPageCount(), pages);
    for (const page of pdf.getPages()) {
      near(page.getMediaBox().width, pixels(size.width), format + ' page width');
      near(page.getMediaBox().height, pixels(size.height), format + ' page height');
      near(page.getTrimBox().x, pixels(31), format + ' bleed');
      near(page.getTrimBox().width, pixels(size.width - 62), format + ' trim width');
    }
  };

  await w.locator(ready).waitFor();
  const status = await renderStatus();
  assert.equal(status.state, 'ready');
  assert.deepEqual(status.errors, [], JSON.stringify(status.errors));
  assert.deepEqual(status.warnings ?? [], [], JSON.stringify(status.warnings));
  assert.equal(status.pages, 13);
  assert.deepEqual(await months(), ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']);
  // Days follow the month: February 2027 has 28, and 1 February 2027 is a Monday.
  const february = frame.locator('.month').nth(1).locator('.days li');
  assert.equal(await february.count(), 28);
  assert.equal(await february.first().textContent(), '1Mo');
  assert.deepEqual(await frame.locator('.month').nth(1).locator('.weekend .day').allTextContents(),
    ['6', '7', '13', '14', '20', '21', '27', '28']);
  // The place falls back to the photo's caption; the cover's year is its own text.
  assert.equal(await frame.locator('.month .place').first().textContent(), 'Segla, Senja');
  const caption = frame.locator('.month .place').first();
  await caption.locator('.if-text-inherited').waitFor();
  const captionEditor = w.getByRole('dialog', { name: 'Edit Place', exact: true });
  const openCaption = async () => {
    await caption.scrollIntoViewIfNeeded();
    const box = await caption.boundingBox();
    await w.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await captionEditor.waitFor();
  };
  await openCaption();
  assert.match(await captionEditor.innerText(), /Using photo caption or title: Segla, Senja/);
  const override = captionEditor.getByRole('textbox');
  await override.fill('Custom place');
  await captionEditor.getByRole('button', { name: 'Close', exact: true }).click();
  await frame.locator('.month .place', { hasText: 'Custom place' }).waitFor();
  await openCaption();
  assert.match(await captionEditor.innerText(), /Leave empty to use photo caption or title/);
  await override.fill('');
  await captionEditor.getByRole('button', { name: 'Close', exact: true }).click();
  await caption.locator('.if-text-inherited', { hasText: 'Segla, Senja' }).waitFor();
  const inheritedSaved = JSON.parse(await readFile(join(project, 'project.json'), 'utf8'));
  assert.notEqual(inheritedSaved.spreads.find((spread) => spread.definition === 'month').params?.place, 'Segla, Senja', 'fallback never becomes a saved override');
  assert.equal(await frame.locator('.cover .year').textContent(), '2027');
  await daysFit();
  if (screenshots) await w.screenshot({ path: join(screenshots, 'editor.png') });
  await printed('a3', { width: 6835, height: 4866 });

  // A first month later in the year renumbers the pages; the cover's year stays as written.
  await w.locator('.template-controls > summary').click();
  const first = w.getByLabel('First month', { exact: true });
  await first.fill('2026-09');
  await frame.locator('.month-name').first().filter({ hasText: 'SEP' }).waitFor();
  assert.deepEqual((await months()).slice(0, 5), ['SEP', 'OCT', 'NOV', 'DEC', 'JAN']);
  assert.equal(await frame.locator('.cover .year').textContent(), '2027');
  await w.getByRole('button', { name: 'Undo', exact: true }).click();
  await frame.locator('.month-name').first().filter({ hasText: 'JAN' }).waitFor();

  // Marked days are dates for the whole calendar. The sample marks 17 May and 24–26 and 31 December.
  assert.deepEqual(await frame.locator('.month').nth(4).locator('.marked .day').allTextContents(), ['17']);
  assert.deepEqual(await frame.locator('.month').nth(11).locator('.marked .day').allTextContents(), ['24', '25', '26', '31']);
  // A yearly date and a one-off date show in their month; entries that are not dates are reported once, not dropped.
  const file = join(project, 'project.json');
  const saved = JSON.parse(await readFile(file, 'utf8'));
  const sample = saved.params.markedDates;
  saved.params.markedDates = '0, typo, 30.02, 14.2, 2027-02-03, 2028-02-05, 29.02, 1.5';
  await writeFile(file, JSON.stringify(saved, null, 2) + '\n');
  await frame.locator('.month').nth(1).locator('.marked').first().waitFor();
  assert.deepEqual(await frame.locator('.month').nth(1).locator('.marked .day').allTextContents(), ['3', '14']);
  assert.deepEqual(await frame.locator('.month').nth(4).locator('.marked .day').allTextContents(), ['1']);
  // Template findings are reported with a `template:` prefix on their code.
  let invalid = [];
  for (let attempt = 0; attempt < 50 && !invalid.length; attempt++) {
    invalid = (await renderStatus()).warnings.filter(({ code }) => code === 'template:marked-day-invalid');
    if (!invalid.length) await w.waitForTimeout(100);
  }
  assert.equal(invalid.length, 1, JSON.stringify(invalid));
  assert.match(invalid[0].message, /^Marked days: 0, typo, 30\.02 are not dates/);
  // A calendar file adds its all-day events to the hand-marked days without changing them: a yearly birthday on
  // 9 May, and a one-off trip from 30 to 31 December. Its days have a tooltip naming the file.
  saved.params.markedDates = sample;
  await mkdir(join(project, 'files'), { recursive: true });
  const calendar = (...events) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...events.flatMap((lines) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT']), 'END:VCALENDAR'].join('\r\n');
  await writeFile(join(project, 'files', 'birthdays.ics'), calendar(['DTSTART;VALUE=DATE:19900509', 'RRULE:FREQ=YEARLY'],
    ['DTSTART;VALUE=DATE:20271230', 'DTEND;VALUE=DATE:20280101'], ['DTSTART:20270520T090000Z']));
  saved.files = { ...saved.files, birthdays: 'files/birthdays.ics' };
  saved.params.markedFile = 'birthdays';
  await writeFile(file, JSON.stringify(saved, null, 2) + '\n');
  await frame.locator('.month').nth(4).locator('.marked .day', { hasText: /^9$/ }).waitFor();
  assert.deepEqual(await frame.locator('.month').nth(4).locator('.marked .day').allTextContents(), ['9', '17']);
  assert.deepEqual(await frame.locator('.month').nth(11).locator('.marked .day').allTextContents(), ['24', '25', '26', '30', '31']);
  assert.equal(await frame.locator('.month').nth(4).locator('.days li').nth(8).getAttribute('title'), 'From the calendar file birthdays.ics');
  assert.equal(await frame.locator('.month').nth(4).locator('.days li').nth(16).getAttribute('title'), null);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).params.markedDates, sample);
  // The day picker on the page locks the file's days, and follows the file when it changes. Opening it with a click
  // on a file day marks nothing, since that day's button is disabled.
  const may = frame.locator('.month').nth(4);
  await may.locator('.days').scrollIntoViewIfNeeded();
  const ninth = await may.locator('.days li').nth(8).boundingBox();
  await w.mouse.click(ninth.x + ninth.width / 2, ninth.y + ninth.height / 2);
  await w.locator('.inline-editor.showing').waitFor();
  const picker = w.frameLocator('iframe.inline-editor-frame');
  const locked = () => picker.locator('.days-on-page li.from-file .day').allTextContents();
  await picker.locator('.days-on-page li.from-file').first().waitFor();
  assert.deepEqual(await locked(), ['9']);
  assert.equal(await picker.locator('.days-on-page li').nth(8).locator('button').isDisabled(), true);
  assert.equal(await picker.locator('.days-on-page li').nth(8).locator('button').getAttribute('title'), 'From the calendar file birthdays.ics');
  await writeFile(join(project, 'files', 'birthdays.ics'), calendar(['DTSTART;VALUE=DATE:19900510', 'RRULE:FREQ=YEARLY']));
  await writeFile(file, JSON.stringify(saved, null, 2) + '\n');
  await picker.locator('.days-on-page li.from-file .day', { hasText: /^10$/ }).waitFor();
  assert.deepEqual(await locked(), ['10']);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).params.markedDates, sample);
  await w.locator('.inline-editor-bar').getByRole('button', { name: 'Done' }).click();
  await w.locator('.inline-editor').waitFor({ state: 'detached' });
  // A file that is not a calendar is reported once, and marks nothing.
  await writeFile(join(project, 'files', 'birthdays.ics'), 'day,km\n1,4\n');
  await writeFile(file, JSON.stringify(saved, null, 2) + '\n');
  await frame.locator('.month').nth(4).locator('.days li').nth(8).and(frame.locator('li:not(.marked)')).waitFor();
  let broken = [];
  for (let attempt = 0; attempt < 50 && !broken.length; attempt++) {
    broken = (await renderStatus()).warnings.filter(({ code }) => code === 'template:marked-file-invalid');
    if (!broken.length) await w.waitForTimeout(100);
  }
  assert.equal(broken.length, 1, JSON.stringify(broken));
  assert.match(broken[0].message, /^Marked days from calendar: birthdays\.ics is not a calendar file/);
  delete saved.files.birthdays;
  delete saved.params.markedFile;

  // Moving the December page to the front makes it January, and the December marks stay in December.
  saved.spreads.splice(1, 0, ...saved.spreads.splice(saved.spreads.findIndex(({ id }) => id === 'dec'), 1));
  await writeFile(file, JSON.stringify(saved, null, 2) + '\n');
  await frame.locator('.month').first().locator('.place', { hasText: 'Outer coast, Senja' }).waitFor();
  assert.deepEqual(await frame.locator('.month').first().locator('.marked .day').allTextContents(), []);
  assert.deepEqual(await frame.locator('.month').nth(11).locator('.marked .day').allTextContents(), ['24', '25', '26', '31']);
  saved.spreads.splice(12, 0, saved.spreads.splice(1, 1)[0]);
  await writeFile(file, JSON.stringify(saved, null, 2) + '\n');
  await frame.locator('.month').first().locator('.place', { hasText: 'Segla, Senja' }).waitFor();

  // Without the cover the months stay January to December, and twelve pages still print.
  await w.locator('.spread-thumb').first().click();
  await menuAction(app, 'Delete Spread');
  await frame.locator('.cover').waitFor({ state: 'detached' });
  const coverless = await renderStatus();
  assert.equal(coverless.pages, 12);
  assert.deepEqual(coverless.errors, [], JSON.stringify(coverless.errors));
  assert.deepEqual(await months(), ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']);
  await printed('a3', { width: 6835, height: 4866 }, 12);

  // The 60 × 45 format keeps the proportions and passes the print checks too.
  const before = await w.locator('iframe.book-frame-book[data-current]').getAttribute('src');
  await w.getByRole('combobox', { name: 'Format' }).selectOption('a2');
  await w.waitForFunction((url) => { const f = document.querySelector('iframe.book-frame-book[data-current][data-ready]'); return f && f.getAttribute('src') !== url; }, before);
  assert.deepEqual((await renderStatus()).errors, []);
  await daysFit();
  await printed('a2', { width: 9417, height: 6677 }, 12);
  console.log('ImageFlow calendar starter passed.');
} finally {
  await app?.close();
  await rm(work, { recursive: true, force: true });
}
