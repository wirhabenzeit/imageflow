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
