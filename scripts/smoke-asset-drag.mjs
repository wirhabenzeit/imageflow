import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';
import { closeApp, testBook } from './ui-actions.mjs';

// A file in the bottom panel's Assets tab is dragged onto a spread's file setting in the Inspector (beta finding
// F-028); a setting that does not accept its type does not take it.
const root = fileURLToPath(new URL('../', import.meta.url));
const work = await mkdtemp(join(root, '.build/asset-drag-'));
const folder = join(work, 'Drag.imageflow');
for (const dir of ['template', 'photos', 'texts', 'files']) await mkdir(join(folder, dir), { recursive: true });
await writeFile(join(folder, 'template/index.tsx'), `import {defineTemplate,mm,p,printFormat,Spread} from 'imageflow';
export default defineTemplate({id:'drag',version:'1',contract:1,format:printFormat({label:'Book',trim:{width:mm(100),height:mm(120)},bleed:{all:mm(3),binding:mm(0)},safe:mm(8),ends:'inside-covers',pageCount:{min:2,max:100,step:2}}),
spreads:{stage:{label:'Stage',parameters:{track:p.file({label:'Stage GPX',accept:['.gpx']}),sheet:p.file({label:'Table',accept:['.csv']})},render:()=><Spread/>}}});`);
await writeFile(join(folder, 'files/Song Kul.gpx'), '<gpx><trk/></gpx>');
await writeFile(join(folder, 'project.json'), JSON.stringify({ schemaVersion: 1, title: 'Drag', template: { id: 'drag', version: '1' },
  files: { route: 'files/Song Kul.gpx' }, spreads: [{ id: 'one', definition: 'stage' }] }));
await writeFile(join(folder, 'photos.json'), '{}');

const app = await _electron.launch({ executablePath: electron, args: [join(root, '.build/desktop'), '--user-data-dir=' + join(work, 'profile')], env: { ...process.env, IMAGEFLOW_HIDE_WINDOW: '1' } });
try {
  const page = await testBook(app, folder);
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.locator('.canvas .book-frame-book[data-current][data-ready]').waitFor();
  await page.locator('.sources-bar [role="tab"]', { hasText: 'Assets' }).click();
  const row = page.locator('.source-manager-embedded .asset-row[data-source="file:route"]');
  await row.waitFor();
  const field = (label) => page.locator('.pc-file').filter({ has: page.getByRole('combobox', { name: label }) });
  await field('Stage GPX').waitFor();
  // A CSV setting does not take a GPX.
  await row.dragTo(field('Table'));
  await page.waitForTimeout(300);
  assert.equal(JSON.parse(await readFile(join(folder, 'project.json'), 'utf8')).spreads[0].params?.sheet, undefined);
  await row.dragTo(field('Stage GPX'));
  await page.waitForFunction(() => document.querySelector('.pc-file .box-photo-name')?.textContent === 'Song Kul.gpx');
  for (let i = 0; i < 50 && JSON.parse(await readFile(join(folder, 'project.json'), 'utf8')).spreads[0].params?.track !== 'route'; i++) await page.waitForTimeout(100);
  assert.equal(JSON.parse(await readFile(join(folder, 'project.json'), 'utf8')).spreads[0].params.track, 'route');
  assert.deepEqual(errors, []);
  console.log('Asset drag onto a file setting passed:', work);
} finally { await closeApp(app); }
