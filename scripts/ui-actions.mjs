import { cp, readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
const activePages = new WeakMap();
const pageApps = new WeakMap();

// Retry only machine-readable transient responses, never user-facing message text.
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

// A native window can disappear before Electron acknowledges the click that closes it.
export async function clickClosingWindow(page, button) {
  const closed = page.waitForEvent('close');
  void closed.catch(() => {});
  await button.click().catch((error) => {
    if (!page.isClosed() || !error.message.includes('Target page, context or browser has been closed')) throw error;
  });
  await closed;
}

// Fixtures use real document opening; package creation and picker behavior have their own workflow test.
export async function testBook(app, path, create = false) {
  if (create) await cp(fileURLToPath(new URL('../sample/starter', import.meta.url)), path, { recursive: true, filter: (path) => !path.includes('/.imageflow') });
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
  const labels = { 'New project…': 'New Book…', 'Open project…': 'Open…', 'Export Print PDF…': 'Export for Print…', 'Export Proof PDF…': 'Export PDF…', Reload: 'Reload from Disk', 'Reload Book': 'Reload from Disk',
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
export async function exportAction(page, name, app = pageApps.get(page)) {
  if (!app) throw new Error('Register this book with testBook, or pass its Electron app to exportAction.');
  const labels = { 'Export proof PDF': 'Export PDF…', 'Export print PDF': 'Export for Print…' };
  await page.evaluate(() => {
    window.__exportStarted = false;
    const status = document.querySelector('.status');
    const previous = status?.textContent;
    const observer = new MutationObserver(() => {
      if (document.querySelector('.export-progress') || status?.textContent !== previous) {
        window.__exportStarted = true; observer.disconnect();
      }
    });
    observer.observe(document.querySelector('.studio'), { subtree: true, childList: true, characterData: true });
    setTimeout(() => observer.disconnect(), 10000);
  });
  await popupAction(app, page, page.locator('.export-menu .action-menu-trigger'), labels[name] ?? name);
  await page.waitForFunction(() => window.__exportStarted);

}
// Opens Settings on its Agents pane through the native menu and returns that window's page.
export async function agentSettings(app) {
  const url = 'imageflow://editor/settings';
  const existing = app.windows().find((page) => page.url() === url);
  const created = existing ? undefined : app.waitForEvent('window');
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
    return !!frame && new URL(frame.src).pathname.endsWith('/' + id);
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
