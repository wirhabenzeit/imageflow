import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { execFileSync } from 'node:child_process';
import { _electron } from 'playwright-core';
import { testBook } from './ui-actions.mjs';

// A real desktop session: editing typography/occurrences, pending typing, composition, plain paste, fallback,
// save/reopen, failures and conflicts. Runs separately so the default smoke suite stays small.
const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(join(root, '.build'), { recursive: true });
const work = await mkdtemp(join(root, '.build', 'inline-text-'));
const book = join(work, 'Text.imageflow');
await cp(join(root, 'sample/starter'), book, { recursive: true, filter: (p) => basename(p) !== '.imageflow' });
const templateFile = join(book, 'template/index.tsx');
let source = await readFile(templateFile, 'utf8');
const heading = '<ctx.Text presentation="inline" parameter="heading" as="h1" rect={at.right(margin, 120, page - 2 * margin, 110)} />';
assert.ok(source.includes(heading));
source = source.replace(heading, heading + '\n<ctx.Text presentation="inline" parameter="heading" as="h2" rect={at.right(margin, 270, page - 2 * margin, 40)} />');
await writeFile(templateFile, source);
const projectFile = join(book, 'project.json');
const initial = JSON.parse(await readFile(projectFile, 'utf8'));
initial.spreads = initial.spreads.slice(0, 2);
await writeFile(projectFile, JSON.stringify(initial, null, 2));
const firstId = initial.spreads[0].id;
const saved = async (path = 'heading') => JSON.parse(await readFile(projectFile, 'utf8')).spreads[0].params[path];
const ready = 'iframe.book-frame-book[data-current][data-ready]';
let app;
try {
  app = await _electron.launch({ executablePath: electron, args: [join(root, '.build/desktop'), '--user-data-dir=' + join(work, 'profile')],
    env: { ...process.env, IMAGEFLOW_HIDE_WINDOW: '1' }, timeout: 15000 });
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false }); });
  let w = await testBook(app, book, false);
  w.setDefaultTimeout(20000);
  await w.setViewportSize({ width: 1500, height: 1000 }).catch(() => {});
  w.on('console', (message) => { if (message.type() === 'error') console.error('renderer:', message.text()); });
  const artwork = () => w.frameLocator(ready);
  const occurrence = (index = 0, path = 'heading') => artwork().locator('[data-spread="' + firstId + '"] [data-edit="' + path + '"]').nth(index);
  const editor = () => w.frameLocator('.inline-text-editor iframe');
  const input = () => editor().getByRole('textbox');
  async function open(index = 0, path = 'heading') {
    await w.locator(ready).waitFor();
    const target = occurrence(index, path);
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    await w.mouse.click(box.x + box.width * .5, box.y + box.height * .5);
    await input().waitFor();
    await w.locator('.inline-text-editor.showing').waitFor();
  }
  async function done() {
    await w.getByRole('button', { name: 'Done', exact: true }).click();
    await w.locator('.inline-text-editor').waitFor({ state: 'detached' });
    await w.locator(ready).waitFor();
  }
  const baseline = await saved();
  await open(1);
  assert.equal(await occurrence(0).getAttribute('data-if-editing'), null);
  await occurrence(1).evaluate((node) => { if (!node.hasAttribute('data-if-editing')) throw new Error('Only activated occurrence hides'); });
  const styles = (node) => node.evaluate((node) => {
    const css = getComputedStyle(node); return [css.fontFamily, css.fontSize, css.lineHeight, css.letterSpacing, css.width, css.whiteSpace];
  });
  assert.deepEqual(await styles(input()), await styles(occurrence(1)), 'same typography and width');
  await input().fill('Pending heading');
  assert.equal(await saved(), baseline, 'typing stays pending');
  if (process.env.INLINE_TEXT_SCREENSHOT) await w.screenshot({ path: process.env.INLINE_TEXT_SCREENSHOT });
  assert.equal(await occurrence(0).innerText(), baseline, 'other occurrence stays confirmed');
  await w.keyboard.press('Escape');
  await w.locator('.inline-text-editor').waitFor({ state: 'detached' });
  assert.equal(await saved(), baseline);
  console.log('pending typing, occurrence and Escape passed');

  // Whitespace rules come from the template, including the starter's pre-line class, without changing saved spaces.
  await open();
  assert.equal(await input().evaluate((node) => getComputedStyle(node).whiteSpace), 'pre-line');
  await input().fill('');
  await input().pressSequentially('  Two  spaces  ');
  const shownSpacing = await input().innerText();
  await done();
  assert.equal(await saved(), '  Two  spaces  ');
  assert.equal(await occurrence().innerText(), shownSpacing, 'restored artwork uses the same whitespace');
  console.log('authored whitespace and literal saved spaces passed');


  await open();
  await input().fill('First line');
  await w.keyboard.press('Enter');
  await input().pressSequentially('Second line');
  await done();
  assert.equal(await saved(), 'First line\nSecond line');
  assert.equal(await occurrence(1).innerText(), 'First line\nSecond line');
  assert.equal(await occurrence().getAttribute('data-if-editing'), null);
  assert.equal(await w.frameLocator('iframe.book-frame-thumbs[data-current]').locator('[contenteditable]').count(), 0);
  console.log('multiline commit and pure artwork passed');

  await open();
  await input().fill('Plain');
  await input().evaluate((node) => {
    const data = new DataTransfer(); data.setData('text/plain', ' pasted\r\ntext'); data.setData('text/html', '<b>WRONG</b>');
    node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  assert.equal(await input().locator('b').count(), 0);
  await done();
  assert.equal(await saved(), 'Plain pasted\ntext');
  console.log('plain paste passed');

  await open();
  await input().fill('x'.repeat(91));
  await w.getByRole('button', { name: 'Done', exact: true }).click();
  await w.getByRole('alert').filter({ hasText: 'at most 90' }).waitFor();
  assert.equal(await saved(), 'Plain pasted\ntext');
  assert.equal(await input().innerText(), 'x'.repeat(91));
  await w.getByRole('button', { name: 'Edit Heading', exact: true }).click();
  await w.getByRole('alert').filter({ hasText: 'Fix the text or choose Discard to continue' }).waitFor();
  assert.equal(await w.locator('.inline-text-editor').count(), 1, 'failed navigation retains the draft with explicit recovery');
  await input().fill('Composition');
  await input().dispatchEvent('compositionstart');
  await w.keyboard.press('Meta+Enter');
  assert.equal(await saved(), 'Plain pasted\ntext', 'IME Enter does not commit');
  await w.getByRole('button', { name: 'Done', exact: true }).click();
  assert.equal(await saved(), 'Plain pasted\ntext', 'flush waits for compositionend');
  await input().dispatchEvent('compositionend');
  await w.locator('.inline-text-editor').waitFor({ state: 'detached' });
  assert.equal(await saved(), 'Composition');
  console.log('constraints and IME flush passed');

  await open(0, 'subtitle');
  await input().fill('Single line');
  await w.keyboard.press('Enter');
  await w.locator('.inline-text-editor').waitFor({ state: 'detached' });
  assert.equal(await saved('subtitle'), 'Single line');
  await w.locator(ready).waitFor();
  console.log('single line Enter passed');

  await open();
  await input().fill('Keyboard heading');
  await w.keyboard.press('Tab');
  await editor().getByRole('textbox', { name: 'Subtitle', exact: true }).waitFor();
  assert.equal(await saved(), 'Keyboard heading');
  await w.keyboard.press('Shift+Tab');
  await editor().getByRole('textbox', { name: 'Heading', exact: true }).waitFor();
  await editor().locator('body').evaluate(() => { window.inlineTextInstance = 'retained'; });
  await w.setViewportSize({ width: 1300, height: 900 }).catch(() => {});
  assert.equal(await editor().locator('body').evaluate(() => window.inlineTextInstance), 'retained');
  await w.keyboard.press('Escape');
  await w.locator('.inline-text-editor').waitFor({ state: 'detached' });
  await w.setViewportSize({ width: 1500, height: 1000 }).catch(() => {});
  console.log('Tab navigation and stable resize passed');


  await open();
  await input().fill('');
  await done();
  assert.equal(await saved(), '');
  await occurrence().locator('.if-text-placeholder').waitFor();
  console.log('empty heading passed');

  await open();
  await input().fill('Native');
  await input().pressSequentially(' typing');
  await w.waitForFunction(() => true);
  for (let n = 0; n < 50 && !await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('native-undo').visible); n++) await new Promise((resolve) => setTimeout(resolve, 50));
  await w.keyboard.press((process.platform === 'darwin' ? 'Meta' : 'Control') + '+z');
  await w.waitForFunction(() => true);
  for (let n = 0; n < 50 && await input().innerText() === 'Native typing'; n++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.notEqual(await input().innerText(), 'Native typing', 'native menu Undo edits typing');
  assert.equal(await saved(), '', 'typing Undo does not undo the book');
  await w.keyboard.press((process.platform === 'darwin' ? 'Meta' : 'Control') + '+Shift+z');
  for (let n = 0; n < 50 && await input().innerText() !== 'Native typing'; n++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(await input().innerText(), 'Native typing');
  await done();
  await w.getByRole('button', { name: 'Undo', exact: true }).click();
  for (let n = 0; n < 50 && await saved() !== ''; n++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(await saved(), '', 'one book Undo reverses a whole typing session');
  await w.locator(ready).waitFor();
  await w.getByRole('button', { name: 'Redo', exact: true }).click();
  for (let n = 0; n < 50 && await saved() !== 'Native typing'; n++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(await saved(), 'Native typing');
  console.log('native typing and book Undo/Redo passed');

  await open();
  await input().fill('Retry save');
  await app.evaluate(({ ipcMain }) => {
    const original = ipcMain._invokeHandlers.get('project:save');
    ipcMain.removeHandler('project:save');
    ipcMain.handle('project:save', () => {
      ipcMain.removeHandler('project:save'); ipcMain.handle('project:save', original);
      return { error: 'Injected save failure' };
    });
  });
  await w.getByRole('button', { name: 'Done', exact: true }).click();
  await w.getByRole('alert').filter({ hasText: 'could not be saved' }).waitFor();
  assert.equal(await input().innerText(), 'Retry save');
  assert.equal(await saved(), 'Native typing');
  await done();
  assert.equal(await saved(), 'Retry save');
  console.log('failed save retains typing and retry passed');

  await open();
  await input().fill('Outside apply');
  const second = await occurrence(1).boundingBox();
  await w.mouse.click(second.x + second.width * .5, second.y + second.height * .5);
  for (let n = 0; n < 100 && await saved() !== 'Outside apply'; n++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(await saved(), 'Outside apply');
  await input().waitFor();
  assert.equal(await input().innerText(), 'Outside apply');
  await w.keyboard.press('Escape');
  await w.locator('.inline-text-editor').waitFor({ state: 'detached' });
  console.log('outside apply and switching occurrence passed');

  // The outer gesture cannot start canvas commands before the text has applied.
  await open();
  await input().fill('Gesture guard');
  await w.locator('.stage').evaluate((stage) => {
    window.outerPresses = 0;
    stage.addEventListener('pointerdown', () => { window.outerPresses++; });
    stage.addEventListener('mousedown', () => { window.outerPresses++; });
  });
  const next = await occurrence(1).boundingBox();
  await w.mouse.click(next.x + next.width * .5, next.y + next.height * .5);
  for (let n = 0; n < 100 && await saved() !== 'Gesture guard'; n++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(await saved(), 'Gesture guard');
  assert.equal(await w.evaluate(() => window.outerPresses), 0, 'the canvas receives no premature press');
  await input().waitFor();
  await w.keyboard.press('Escape');
  await w.locator('.inline-text-editor').waitFor({ state: 'detached' });

  // A trusted-activation action is never replayed synthetically; the next real click performs it.
  await w.evaluate(() => {
    window.trustedActions = [];
    const button = document.createElement('button'); button.id = 'trusted-test';
    button.textContent = 'Trusted action'; button.dataset.requiresUserActivation = '';
    button.style.cssText = 'position:fixed;left:400px;top:60px;z-index:1000';
    button.addEventListener('click', (event) => window.trustedActions.push(event.isTrusted));
    document.body.append(button);
  });
  await open();
  await input().fill('Trusted action draft');
  await w.locator('#trusted-test').click();
  await w.locator('.inline-text-editor').waitFor({ state: 'detached' });
  assert.deepEqual(await w.evaluate(() => window.trustedActions), []);
  await w.locator('#trusted-test').click();
  assert.deepEqual(await w.evaluate(() => window.trustedActions), [true]);
  await w.locator('#trusted-test').evaluate((node) => node.remove());
  console.log('pointer isolation and trusted activation passed');

  await open();
  await input().fill('Unsaved external draft');
  const changed = JSON.parse(await readFile(projectFile, 'utf8'));
  changed.spreads[0].params.heading = 'External heading';
  await writeFile(projectFile, JSON.stringify(changed, null, 2));
  await w.getByRole('alert').filter({ hasText: 'changed while' }).waitFor();
  assert.equal(await w.getByRole('textbox', { name: 'Unsaved text — copy before discarding' }).inputValue(), 'Unsaved external draft');
  assert.equal(await saved(), 'External heading');
  await w.getByRole('button', { name: 'Discard', exact: true }).click();
  await w.locator('.inline-text-editor').waitFor({ state: 'detached' });
  await open();
  assert.equal(await input().innerText(), 'External heading');
  await w.keyboard.press('Escape');
  await w.locator('.inline-text-editor').waitFor({ state: 'detached' });
  console.log('external conflict recovery passed');

  await w.close();
  w = await testBook(app, book, false);
  await w.setViewportSize({ width: 1500, height: 1000 }).catch(() => {});
  await w.locator(ready).waitFor();
  assert.equal(await occurrence().innerText(), 'External heading', 'reopen uses confirmed text');
  const inspectorHeading = w.getByRole('button', { name: 'Edit Heading', exact: true });
  await inspectorHeading.focus();
  await w.keyboard.press('Enter');
  await w.locator('.edit-popover').waitFor();
  assert.equal(await w.locator('.inline-text-editor').count(), 0);
  await w.locator('.edit-popover').press('Escape');
  console.log('reopen and keyboard panel route passed');

  const id = new URL(await w.locator(ready).getAttribute('src')).pathname.split('/').at(-1);
  const capture = () => w.evaluate(({ id, spread }) => window.imageflow.checkBook(id, { preview: { target: { spread }, maxEdge: 600 } }), { id, spread: firstId });
  console.log('capturing confirmed artwork');
  const confirmedImage = await capture();
  console.log('captured confirmed artwork');
  assert.ok(confirmedImage.value?.image?.data, JSON.stringify(confirmedImage.error));
  await open();
  await input().fill('Unconfirmed export typing');
  const pendingImage = await capture();
  console.log('captured artwork with pending typing');
  assert.equal(pendingImage.value?.image?.data, confirmedImage.value.image.data, 'MCP artwork path excludes typing and UI');
  const pdf = join(work, 'confirmed.pdf');
  await app.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }); }, pdf);
  console.log('exporting proof');
  const exported = await w.evaluate((id) => window.imageflow.exportBook(id, 'proof'), id);
  assert.ok(!exported.error, exported.error);
  const pdfText = execFileSync('pdftotext', [pdf, '-'], { encoding: 'utf8' });
  assert.ok(pdfText.includes('External heading'));
  assert.ok(!pdfText.includes('Unconfirmed export typing'));
  await w.keyboard.press('Escape');
  await w.locator('.inline-text-editor').waitFor({ state: 'detached' });
  console.log('proof export contains confirmed text only');

  // A transformed node must retain the accessible parameter route.
  await writeFile(templateFile, source.replace(heading, heading.replace('as="h1"', 'as="h1" style={{ transform: "rotate(8deg)" }}')));
  await w.waitForFunction(() => !document.querySelector('iframe.book-frame-book.book-frame-pending'));
  for (let n = 0; n < 100; n++) {
    const transform = await occurrence().evaluate((node) => getComputedStyle(node).transform).catch(() => 'none');
    if (transform !== 'none') break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const tilted = await occurrence().boundingBox();
  await w.mouse.click(tilted.x + tilted.width * .5, tilted.y + tilted.height * .5);
  await w.locator('.edit-popover').waitFor();
  assert.equal(await w.locator('.inline-text-editor').count(), 0);
  await w.locator('.edit-popover').press('Escape');
  console.log('transformed fallback passed');

  // Restore a normal heading and verify display-only capitalization is not saved into the string.
  await writeFile(templateFile, source.replace(heading, heading.replace('as="h1"', 'as="h1" style={{ textTransform: "uppercase" }}')));
  for (let n = 0; n < 100; n++) {
    const css = await occurrence().evaluate((node) => getComputedStyle(node).textTransform).catch(() => 'none');
    if (css === 'uppercase') break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await open();
  await input().fill('Keep lowercase');
  await done();
  assert.equal(await saved(), 'Keep lowercase');
  console.log('display-only capitalization passed');

  // Ownership is tested through both the page and the Inspector, and includes an editor's layout fields.
  const ownedBook = join(work, 'Owned.imageflow');
  await cp(join(root, 'sample/starter'), ownedBook, { recursive: true, filter: (p) => basename(p) !== '.imageflow' });
  await writeFile(join(ownedBook, 'template/index.tsx'), `
import { defineTemplate, p, Spread, printFormat, mm } from 'imageflow';
const string = (label) => p.string({label, default:'Default text'});
export default defineTemplate({id:'imageflow-starter',version:'1',contract:1,
  format:printFormat({label:'Test',trim:{width:mm(200),height:mm(200)},bleed:mm(0),safe:mm(5),ends:'inside-covers',pageCount:{min:2,max:20,step:2}}),
  parameters:{title:string('Book title')},
  editors:{titles:{label:'Owned book title',parameters:['title'],component:({Control})=><Control parameter="title"/>}},
  spreads:({spread})=>({owned:spread({label:'Ownership',parameters:{heading:string('Spread title')},
    boxes:{hero:{type:'photo',label:'Photo',parameters:{caption:string('Caption')}}},
    elements:{note:{label:'Note',parameters:{text:string('Element text')},
      editor:{label:'Owned note',parameters:['text'],spread:['heading'],component:({Control})=><><Control parameter="text"/><Control parameter="heading" scope="spread"/></>}}},
    render:(ctx)=><Spread>
      <ctx.PhotoBox id="hero" rect={{x:0,y:0,width:200,height:200}}/>
      <ctx.Element id="note" rect={{x:200,y:0,width:200,height:200}}/>
      <ctx.Text parameter="elements.note.text" presentation="inline" rect={{x:220,y:20,width:150,height:20}}/>
      <ctx.Text parameter="heading" presentation="inline" rect={{x:220,y:60,width:150,height:20}}/>
      <ctx.Text parameter="document.title" presentation="inline" rect={{x:220,y:100,width:150,height:20}}/>
      <ctx.Text parameter="boxes.hero.caption" presentation="inline" rect={{x:220,y:140,width:150,height:20}}/>
    </Spread>})})});`);
  const ownedProject = {...initial, spreads:[{id:firstId,definition:'owned',params:{},boxes:{},elements:{}}]};
  await writeFile(join(ownedBook, 'project.json'), JSON.stringify(ownedProject));
  console.log('opening ownership fixture');
  await w.close(); w = await testBook(app, ownedBook, false);
  console.log('ownership fixture opened');
  await w.setViewportSize({width:1500,height:1000}).catch(()=>{});
  await w.locator(ready).waitFor();
  for (const path of ['elements.note.text','heading','document.title']) {
    console.log('opening editor owner:', path);
    const node=occurrence(0,path); await node.scrollIntoViewIfNeeded();const box=await node.boundingBox();
    await w.mouse.click(box.x+box.width/2,box.y+box.height/2);
    await w.locator('.element-editor').waitFor();
    assert.equal(await w.locator('.inline-text-editor').count(),0,'owned text opens its custom editor: '+path);
    const src=await w.locator('.element-editor iframe').getAttribute('src');
    assert.ok(src.includes(path==='document.title'?'editor=titles':'element=note'),src);
    await w.locator('.element-editor').getByRole('button',{name:'Close',exact:true}).click();
    await w.locator('.element-editor').waitFor({state:'detached'});
  }
  await open(1,'boxes.hero.caption');
  await w.keyboard.press('Escape');await w.locator('.inline-text-editor').waitFor({state:'detached'});
  const ownedHeading=w.getByRole('button',{name:'Edit Spread title',exact:true});
  await ownedHeading.focus();await w.keyboard.press('Enter');
  await w.locator('.element-editor').waitFor();
  assert.equal(await w.locator('.edit-popover').count(),0,'Inspector cannot bypass ownership');
  await w.locator('.element-editor').getByRole('button',{name:'Close',exact:true}).click();
  await w.locator('.element-editor').waitFor({state:'detached'});
  console.log('custom editor ownership and unowned box text passed');
  console.log('Inline text smoke passed:', work);
} catch (error) {
  if (app) {
    for (const w of app.windows()) {
      console.error('Window', w.url());
      if (w.url() === 'imageflow://editor/') {
        console.error(await w.locator('body').innerText().catch(() => 'closed'));
        await w.screenshot({ path: join(work, 'failure.png') }).catch(() => {});
      }
    }
  }
  throw error;
} finally {
  if (app) await app.close();
  if (process.env.KEEP_INLINE_TEXT_FIXTURE !== '1') await rm(work, { recursive: true, force: true });
}
