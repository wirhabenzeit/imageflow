import { cp, readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copySample } from '../desktop/sample-book.mjs';
const activePages = new WeakMap();
const pageApps = new WeakMap();

// Retry only machine-readable transient responses, never user-facing message text.
/**
 * Closes a test app in cleanup. A failed test can leave the app unable to quit (a busy book cancels Quit), and
 * Playwright's close then waits forever, so the failure would surface only as a CI timeout. After `ms` the process is
 * killed instead, so the original error is reported.
 */
export async function closeApp(app, ms = 15000) {
  const process = app.process();
  let timer;
  const closed = await Promise.race([
    app.close().then(() => true, () => true),
    new Promise((resolve) => { timer = setTimeout(() => resolve(false), ms); }),
  ]);
  clearTimeout(timer);
  if (!closed && process.exitCode === null) {
    console.error('The app did not close within ' + ms / 1000 + ' s; killing it.');
    process.kill('SIGKILL');
  }
}

export async function retryBookRefresh(operation, ready, { attempts = 5, delay = 100 } = {}) {
  let result;
  for (let attempt = 0; attempt < attempts; attempt++) {
    result = await operation();
    const stale = result.value?.diagnostics?.some((finding) => finding.code === 'source-changed');
    if (result.code !== 'BOOK_BUSY' && !stale) break;
    if (attempt + 1 < attempts) {
      await ready();
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  return result;
}

// Asks the editor's book to reload from disk and returns once it did. The main process refuses a reload while it
// is finishing another operation on the book (a watcher refresh, a linked-source rescan, a save), and the editor
// reports that as an ordinary error result, so a bare `openProject('reload')` silently leaves a slow runner on the
// previous revision. Retry until the reload ran, and fail loudly if it never does.
export async function reloadBook(page, { timeout = 30000 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const result = await page.evaluate(() => window.imageflow.openProject('reload'));
    if (result.value) return result.value;
    const busy = result.code === 'BOOK_BUSY' || /finishing another operation/.test(result.error ?? '');
    if (!busy || Date.now() > deadline) throw new Error('The book did not reload: ' + JSON.stringify(result));
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// A native window can disappear before Electron acknowledges the click that closes it.
export async function clickClosingWindow(page, button) {
  const closed = page.waitForEvent('close');
  void closed.catch(() => {});
  await button.click().catch((error) => {
    if (!page.isClosed() || !error.message.includes('Target page, context or browser has been closed')) throw error;
  });
  await closed;
}

// Background renders (thumbnails, cover previews, the Book check) open hidden windows too. Wait for the window that
// loads `url`, even if one of those races it; on a slow runner they open while the wanted window is still coming.
export function nextWindow(app, url, timeout = 10000) {
  return app.waitForEvent('window', {
    timeout,
    predicate: async (page) => {
      try { await page.waitForURL(url, { timeout }); return true; }
      catch { return false; }
    },
  });
}
export const nextPresentation = (app) => nextWindow(app, 'imageflow://editor/presentation');
export const nextSettings = (app) => nextWindow(app, 'imageflow://editor/settings', 20000);

// Playwright adds the iframe's screen offset to descendant bounding boxes but omits its ancestor's transform.
export async function canvasArtworkBounds(page, selector) {
  const iframe = page.locator('.canvas .book-frame-book:not(.book-frame-pending)');
  const rect = await iframe.contentFrame().locator(selector).evaluate(node => {
    const { x, y, width, height } = node.getBoundingClientRect();
    return { x, y, width, height };
  });
  const parent = await iframe.evaluate(node => {
    const { x, y, width, height } = node.getBoundingClientRect();
    return { x, y, scaleX: width / node.clientWidth, scaleY: height / node.clientHeight };
  });
  return { x: parent.x + rect.x * parent.scaleX, y: parent.y + rect.y * parent.scaleY,
    width: rect.width * parent.scaleX, height: rect.height * parent.scaleY };
}

// Generic spread-editor regressions use this fixed book rather than depending on the evolving page starter.
// Its authored template stays byte-identical to the compatibility fixture; only the temporary book title changes.
export async function copySpreadStarter(path) {
  await copySample(fileURLToPath(new URL('../tests/compat/books/starter', import.meta.url)), path, {
    shared: fileURLToPath(new URL('../sample/shared', import.meta.url)),
  });
  const file = path + '/project.json';
  const project = JSON.parse(await readFile(file, 'utf8'));
  project.title = basename(path, '.imageflow');
  await writeFile(file, JSON.stringify(project, null, 2) + '\n');
}

// Fixtures use real document opening; package creation and picker behavior have their own workflow test.
export async function testBook(app, path, create = false) {
  if (create) await copySample(fileURLToPath(new URL('../sample/starter', import.meta.url)), path);
  if (create) {
    const file = path + '/project.json';
    const project = JSON.parse(await readFile(file, 'utf8'));
    project.title = basename(path, '.imageflow');
    await writeFile(file, JSON.stringify(project, null, 2) + '\n');
  }
  const remembered = activePages.get(app);
  const owner = remembered && !remembered.isClosed() ? remembered : app.windows().find((page) => page.url() === 'imageflow://editor/start') ?? await app.firstWindow();
  await owner.waitForFunction(() => !!window.imageflow);
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, path);
  const before = new Set(app.windows());
  const result = await owner.evaluate(() => window.imageflow.openProject('open'));
  if (result.error) throw new Error(result.error);
  const page = app.windows().find((page) => !before.has(page) && page.url() === 'imageflow://editor/') ?? owner;
  page.setDefaultTimeout(30000);
  await page.emulateMedia({ colorScheme: null });
  activePages.set(app, page);
  pageApps.set(page, app);
  return page;
}
export async function menuAction(app, name) {
  const labels = { 'New project…': 'New Book…', 'Open project…': 'Open…', Reload: 'Reload from Disk', 'Reload Book': 'Reload from Disk',
    'Agent Connections…': 'Connect an Agent…', 'Move Spread Down': 'Move Down', 'Move Spread Up': 'Move Up', 'Add Spread': 'New Spread',
    'Show Book Check': 'Check Book', 'Save a Copy…': 'Duplicate…' };
  const ids = { 'Delete Spread': 'delete-spread', 'Undo Book Edit': 'undo', 'Redo Book Edit': 'redo', 'Undo Project Edit': 'undo', 'Redo Project Edit': 'redo' };
  const page = activePages.get(app) ?? app.windows().find((page) => page.url() === 'imageflow://editor/') ?? await app.firstWindow();
  const request = { label: labels[name] ?? name, commandId: ids[name], id: await app.browserWindow(page).then((window) => window.evaluate((window) => window.id)) };
  for (let attempt = 0; attempt < 300; attempt++) {
    const clicked = await app.evaluate(({ Menu, BrowserWindow }, { label, commandId, id }) => {
      const walk = (menu) => menu.items.flatMap((item) => [item, ...item.submenu ? walk(item.submenu) : []]);
      const item = commandId ? Menu.getApplicationMenu().getMenuItemById(commandId) : walk(Menu.getApplicationMenu()).find((item) => item.label === label);
      if (!item) throw new Error('Missing menu command: ' + label);
      if (!item.enabled) return false;
      item.click(item, BrowserWindow.fromId(id));
      return true;
    }, request);
    if (clicked) return page;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error('Menu command stayed disabled: ' + name);
}
// Exercise the renderer's real IPC and native Menu implementation, selecting the requested native item.
export async function popupAction(app, page, trigger, label) {
  await app.evaluate(({ Menu }, label) => {
    globalThis.popupItems = [];
    Menu.prototype.popup = function ({ callback }) {
      globalThis.popupItems = this.items.map(({ label, enabled, type }) => ({ label, enabled, type }));
      const item = this.items.find((item) => item.label === label);
      if (label && (!item || !item.enabled)) throw new Error('Unavailable popup action: ' + label);
      if (item) item.click(item);
      callback?.();
    };
  }, label);
  await trigger.click();
  return app.evaluate(() => new Promise((resolve, reject) => {
    const until = Date.now() + 5000;
    const poll = () => globalThis.popupItems.length ? resolve(globalThis.popupItems) : Date.now() > until ? reject(new Error('Native menu did not open')) : setTimeout(poll, 20);
    poll();
  }));
}
export async function exportAction(page) {
  await page.evaluate(() => {
    window.__exportStarted = false;
    const status = document.querySelector('.status');
    const previous = status?.textContent;
    const observer = new MutationObserver(() => {
      if (document.querySelector('.export-button[data-exporting]') || status?.textContent !== previous) {
        window.__exportStarted = true; observer.disconnect();
      }
    });
    observer.observe(document.querySelector('.studio'), { subtree: true, childList: true, characterData: true });
    setTimeout(() => observer.disconnect(), 10000);
  });
  await page.getByRole('button', { name: /^Export (?:Content )?PDF…$/ }).click();
  await page.waitForFunction(() => window.__exportStarted);

}
// Opens Settings on its Agents pane through the native menu and returns that window's page.
export async function agentSettings(app) {
  const url = 'imageflow://editor/settings';
  const existing = app.windows().find((page) => page.url() === url);
  const created = existing ? undefined : nextSettings(app);
  await menuAction(app, 'Agent Connections…');
  const page = existing ?? await created;
  page.setDefaultTimeout(20000);
  // Follow the app's native appearance, as the editor page does, instead of Playwright's default light scheme.
  await page.emulateMedia({ colorScheme: null });
  await page.getByRole('tab', { name: 'Agents', selected: true }).waitFor();
  await page.getByRole('checkbox', { name: 'Allow agents to use open books', exact: true }).and(page.locator(':enabled')).waitFor();
  return page;
}
export async function closeSettings(app) {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((owner) => owner.webContents.getURL().startsWith('imageflow://editor/settings'))?.close());
}

export async function undoBook(page, direction = 'undo', ready = true) {
  const before = (await page.evaluate(() => window.imageflow.currentProject())).value.id;
  await page.getByRole('button', { name: direction === 'undo' ? 'Undo' : 'Redo', exact: true }).click();
  let next;
  for (let attempt = 0; attempt < 300; attempt++) {
    next = (await page.evaluate(() => window.imageflow.currentProject())).value.id;
    if (next !== before) break;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  if (next === before) throw new Error('Book Undo did not complete');
  if (ready) await waitForProject(page, (current) => page.evaluate((id) => {
    const frame = document.querySelector('iframe.book-frame-book[data-current][data-ready]');
    return !!frame && frame.dataset.revision === id;
  }, current.id));
}

// Playwright's polling callback is synchronous: an async callback is truthy before its value resolves.
export async function waitForProject(page, check) {
  for (let attempt = 0; attempt < 400; attempt++) {
    const result = await page.evaluate(() => window.imageflow.currentProject());
    if (result.value && await check(result.value)) return result.value;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error('Book did not reach the expected state');
}

export async function waitForPage(page, predicate, argument, { timeout = 30000 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await page.evaluate(predicate, argument)) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error('Window did not reach the expected state');
}

// Clicks a point on the book canvas. A different page is selected first, including either half of a full-spread
// image; the next click reaches its box or element.
export async function clickPage(page, x, y) {
  const other = await page.evaluate(([x, y]) => {
    const hit = document.elementFromPoint(x, y);
    if (!hit?.closest('.canvas .stage') || hit.closest('.inline-editor, .inline-text-editor, .edit-popover, .crop-toolbar, .element-editor')) return false;
    const sheet = document.querySelector('.canvas .sheet-selection');
    const active = sheet?.dataset.layoutMode === 'spread' ? document.querySelector('.canvas .active-spread-page') : sheet;
    const selected = active?.getBoundingClientRect();
    return !selected || x < selected.left || x > selected.right || y < selected.top || y > selected.bottom;
  }, [x, y]);
  if (other) {
    await page.mouse.click(x, y);
    await page.waitForFunction(([x, y]) => {
      const sheet = document.querySelector('.canvas .sheet-selection');
      const active = sheet?.dataset.layoutMode === 'spread' ? document.querySelector('.canvas .active-spread-page') : sheet;
      const selected = active?.getBoundingClientRect();
      return selected && x >= selected.left && x <= selected.right && y >= selected.top && y <= selected.bottom;
    }, [x, y]);
  }
  await page.mouse.click(x, y);
}

// Clicks a choice in a layout picker and waits for the book view to show the result. Selecting a page shows the
// Inspector another picker, in a new frame, and Chromium sends a click made within a few hundred milliseconds of that
// to the app's page instead (an out-of-process frame's hit testing lags its layout). A click the picker never received
// is made again, up to three times; one it received is never repeated.
export async function pickLayout(page, choice) {
  const ready = 'iframe.book-frame-book[data-current][data-ready]';
  const before = await page.locator(ready).getAttribute('data-revision');
  for (let attempt = 0; attempt < 3; attempt++) {
    await choice.click();
    const changed = await page.waitForFunction(({ ready, before }) => {
      const frame = document.querySelector(ready);
      return frame && frame.getAttribute('data-revision') !== before;
    }, { ready, before }, { timeout: 2000 }).then(() => true, () => false);
    if (changed) return;
  }
  throw new Error('The layout picker did not apply the choice.');
}

/**
 * What each book view and thumbnail frame shows, read inside the frames (the editor cannot read them, they are on
 * another origin): for a test that times out waiting for the book, so its log says why.
 */
export async function describeBookFrames(page) {
  const frames = [];
  for (const element of await page.locator('iframe.book-frame').elementHandles()) {
    const attributes = await element.evaluate((frame) => {
      const { width, height } = frame.getBoundingClientRect();
      return { className: frame.className, current: frame.hasAttribute('data-current'), ready: frame.hasAttribute('data-ready'),
        revision: frame.dataset.revision, src: frame.getAttribute('src'), box: Math.round(width) + '×' + Math.round(height),
        display: getComputedStyle(frame).display, visibility: getComputedStyle(frame).visibility };
    });
    const frame = await element.contentFrame();
    const inside = frame ? await frame.evaluate(() => ({
      readyState: document.readyState,
      status: window.imageflowRenderStatus && { state: window.imageflowRenderStatus.state, message: window.imageflowRenderStatus.message },
      spreads: document.querySelectorAll('.if-spread-container').length,
      pictures: [...document.querySelectorAll('.if-rendered-image')].map((node) => node.dataset.rendered).join(' '),
      images: [...document.querySelectorAll('img')].filter((image) => image.getAttribute('src') && !image.complete).length + ' loading',
    })).catch((error) => ({ unavailable: String(error).slice(0, 200) })) : { unavailable: 'no frame' };
    frames.push({ ...attributes, ...inside });
  }
  const host = await page.evaluate(() => ({ status: document.querySelector('.status')?.textContent, window: innerWidth + '×' + innerHeight,
    visibility: document.visibilityState }))
    .catch((error) => ({ unavailable: String(error) }));
  return { ...host, frames };
}

/**
 * Waits until the book view shows the book as it is now: its ready frame on show renders the current revision. With
 * `since`, a revision ID, first waits for the book to move past it, for an edit that may still be saving. A frame
 * marked ready may be the previous revision's, still on show while the next renders; waiting for a ready frame alone
 * then measured the old one, or none while they swapped (beta CI flakiness).
 */
export async function bookShows(page, { since, timeout = 30000 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const shown = await page.evaluate(async (since) => {
      const { value } = await window.imageflow.currentProject();
      if (!value || value.id === since) return false;
      const frame = document.querySelector('.canvas iframe.book-frame-book[data-ready]:not(.book-frame-pending)');
      return frame?.dataset.revision === value.id;
    }, since);
    if (shown) return;
    if (Date.now() > deadline) throw new Error('The book view did not show the current book: ' + JSON.stringify(await describeBookFrames(page)));
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}
