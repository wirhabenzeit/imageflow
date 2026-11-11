// Exercise the native menu for project actions removed from the toolbar.
export async function menuAction(app, name) {
  await (await app.firstWindow()).locator('.toolbar').waitFor();
  const labels = { 'New project…': 'New Project…', 'Open project…': 'Open Project Folder…', Reload: 'Reload Project' };
  await app.evaluate(({ Menu }, label) => {
    const item = Menu.getApplicationMenu().items.flatMap((item) => item.submenu?.items ?? []).find((item) => item.label === label);
    if (!item) throw new Error('Missing menu command: ' + label);
    item.click();
  }, labels[name] ?? name);
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
  await page.getByRole('checkbox', { name: 'Allow agents to use the open book', exact: true }).and(page.locator(':enabled')).waitFor();
  return page;
}
export async function closeSettings(app) {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((owner) => owner.webContents.getURL().startsWith('imageflow://editor/settings'))?.close());
}
