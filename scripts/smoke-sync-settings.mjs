// Settings → Sync (#281, #306) in the app, against the fake S3 server of the unit tests: the pane offers Off and a bucket
// (not iCloud or a folder, which need an entitled build and a flag), the bucket's fields are in a sheet, Cancel leaves the
// former choice, and the Settings window keeps its height throughout, also with an error. Test Connection reports what the
// service does, Save keeps the bucket in settings.json and the access key in the credential store (in memory here, as `IMAGEFLOW_SYNC_CREDENTIALS=memory` allows in development),
// a book syncs through the bucket from File → Sync (Start Syncing, which trusts the book once, then Sync Now), its
// originals follow the commit in the background, a wrong key saved in Settings turns its status to "Sign-in needed" and
// a corrected one clears it without a restart, setting the bucket up opens the Sync window (#307), where books that do
// not sync yet are off and nothing is uploaded, a settings file that names iCloud leaves sync off in a build started without iCloud's flag, and the
// secret never reaches settings.json, the renderer or the app's output.
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import electron from 'electron';
import { build } from 'esbuild';
import { _electron } from 'playwright-core';
import { closeApp, closeSettings, testBook, waitForPage } from './ui-actions.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const work = await realpath(await mkdtemp(join(root, '.build/sync-settings-smoke-')));
const profile = join(work, 'profile');
await build({ entryPoints: [join(root, 'tests/s3-fake.ts')], outfile: join(work, 's3-fake.mjs'), bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'warning' });
const { FakeS3 } = await import(pathToFileURL(join(work, 's3-fake.mjs')).href);
const fake = await new FakeS3().start();
fake.bucket('books');
const secret = fake.credentials.secretAccessKey;
const wrongSecret = 'wrong-secret-' + Date.now();

const output = [];
// As a release starts: without the flags of iCloud and of the folder backend.
async function launch() {
  const app = await _electron.launch({ executablePath: electron, args: [join(root, '.build/desktop'), '--user-data-dir=' + profile],
    env: { ...process.env, IMAGEFLOW_HIDE_WINDOW: '1', IMAGEFLOW_SYNC_CREDENTIALS: 'memory', IMAGEFLOW_SYNC_FOLDER: '' } });
  app.process().stdout.on('data', (bytes) => output.push(String(bytes)));
  app.process().stderr.on('data', (bytes) => output.push(String(bytes)));
  return app;
}
async function openSettings(app, pane) {
  const start = await app.firstWindow();
  await start.waitForLoadState();
  await start.evaluate((pane) => window.imageflow.showSettings(pane), pane);
  for (const deadline = Date.now() + 15000; Date.now() < deadline; await new Promise((resolve) => setTimeout(resolve, 50))) {
    const settings = app.windows().find((page) => page.url() === 'imageflow://editor/settings');
    if (settings) { settings.setDefaultTimeout(20000); return { start, settings }; }
  }
  throw new Error('Settings did not open.');
}
const savedSettings = async () => JSON.parse(await readFile(join(profile, 'settings.json'), 'utf8').catch(() => '{}'));

