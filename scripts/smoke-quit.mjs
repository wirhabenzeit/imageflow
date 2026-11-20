import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';
import { testBook } from './ui-actions.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const work = await mkdtemp(join(root, '.build/quit-smoke-'));
const source = `import { defineTemplate, mm, Spread, p } from 'imageflow';
export default defineTemplate({id:'quit-test',version:'1',contract:1,
 formats:{portrait:{label:'Portrait',trim:{width:mm(80),height:mm(110)},
 bleed:{top:mm(0),bottom:mm(0),outside:mm(0),binding:mm(0)},safe:{top:mm(5),bottom:mm(5),outside:mm(5),binding:mm(5)},
 structure:{delivery:'pages',ends:'inside-covers',pageCount:{min:2,max:100,step:2}},
 output:{container:'pdf',colorSpace:'sRGB',transparency:'allow'}}},defaultFormat:'portrait',
 parameters:{},spreads:{base:{label:'Base',parameters:{heading:p.string({label:'Heading',default:'Hello'}),
 count:p.integer({label:'Count',default:2,min:1,max:10}),mode:p.enum({label:'Mode',default:'a',options:['a','b','c','d','e']})},
 boxes:{},render:ctx=><Spread><h1>{ctx.params.heading}</h1></Spread>}}});`;
