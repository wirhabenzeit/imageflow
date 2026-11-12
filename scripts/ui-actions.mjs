import { cp, readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
const activePages = new WeakMap();

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
  return page;
}
export async function menuAction(app, name) {
  const labels = { 'New project…': 'New Book…', 'Open project…': 'Open…', Reload: 'Reload Book', 'Open Sample Project': 'Explore a Sample',
    'Undo Project Edit': 'Undo Book Edit', 'Redo Project Edit': 'Redo Book Edit' };
  const page = activePages.get(app) ?? app.windows().find((page) => page.url() === 'imageflow://editor/') ?? await app.firstWindow();
  const before = new Set(app.windows());
  await app.evaluate(({ Menu, BrowserWindow }, { label, id }) => {
    const item = Menu.getApplicationMenu().items.flatMap((item) => item.submenu?.items ?? []).find((item) => item.label === label);
    if (!item) throw new Error('Missing menu command: ' + label);
    const owner = BrowserWindow.fromId(id);
    item.click(item, owner);
  }, { label: labels[name] ?? name, id: await app.browserWindow(page).then((window) => window.evaluate((window) => window.id)) });
  if (name === 'Open Sample Project') {
    let opened;
    for (let tries = 0; tries < 250; tries++) {
      opened = app.windows().find((page) => !before.has(page) && page.url() === 'imageflow://editor/');
      if (opened) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (opened) { activePages.set(app, opened); opened.setDefaultTimeout(30000); await opened.emulateMedia({ colorScheme: null }); return opened; }
  }
  return page;
}
export async function exportAction(page, name) {
  await page.locator('.export-menu > summary').click();
  await page.getByRole('button', { name, exact: true }).click();
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