let app;
try {
  app = await launch();
  const opened = await openSettings(app, 'sync');
  const start = opened.start;
  let settings = opened.settings;
  const errors = [];
  settings.on('pageerror', (error) => errors.push(error.message));
  await settings.getByRole('tab', { name: 'Sync', selected: true }).waitFor();
  // Keep originals moved here from General.
  // Sync is off, and no backend is preselected (ADR 0012). Neither iCloud nor a folder is offered without its flag.
  await waitForPage(settings, async () => !!(await window.imageflow.getSettings()).value && !document.querySelector('input[name=sync-kind]')?.disabled);
  assert.deepEqual(await settings.getByRole('radio').evaluateAll((radios) => radios.map((radio) => [radio.value, radio.checked])), [['off', true], ['s3', false]]);
  assert.match((await settings.evaluate(() => window.imageflow.chooseSyncFolder())).error ?? '', /only available/);
  // Download asks where each book goes (#303): there is no folder to set for it.
  assert.match((await settings.evaluate(() => window.imageflow.updateSettings({ booksFolder: '/tmp' }))).error ?? '', /Invalid app settings/);
  // Which books sync is the Sync window's, which needs a backend; while sync is off the Start window offers to set it up.
  assert.equal(await settings.getByRole('button', { name: 'Manage Synced Books…' }).isEnabled(), false);
  await start.getByRole('button', { name: 'Set Up Sync…' }).waitFor();
  // Every state of the pane has one height, which the native window follows.
  const height = () => settings.evaluate(() => document.querySelector('.settings-window > div').getBoundingClientRect().height);
  const pane = await height();
  const sameHeight = async (what) => assert.equal(await height(), pane, what + ' keeps the height of the pane');
  // A click on S3 bucket opens the sheet; Cancel, or Escape, leaves the former choice.
  const sheet = settings.getByRole('dialog', { name: 'S3-compatible bucket' });
  for (const leave of [() => sheet.getByRole('button', { name: 'Cancel' }).click(), () => settings.keyboard.press('Escape')]) {
    await settings.locator('input[name=sync-kind][value=s3]').click();
    await sheet.waitFor();
    await sameHeight('The sheet');
    assert.equal(await settings.locator('input[name=sync-kind][value=off]').isChecked(), true);
    await leave();
    await sheet.waitFor({ state: 'detached' });
  }
  assert.equal((await savedSettings()).sync, undefined);
  const editBucket = async () => { await settings.getByRole('button', { name: 'Edit…' }).click(); await sheet.waitFor(); };
  const saveBucket = async () => { await sheet.getByRole('button', { name: 'Save' }).click(); await sheet.waitFor({ state: 'detached' }); };
  await settings.locator('input[name=sync-kind][value=s3]').click();
  // The S3 URL as R2 shows it, with the bucket: split into Endpoint and Bucket when the field is left.
  const endpoint = settings.getByRole('textbox', { name: 'Endpoint' });
  await endpoint.fill(fake.url + '/books');
  await settings.getByRole('textbox', { name: 'Region' }).click();
  await settings.getByText('Took the bucket “books” from the URL.', { exact: true }).waitFor();
  assert.equal(await endpoint.inputValue(), fake.url);
  assert.equal(await settings.getByRole('textbox', { name: 'Bucket' }).inputValue(), 'books');
  // Another bucket in the URL than in Bucket is pointed out, and Bucket is kept.
  await endpoint.fill(fake.url + '/other');
  await settings.getByRole('textbox', { name: 'Region' }).click();
  await settings.getByText('The URL names the bucket “other”, but Bucket is “books”. Enter the one to sync with.', { exact: true }).waitFor();
  assert.equal(await settings.getByRole('textbox', { name: 'Bucket' }).inputValue(), 'books');
  await settings.getByRole('textbox', { name: 'Region' }).fill(fake.region);
  await settings.getByRole('textbox', { name: 'Prefix' }).fill('ImageFlow');
  await settings.getByRole('textbox', { name: 'Access key ID' }).fill(fake.credentials.accessKeyId);
  await settings.getByLabel('Secret access key').fill(wrongSecret);
  // A key the service refuses: sign-in needed, without the key in the message.
  await settings.getByRole('button', { name: 'Test Connection' }).click();
  const refused = await sheet.getByRole('alert').textContent({ timeout: 20000 });
  assert.match(refused, /^Sign-in needed: .*Settings → Sync\.$/);
  assert.ok(!refused.includes(wrongSecret));
  await sameHeight('An error');
  await settings.getByLabel('Secret access key').fill(secret);
  await settings.getByRole('button', { name: 'Test Connection' }).click();
  await settings.getByText(/^Connected\. The service refuses to replace an object \(conditional writes\)\. It checks the SHA-256 of every upload\.$/).waitFor();
  assert.deepEqual([...fake.bucket('books').keys()], [], 'the connection test left nothing behind');
  await saveBucket();
  // Saved: the choice and the bucket's name on one row, the Sync window opened (there is no book yet), and the sheet,
  // opened again, holds nothing of the key.
  await settings.locator('.sync-place', { hasText: /^books$/ }).waitFor();
  assert.equal(await settings.locator('input[name=sync-kind][value=s3]').isChecked(), true);
  await sameHeight('A bucket');
  const syncPage = async () => {
    for (let attempt = 0; attempt < 400; attempt++) {
      const page = app.windows().find((page) => page.url() === 'imageflow://editor/sync');
      if (page) { page.setDefaultTimeout(30000); return page; }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('The Sync window did not open.');
  };
  let sync = await syncPage();
  await sync.getByText('No books on this Mac or in “books”.').waitFor();
  await start.getByRole('button', { name: 'Set Up Sync…' }).waitFor({ state: 'detached' });
  // Sync automatically (#284) is on by default, an ordinary preference: unchecking it is saved as `false`.
  await settings.getByRole('checkbox', { name: 'Keep originals on this Mac' }).waitFor();
  const automatic = settings.getByRole('checkbox', { name: 'Sync automatically' });
  assert.equal(await automatic.isChecked(), true);
  await automatic.uncheck();
  await waitForPage(settings, async () => (await window.imageflow.getSettings()).value?.syncAutomatically === false);
  await automatic.check();
  await waitForPage(settings, async () => (await window.imageflow.getSettings()).value?.syncAutomatically === undefined);
  await settings.screenshot({ path: join(root, '.build/sync-settings.png') });
  await editBucket();
  assert.equal(await settings.getByLabel('Secret access key').inputValue(), '');
  assert.equal(await settings.getByRole('textbox', { name: 'Access key ID' }).getAttribute('placeholder'), 'Stored (…' + fake.credentials.accessKeyId.slice(-4) + ')');
  // settings.json has the bucket and nothing of the key; the memory credential store writes no file.
  const saved = await savedSettings();
  assert.deepEqual(saved.sync, { kind: 's3', endpoint: fake.url, region: fake.region, bucket: 'books', prefix: 'ImageFlow/' });
  const text = await readFile(join(profile, 'settings.json'), 'utf8');
  assert.ok(!text.includes(secret) && !text.includes(fake.credentials.accessKeyId));
  assert.ok(!(await readdir(profile)).includes('sync-credentials.json'));
  // What a renderer can ask for never holds the key.
  for (const page of [settings, start]) {
    const answers = await page.evaluate(async () => JSON.stringify([await window.imageflow.getSettings(), await window.imageflow.syncBackendState()]));
    assert.ok(!answers.includes(secret) && !answers.includes(fake.credentials.accessKeyId), answers);
  }
  // Only Settings may test or save: not the Start window.
  assert.match((await start.evaluate((backend) => window.imageflow.testSyncConnection({ backend }), saved.sync)).error, /only available to Settings/);
  // A backend is set only here: the generic settings patch may not set one, from any window; it may turn sync off.
  for (const page of [settings, start]) {
    assert.match((await page.evaluate((sync) => window.imageflow.updateSettings({ sync }), { ...saved.sync, bucket: 'elsewhere' })).error, /Settings → Sync/);
  }
  assert.deepEqual((await savedSettings()).sync, saved.sync);
  // Test Connection with the stored key, after Save.
  await settings.getByRole('button', { name: 'Test Connection' }).click();
  await settings.getByText(/^Connected\./).waitFor();
  await sheet.getByRole('button', { name: 'Cancel' }).click();

  // A book syncs through the bucket from the menu: File → Sync → Start Syncing, then Sync Now after an edit. It is not
  // trusted (a copy of the sample), so Start Syncing asks once to trust it, and agreeing syncs it.
  await app.evaluate(({ dialog }) => {
    globalThis.asked = [];
    dialog.showMessageBox = async (...args) => { globalThis.asked.push(args.at(-1).message); return { response: 0, checkboxChecked: false }; };
  });
  const book = await testBook(app, join(work, 'Bucket Book.imageflow'), true);
  book.setDefaultTimeout(30000);
  await book.locator('iframe.book-frame-book[data-current][data-ready]').waitFor();
  const windowId = await app.browserWindow(book).then((window) => window.evaluate((window) => window.id));
  const menu = (id) => app.evaluate(({ Menu, BrowserWindow }, { id, windowId }) => {
    const item = Menu.getApplicationMenu().getMenuItemById(id);
    if (!item?.enabled) return false;
    item.click(undefined, BrowserWindow.fromId(windowId));
    return true;
  }, { id, windowId });
  for (let attempt = 0; !await menu('sync-start'); attempt++) {
    assert.ok(attempt < 400, 'a book offers Start Syncing once the bucket is set');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const statusIs = (state) => waitForPage(book, (state) => document.querySelector('.sync-status')?.getAttribute('data-state') === state, state);
  await statusIs('in-sync');
  assert.match(await book.locator('.sync-status').getAttribute('title'), /books/, 'the status names the bucket');
  const bookId = (await book.evaluate(() => window.imageflow.currentProject())).value.project.bookId;
  const stored = () => [...fake.bucket('books').keys()].filter((key) => key.startsWith('ImageFlow/books/' + bookId + '/'));
  assert.equal(stored().filter((key) => key.includes('/snapshots/')).length, 1, 'the first commit is in the bucket');
  assert.ok((await app.evaluate(() => globalThis.asked)).includes('Trust this book and sync it?'), 'Start Syncing asked to trust the book');
  for (let attempt = 0; !stored().some((key) => key.includes('/originals/')); attempt++) {
    assert.ok(attempt < 400, 'the book’s own originals follow the commit');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await book.evaluate(async () => {
    const { value } = await window.imageflow.currentProject();
    value.project.title = 'Edited before Sync Now';
    return window.imageflow.saveProject(value.id, { project: value.project, photoIndex: value.photoIndex });
  });
  await statusIs('ahead');
  assert.equal(await menu('sync-now'), true);
  for (let attempt = 0; stored().filter((key) => key.includes('/snapshots/')).length < 2; attempt++) {
    assert.ok(attempt < 400, 'Sync Now pushed the edit');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await statusIs('in-sync');
  // The Sync window lists it as it stands, with what it takes up (#285, #307).
  const row = sync.locator('.sync-row[data-book="' + bookId + '"]');
  await row.locator('.sync-state', { hasText: 'Up to date' }).waitFor();
  assert.equal(await row.getByRole('switch').getAttribute('aria-checked'), 'true');
  await row.locator('.sync-size', { hasText: /^[0-9.]+ (KB|MB)$/ }).waitFor();
  // Its size opens what it is, and what of it is no longer used (UI-009).
  await row.locator('.sync-size-button').click();
  const storage = sync.locator('.sync-details[data-details="' + bookId + '"]');
  await storage.getByText('Texts, files and history').waitFor();
  await storage.getByText(/All of it is in use|no longer used\. Clean Up can free/).waitFor();
  await row.locator('.sync-size-button').click();
  await storage.waitFor({ state: 'detached' });
  // A wrong key saved in Settings: the book's status says sign-in needed at once, and a corrected key clears it,
  // with no restart.
  await editBucket();
  await settings.getByRole('textbox', { name: 'Access key ID' }).fill(fake.credentials.accessKeyId);
  await settings.getByLabel('Secret access key').fill(wrongSecret);
  await saveBucket();
  await waitForPage(book, () => document.querySelector('.sync-status')?.textContent === 'Sign-in needed');
  await row.locator('.sync-state', { hasText: 'Sign-in needed' }).waitFor();
  await row.getByRole('button', { name: 'Settings…' }).waitFor();
  assert.match(await book.locator('.sync-status').getAttribute('title'), /SignatureDoesNotMatch/);
  await editBucket();
  await settings.getByRole('textbox', { name: 'Access key ID' }).fill(fake.credentials.accessKeyId);
  await settings.getByLabel('Secret access key').fill(secret);
  await saveBucket();
  await statusIs('in-sync');

  // Off stops syncing and forgets the bucket and its key, after asking.
  await settings.locator('input[name=sync-kind][value=off]').click();
  for (let attempt = 0; (await savedSettings()).sync; attempt++) {
    assert.ok(attempt < 400, 'sync is off');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok((await app.evaluate(() => globalThis.asked)).includes('Stop syncing through “books”?'));
  await waitForPage(book, () => !document.querySelector('.sync-status'));
  await sync.getByText('Sync is off on this Mac.', { exact: true }).waitFor();
  await sameHeight('Off');

  // A second book while sync is off: it was there before the next set-up, and is the user's own. Setting the bucket up
  // again uploads nothing: the Sync window shows the book that syncs there by its own record on, and the other off, also
  // after it is opened again.
  const second = await testBook(app, join(work, 'Second Book.imageflow'), true);
  await second.locator('iframe.book-frame-book[data-current][data-ready]').waitFor();
  await second.close();
  const all = () => [...fake.bucket('books').keys()].filter((key) => key.includes('/snapshots/')).length;
  const before = all();
  await settings.locator('input[name=sync-kind][value=s3]').click();
  await settings.getByRole('textbox', { name: 'Endpoint' }).fill(fake.url);
  await settings.getByRole('textbox', { name: 'Bucket' }).fill('books');
  await settings.getByRole('textbox', { name: 'Region' }).fill(fake.region);
  await settings.getByRole('textbox', { name: 'Prefix' }).fill('ImageFlow');
  await settings.getByRole('textbox', { name: 'Access key ID' }).fill(fake.credentials.accessKeyId);
  await settings.getByLabel('Secret access key').fill(secret);
  await saveBucket();
  sync = await syncPage();
  const secondRow = sync.getByRole('row', { name: 'Second Book' });
  await secondRow.locator('.sync-state', { hasText: 'Not syncing' }).waitFor();
  assert.equal(await secondRow.getByRole('switch').getAttribute('aria-checked'), 'false');
  await sync.locator('.sync-row[data-book="' + bookId + '"] .sync-state', { hasText: 'Up to date' }).waitFor();
  const again = await testBook(app, join(work, 'Second Book.imageflow'), false);
  await again.locator('iframe.book-frame-book[data-current][data-ready]').waitFor();
  await again.evaluate(() => window.imageflow.currentProject());
  for (let attempt = 0; !await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('sync-start')?.enabled); attempt++) {
    assert.ok(attempt < 400, 'the book that was not turned on offers Start Syncing');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(all(), before, 'nothing was pushed');
  // Turned on in the window while it is open.
  await secondRow.getByRole('switch').click();
  await secondRow.locator('.sync-state', { hasText: 'Up to date' }).waitFor();
  assert.equal(all(), before + 1);
  await settings.locator('input[name=sync-kind][value=off]').click();
  await waitForPage(book, () => !document.querySelector('.sync-status'));
  assert.deepEqual(errors, []);
  await closeSettings(app);
  await closeApp(app);

  // A settings file that names iCloud, in a build without the iCloud entitlements: sync is off and the pane says so;
  // nothing syncs, nothing fails, iCloud is not offered, and a window still cannot set a backend.
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...await savedSettings(), sync: { kind: 'icloud' } }));
  app = await launch();
  const plain = await openSettings(app, 'sync');
  await plain.settings.getByRole('tab', { name: 'Sync', selected: true }).waitFor();
  await plain.settings.getByText('iCloud sync is not available in this build of ImageFlow, so sync is off on this Mac.', { exact: true }).waitFor();
  assert.equal(await plain.settings.evaluate(() => document.querySelector('.settings-window > div').getBoundingClientRect().height), pane);
  assert.equal((await plain.settings.evaluate(() => window.imageflow.syncBackendState())).value?.icloud, undefined);
  assert.match((await plain.settings.evaluate(() => window.imageflow.saveSyncBackend({ backend: { kind: 'icloud' } }))).error, /not available/);
  assert.match((await plain.settings.evaluate(() => window.imageflow.updateSettings({ sync: { kind: 'icloud' } }))).error, /Settings → Sync/);
  assert.match((await plain.settings.evaluate(() => window.imageflow.updateSettings({ syncBooksUnchosen: true }))).error, /Settings → Sync/);
  assert.equal(await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('sync-setup')?.enabled), true, 'File → Sync offers Set Up Sync…');
  assert.equal((await plain.start.evaluate(() => window.imageflow.libraryRemote())).value, null, 'the library lists no remote');
  await closeApp(app);
  app = undefined;
  assert.ok(!output.join('').includes(secret) && !output.join('').includes(wrongSecret), 'the key is never in the app’s output');
  console.log('Sync settings smoke passed.');
} finally {
  if (app) await closeApp(app);
  await fake.close();
  await rm(work, { recursive: true, force: true });
}