async function scenario(name, operation) {
  const folder = join(work, name + '.imageflow');
  await mkdir(join(folder, 'template'), { recursive: true });
  await writeFile(join(folder, 'template/index.tsx'), source);
  await writeFile(join(folder, 'project.json'), JSON.stringify({ schemaVersion: 1, title: name, template: { id: 'quit-test', version: '1' },
    spreads: [{ id: 'first', definition: 'base' }] }));
  await writeFile(join(folder, 'photos.json'), '{}');
  const instance = await _electron.launch({ executablePath: electron,
    args: [join(root, '.build/desktop'), '--user-data-dir=' + join(work, name + '-profile')],
    env: { ...process.env, IMAGEFLOW_HIDE_WINDOW: '1' }, timeout: 15000 });
  const appProcess = instance.process();
  try {
    const page = await testBook(instance, folder);
    await page.locator('iframe.book-frame-book[data-current][data-ready]').waitFor();
    const id = await instance.browserWindow(page).then((window) => window.evaluate((window) => window.id));
    const exit = async (trigger = () => instance.evaluate(({ app }) => { app.quit(); })) => {
      const exited = once(appProcess, 'exit', { signal: AbortSignal.timeout(15000) });
      await trigger();
      const [code] = await exited;
      assert.equal(code, 0);
      await assert.rejects(stat(join(folder, '.imageflow/writer.lock')), { code: 'ENOENT' });
    };
    await operation({ instance, page, folder, id, exit });
    console.log(name + ' passed');
  } finally {
    if (appProcess.exitCode === null) { appProcess.kill('SIGKILL'); await once(appProcess, 'exit'); }
  }
}
try {
  await scenario('focused-field-commit', async ({ page, folder, exit }) => {
    await page.getByRole('textbox', { name: 'Heading', exact: true }).fill('Committed by Quit');
    await exit();
    assert.equal(JSON.parse(await readFile(join(folder, 'project.json'), 'utf8')).spreads[0].params.heading, 'Committed by Quit');
  });
  await scenario('focused-select-and-dialog', async ({ page, exit }) => {
    await page.getByRole('combobox', { name: 'Mode', exact: true }).focus();
    await page.evaluate(() => {
      const dialog = document.createElement('dialog');
      const button = document.createElement('button'); button.textContent = 'Close'; dialog.append(button);
      document.body.append(dialog); dialog.showModal();
    });
    await exit();
  });
  await scenario('invalid-field-recovery', async ({ instance, page, exit }) => {
    await page.getByRole('spinbutton', { name: 'Count', exact: true }).fill('99');
    await instance.evaluate(({ app }) => { app.quit(); });
    await page.getByText(/Finish or discard the active edit/).waitFor();
    assert.equal(page.isClosed(), false);
    await page.getByRole('spinbutton', { name: 'Count', exact: true }).fill('5');
    await exit();
  });
  await scenario('failed-field-save-recovery', async ({ instance, page, folder, exit }) => {
    await instance.evaluate((_, folder) => {
      const fs = process.getBuiltinModule('node:fs/promises'), link = fs.link;
      fs.link = async (...args) => {
        if (args[1] === folder + '/.imageflow/persistence/pending-save.json') {
          fs.link = link;
          throw new Error('Simulated save failure');
        }
        return link(...args);
      };
    }, folder);
    await page.evaluate(() => { globalThis.quitMessages = []; window.imageflow.onAppError((message) => globalThis.quitMessages.push(message)); });
    const heading = page.getByRole('textbox', { name: 'Heading', exact: true });
    await heading.fill('Retry after failure');
    await instance.evaluate(({ app }) => { app.quit(); });
    await page.getByText(/Finish or discard the active edit/).waitFor();
    assert.equal(await heading.inputValue(), 'Retry after failure');
    // Saving a different field cannot silently discard the draft whose write failed.
    const count = page.getByRole('spinbutton', { name: 'Count', exact: true });
    await count.fill('4'); await count.blur();
    await page.waitForFunction(async () => (await window.imageflow.currentProject()).value.project.spreads[0].params.count === 4);
    await instance.evaluate(({ app }) => { app.quit(); });
    await page.waitForFunction(() => globalThis.quitMessages.length === 2);
    await page.locator('.field[data-pending="true"]').waitFor();
    assert.equal(page.isClosed(), false);
    await heading.focus(); // A retry blur commits the retained valid draft.
    await exit();
    assert.equal(JSON.parse(await readFile(join(folder, 'project.json'), 'utf8')).spreads[0].params.heading, 'Retry after failure');
  });
  await scenario('slow-healthy-save', async ({ instance, page, folder, exit }) => {
    // A save that outlasts the acknowledgement window must finish without a "not responding" question.
    await instance.evaluate(({ dialog }, folder) => {
      dialog.showMessageBox = async (_owner, options) => { throw new Error('Unexpected question: ' + options.message); };
      const fs = process.getBuiltinModule('node:fs/promises'), link = fs.link;
      fs.link = async (...args) => {
        if (args[1] === folder + '/.imageflow/persistence/pending-save.json') {
          fs.link = link;
          await new Promise((resolve) => setTimeout(resolve, 12000));
        }
        return link(...args);
      };
    }, folder);
    await page.getByRole('textbox', { name: 'Heading', exact: true }).fill('Saved slowly');
    await exit();
    assert.equal(JSON.parse(await readFile(join(folder, 'project.json'), 'utf8')).spreads[0].params.heading, 'Saved slowly');
  });
  await scenario('crashed-renderer', async ({ instance, id, exit }) => {
    await instance.evaluate(async ({ BrowserWindow }, id) => {
      const contents = BrowserWindow.fromId(id).webContents;
      const gone = new Promise((resolve) => contents.once('render-process-gone', resolve));
      contents.forcefullyCrashRenderer(); await gone;
    }, id);
    await exit();
  });
  await scenario('renderer-reloading', async ({ instance, id, exit }) => {
    await exit(() => instance.evaluate(({ BrowserWindow, app }, id) => { BrowserWindow.fromId(id).webContents.reload(); app.quit(); }, id));
  });
  await scenario('unresponsive-renderer', async ({ instance, id, exit }) => {
    await instance.evaluate(({ BrowserWindow, dialog }, id) => {
      globalThis.quitQuestions = 0;
      dialog.showMessageBox = async (_owner, options) => {
        if (options.message !== 'This book window is not responding.') throw new Error('Unexpected question');
        globalThis.quitQuestions++;
        return { response: globalThis.quitQuestions === 1 ? 0 : 1 };
      };
      void BrowserWindow.fromId(id).webContents.executeJavaScript('while (true) {}').catch(() => {});
    }, id);
    await instance.evaluate(({ app }) => { app.quit(); });
    for (let attempt = 0; ; attempt++) {
      if (await instance.evaluate(() => globalThis.quitQuestions === 1)) break;
      // A hung window is asked about after the 10 s acknowledgement window (desktop/main.ts, quitAcknowledgeMs).
      assert.ok(attempt < 400); await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await exit(); // First Keep Open cancels; Quit Anyway then exits through writer/lock cleanup.
  });
} finally { await rm(work, { recursive: true, force: true }); }
