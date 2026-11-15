import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { PDFDocument } from 'pdf-lib';
import { _electron } from 'playwright-core';
import { closeApp, testBook } from './ui-actions.mjs';

// Check the completed PDF as well as layout findings, with one confirmation before any destination is changed.
const root = fileURLToPath(new URL('../', import.meta.url));
const work = await mkdtemp(join(root, '.build/export-'));
const app = await _electron.launch({ executablePath: electron, args: [join(root, '.build/desktop'), '--user-data-dir=' + join(work, 'profile')],
  env: { ...process.env, IMAGEFLOW_HIDE_WINDOW: '1' } });
try {
  for (const kind of ['clean', 'layout', 'resources', 'size', 'fatal']) {
    const folder = join(work, kind + '.imageflow');
    const output = join(work, kind + '.pdf');
    await mkdir(join(folder, 'template'), { recursive: true });
    await writeFile(join(folder, 'template/index.tsx'), `import {defineTemplate,mm,printFormat,Spread} from 'imageflow';
export default defineTemplate({id:'export-${kind}',version:'1',contract:1,
format:printFormat({label:'Export',trim:{width:mm(100),height:mm(100)},bleed:{all:mm(3),binding:mm(0)},safe:mm(5),ends:'inside-covers',
pageCount:{min:${kind === 'layout' ? 4 : 2},max:20,step:2},output:{transparency:'forbid',maximumFileSize:{pages:${kind === 'size' ? 1 : 1000000}}}}),
spreads:{page:{label:'Page',render:()=>{${kind === 'fatal' ? "throw new Error('Export render failed');" : ''}return <Spread><div style={{position:'absolute',left:'20mm',top:'20mm',width:'20mm',height:'20mm',background:'#284d43',opacity:${kind === 'resources' ? '.5' : '1'}}}/></Spread>;}}}});`);
    await writeFile(join(folder, 'project.json'), JSON.stringify({ schemaVersion: 1, title: kind, template: { id: 'export-' + kind, version: '1' }, spreads: [{ id: 'one', definition: 'page' }] }));
    await writeFile(join(folder, 'photos.json'), '{}');
    const page = await testBook(app, folder);
    await page.waitForFunction(() => window.imageflow.currentProject);
    if (kind !== 'fatal') await page.locator('.canvas iframe.book-frame-book[data-current][data-ready]').waitFor();
    await app.evaluate(({ dialog }, filePath) => {
      globalThis.exportPrompts = [];
      globalThis.exportResponse = 0;
      dialog.showSaveDialog = async () => ({ canceled: false, filePath });
      dialog.showMessageBox = async (_owner, options) => { globalThis.exportPrompts.push(options); return { response: globalThis.exportResponse }; };
    }, output);
    const run = () => page.evaluate(async () => {
      const { value } = await window.imageflow.currentProject();
      return window.imageflow.exportBook(value.id);
    });
    const result = await run();
    const prompts = await app.evaluate(() => globalThis.exportPrompts);
    if (kind === 'clean') {
      assert.ok(result.value, JSON.stringify(result));
      assert.deepEqual(result.value.errors, []);
      assert.equal(prompts.length, 0, 'A valid book saves without confirmation');
      assert.equal((await PDFDocument.load(await readFile(output))).getPageCount(), 2);
    } else if (kind === 'fatal') {
      assert.match(result.error, /Export render failed/);
      assert.equal(prompts.length, 0, 'A failed render cannot be exported anyway');
      await assert.rejects(readFile(output), { code: 'ENOENT' });
    } else {
      assert.equal(result.value, null, JSON.stringify(result));
      assert.equal(prompts.length, 1);
      assert.deepEqual(prompts[0].buttons, ['Cancel', 'Export Anyway']);
      assert.equal(prompts[0].defaultId, 0);
      assert.match(prompts[0].detail, kind === 'layout' ? /Page count/ : kind === 'resources' ? /transparency is forbidden/i : /The PDF is/);
      await assert.rejects(readFile(output), { code: 'ENOENT' });
      await writeFile(output, 'Keep the existing file');
      await run();
      assert.equal(await readFile(output, 'utf8'), 'Keep the existing file', 'Cancel preserves an existing destination');
      await app.evaluate(() => { globalThis.exportResponse = 1; });
      const accepted = await run();
      assert.ok(accepted.value?.errors.length, JSON.stringify(accepted));
      if (kind !== 'layout') assert.ok(accepted.value.errors.some(({ code }) => code === (kind === 'resources' ? 'pdf-resource' : 'pdf-file-size')));
      assert.equal((await PDFDocument.load(await readFile(output))).getPageCount(), 2);
    }
  }
  console.log('PDF export passed: clean output, layout/PDF errors, Cancel, Export Anyway, overwrite preservation and fatal render failures.');
} finally {
  await closeApp(app);
  await rm(work, { recursive: true, force: true });
}
