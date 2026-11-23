// Settings → Sync (#281) in the app, against the fake S3 server of the unit tests: the pane ships without a flag since
// #283 and offers a bucket (not iCloud or a folder, which need flags of their own), Test Connection reports what the service does, Save keeps the bucket in settings.json and the
// access key in the credential store (in memory here, as `IMAGEFLOW_SYNC_CREDENTIALS=memory` allows in development),
// a book syncs through the bucket from File → Sync (Start Syncing, which trusts the book once, then Sync Now), its
// originals follow the commit in the background, a wrong key saved in Settings turns its status to "Sign-in needed" and
// a corrected one clears it without a restart, setting the bucket up again lists the recent books and syncs only those
// chosen (#282), a settings file that names iCloud leaves sync off in a build started without iCloud's flag, and the
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
  await settings.getByRole('checkbox', { name: 'Keep originals of synced books on this Mac' }).waitFor();
  // Sync automatically (#284) is on by default, an ordinary preference: unchecking it is saved as `false`.
  const automatic = settings.getByRole('checkbox', { name: 'Sync automatically' });
  assert.equal(await automatic.isChecked(), true);
  await automatic.uncheck();
  await waitForPage(settings, async () => (await window.imageflow.getSettings()).value?.syncAutomatically === false);
  await automatic.check();
  await waitForPage(settings, async () => (await window.imageflow.getSettings()).value?.syncAutomatically === undefined);
  // Sync is off, and no backend is preselected (ADR 0012): the bucket is chosen first. Neither iCloud nor a folder is
  // offered without its flag.
  await settings.getByText('Sync is off: books do not sync on this Mac.', { exact: true }).waitFor();
  assert.deepEqual(await settings.getByRole('radio').evaluateAll((radios) => radios.map((radio) => [radio.value, radio.checked])), [['s3', false]]);
  assert.match((await settings.evaluate(() => window.imageflow.chooseSyncFolder())).error ?? '', /only available/);
  // The folder for downloaded books is shown, and only the app's own dialog sets it.
  await settings.getByText('Books you download from the Start window are saved in Documents → ImageFlow.', { exact: true }).waitFor();
  assert.match((await settings.evaluate(() => window.imageflow.updateSettings({ booksFolder: '/tmp' }))).error ?? '', /Settings → Sync/);
  await settings.getByRole('radio', { name: 'S3-compatible bucket' }).check();
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
  const refused = await settings.getByRole('alert').textContent({ timeout: 20000 });
  assert.match(refused, /^Sign-in needed: .*Settings → Sync\.$/);
  assert.ok(!refused.includes(wrongSecret));
  await settings.getByLabel('Secret access key').fill(secret);
  await settings.getByRole('button', { name: 'Test Connection' }).click();
  await settings.getByText(/^Connected\. The service refuses to replace an object \(conditional writes\)\. It checks the SHA-256 of every upload\.$/).waitFor();
  assert.deepEqual([...fake.bucket('books').keys()], [], 'the connection test left nothing behind');
  await settings.getByRole('button', { name: 'Save' }).click();
  await settings.getByText('Saved.', { exact: true }).waitFor();
  assert.equal(await settings.getByLabel('Secret access key').inputValue(), '', 'the field is cleared once stored');
  await settings.screenshot({ path: join(root, '.build/sync-settings.png') });
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
  await settings.getByText('Books sync through the bucket “books”.', { exact: true }).waitFor();

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
  // Storage (#285), counted only when asked: the book with what its originals take, and Clean Up, which finds nothing
  // a week old that no book uses, so it deletes nothing and asks nothing.
  await settings.getByRole('button', { name: 'Show Storage' }).click();
  await settings.getByText(/^ImageFlow uses .+ for 1 book, .+ of it originals\.$/).waitFor();
  await settings.getByRole('list', { name: 'Storage by book' }).getByText('Edited before Sync Now', { exact: true }).waitFor();
  await settings.getByRole('button', { name: 'Clean Up…' }).click();
  await settings.getByText('There is nothing to clean up.', { exact: true }).waitFor();
  assert.equal(await settings.getByRole('button', { name: 'Clean Up', exact: true }).count(), 0, 'nothing to confirm');
  for (const request of ['syncUsage', 'syncCleanUpPlan', 'syncCleanUp']) {
    assert.match((await start.evaluate((name) => window.imageflow[name](), request)).error, /only available to Settings/);
  }
  // A wrong key saved in Settings: the book's status says sign-in needed at once, and a corrected key clears it,
  // with no restart.
  await settings.getByRole('textbox', { name: 'Access key ID' }).fill(fake.credentials.accessKeyId);
  await settings.getByLabel('Secret access key').fill(wrongSecret);
  await settings.getByRole('button', { name: 'Save' }).click();
  await settings.getByText('Saved.', { exact: true }).waitFor();
  await waitForPage(book, () => document.querySelector('.sync-status')?.textContent === 'Sign-in needed');
  assert.match(await book.locator('.sync-status').getAttribute('title'), /SignatureDoesNotMatch/);
  await settings.getByRole('textbox', { name: 'Access key ID' }).fill(fake.credentials.accessKeyId);
  await settings.getByLabel('Secret access key').fill(secret);
  await settings.getByRole('button', { name: 'Save' }).click();
  await settings.getByText('Saved.', { exact: true }).waitFor();
  await statusIs('in-sync');

  // Turn Off forgets the bucket and its key.
  await settings.getByRole('button', { name: 'Turn Off' }).click();
  await settings.getByText('Sync is off on this Mac.', { exact: true }).waitFor();
  assert.equal((await savedSettings()).sync, undefined);
  await waitForPage(book, () => !document.querySelector('.sync-status'));

  // Set up again where sync was off: the first configuration uploads nothing by itself, lists the recent books with
  // what their originals take up, and a book left out stays out on this Mac.
  await settings.getByRole('radio', { name: 'S3-compatible bucket' }).check();
  await settings.getByRole('textbox', { name: 'Endpoint' }).fill(fake.url);
  await settings.getByRole('textbox', { name: 'Bucket' }).fill('books');
  await settings.getByRole('textbox', { name: 'Region' }).fill(fake.region);
  await settings.getByRole('textbox', { name: 'Prefix' }).fill('ImageFlow');
  await settings.getByRole('textbox', { name: 'Access key ID' }).fill(fake.credentials.accessKeyId);
  await settings.getByLabel('Secret access key').fill(secret);
  const commits = () => stored().filter((key) => key.includes('/snapshots/')).length;
  const before = commits();
  await settings.getByRole('button', { name: 'Save' }).click();
  let sheet = settings.getByRole('group', { name: 'Books to sync' });
  await sheet.waitFor();
  // Closing Settings leaves the sheet unanswered: it is the main process's record, so Settings → Sync shows it again.
  await closeSettings(app);
  for (let attempt = 0; app.windows().some((page) => page.url() === 'imageflow://editor/settings'); attempt++) {
    assert.ok(attempt < 400, 'Settings closes');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal((await savedSettings()).syncBooksUnchosen, true, 'kept in settings.json, so a restart asks again');
  settings = (await openSettings(app, 'sync')).settings;
  settings.on('pageerror', (error) => errors.push(error.message));
  sheet = settings.getByRole('group', { name: 'Books to sync' });
  await sheet.waitFor();
  const choice = sheet.getByRole('checkbox', { name: /Edited before Sync Now/ });
  assert.equal(await choice.isChecked(), true, 'a book that syncs with the bucket is chosen');
  assert.match(await sheet.textContent(), /[0-9.]+ (KB|MB|GB) of originals/);
  await choice.uncheck();
  await sheet.getByRole('button', { name: 'Sync Chosen Books' }).click();
  await settings.getByText('No book syncs until you choose File → Sync → Start Syncing in it.', { exact: true }).waitFor();
  await waitForPage(book, () => !document.querySelector('.sync-status'));
  for (let attempt = 0; !await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('sync-start')?.enabled); attempt++) {
    assert.ok(attempt < 400, 'the book left out offers Start Syncing');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(commits(), before, 'nothing was pushed');
  assert.equal((await savedSettings()).syncBooksUnchosen, undefined, 'answered');
  await settings.getByRole('button', { name: 'Turn Off' }).click();
  await settings.getByText('Sync is off on this Mac.', { exact: true }).waitFor();
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
