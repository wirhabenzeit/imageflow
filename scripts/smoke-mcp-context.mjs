import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { hashTemplateFiles, listTemplateFiles } from '../desktop/template-hash.mjs';
import { packagedMacExecutable } from './mac-paths.mjs';
import { testBook, undoBook, waitForProject } from './ui-actions.mjs';

// #81: SDK-client coverage of empty books, single pages, inline drafts and explicit multi-book routing.
// This automated scenario also runs against a packaged candidate; real-client signed-update acceptance is #79.
const root = fileURLToPath(new URL('../', import.meta.url));
const packaged = process.argv.includes('--packaged');
const work = await mkdtemp(join(root, '.build', 'mcp-context-'));
const source = `import { defineTemplate, mm, p, printFormat, Spread } from 'imageflow';
export default defineTemplate({id:'mcp-context',version:'1.0.0',contract:1,label:'Context fixture',
 format:printFormat({label:'Single page',trim:{width:mm(160),height:mm(120)},facingPages:false,
   bleed:mm(0),safe:mm(5),pageCount:{min:1,max:20,step:1}}),
 openingSpreads:[{layout:'page',params:{heading:'Opening'}}],
 spreads:{page:{label:'Page',span:'page',parameters:{heading:p.string({label:'Heading',default:'Hello'}),subtitle:p.string({label:'Subtitle',default:''})},
   elements:{note:{label:'Note',parameters:{text:p.string({label:'Note text',default:'Saved note'})},
     editor:{label:'Edit note',parameters:['text'],spread:['subtitle'],presentation:'inline',
       component:({Control})=><div style={{position:'absolute',inset:0}}><Control parameter="text"/><Control parameter="subtitle" scope="spread"/></div>}}},
   render:ctx=><Spread>
     <ctx.Text parameter="heading" presentation="inline" as="h1" rect={{x:10,y:10,width:135,height:15}}/>
     <ctx.Element id="note" rect={{x:10,y:40,width:135,height:65}}>{ctx.elements.note.params.text}</ctx.Element>
   </Spread>}
 }});`;
async function makeBook(name, spreads) {
  const folder = join(work, name + '.imageflow');
  await mkdir(join(folder, 'template'), { recursive: true });
  await writeFile(join(folder, 'template/index.tsx'), source);
  const hash = await hashTemplateFiles(join(folder, 'template'), await listTemplateFiles(join(folder, 'template')));
  await writeFile(join(folder, 'project.json'), JSON.stringify({ schemaVersion: 1, title: 'Same title',
    template: { id: 'mcp-context', version: '1.0.0', hash }, spreads }));
  await writeFile(join(folder, 'photos.json'), '{}');
  return folder;
}
const first = await makeBook('First', []);
const second = await makeBook('Second', [{ id: 'second-page', definition: 'page' }]);
const read = async (folder) => JSON.parse(await readFile(join(folder, 'project.json'), 'utf8'));
let app, client, one;
try {
  app = await _electron.launch({ executablePath: packaged ? packagedMacExecutable(root) : electron,
    args: [...(packaged ? [] : [join(root, '.build/desktop')]), '--user-data-dir=' + join(work, 'profile')],
    // Shown windows are needed for hit-testing inside scaled inline editor frames.
    env: { ...process.env, IMAGEFLOW_HIDE_WINDOW: '' } });
  one = await testBook(app, first);
  one.setDefaultTimeout(20000);
  await one.locator('.empty-book').waitFor();
  const connection = await one.evaluate(() => window.imageflow.mcpSettings(true));
  assert.ok(connection.value?.enabled, JSON.stringify(connection));
  client = new Client({ name: 'MCP context workflow', version: '1' });
  await client.connect(new StdioClientTransport({ ...connection.value.launch, stderr: 'pipe' }));
  async function call(name, args = {}) {
    const response = await client.callTool({ name, arguments: args }, { timeout: 110000 });
    return { response, data: response.structuredContent ?? JSON.parse(response.content.find((item) => item.type === 'text').text) };
  }
  async function good(name, args = {}) {
    const { response, data } = await call(name, args);
    assert.ok(!response.isError, JSON.stringify(data));
    return data;
  }
  const firstHandle = (await good('list_projects')).projects[0].project;
  const inspect = (project) => good('inspect_book', { project, view: 'summary' });
  const summary = await inspect(firstHandle);
  assert.equal(summary.total, 0);
  assert.equal(summary.templateIdentity.saved.id, 'mcp-context');
  assert.equal(summary.templateIdentity.matchesSavedHash, true);
  const empty = await call('check_book', { project: firstHandle });
  assert.ok(empty.data.diagnostics.some((finding) => finding.code === 'book-empty'));
  const absent = await call('check_book', { project: firstHandle, expectedRevision: summary.revision,
    preview: { target: { page: 1 }, maxEdge: 300 } });
  assert.equal(absent.response.isError, true);
  assert.ok(absent.data.diagnostics.some((finding) => finding.code === 'preview-target-not-found'), JSON.stringify(absent.data));
  const context = await good('get_authoring_context', { project: firstHandle });
  assert.deepEqual(context.template.openingSpreads, [{ layout: 'page', params: { heading: 'Opening' } }]);
  assert.deepEqual(context.template.spreads.page.elements.note.editor.spread, ['subtitle']);
  const inserted = await good('apply_project_changes', { project: firstHandle, expectedRevision: context.revision,
    idempotencyKey: 'first-page', label: 'Insert first page', operations: [{ op: 'insert_spread', definition: 'page', ref: 'first', params: { heading: 'Opening' } }] });
  const spread = inserted.references.first;
  const preview = await call('check_book', { project: firstHandle, expectedRevision: inserted.revision,
    preview: { target: { spread, side: 'page' }, maxEdge: 300 } });
  assert.ok(!preview.response.isError, JSON.stringify(preview.data));
  assert.equal(preview.data.image.side, 'page');
  assert.deepEqual(preview.data.image.page, { number: 1 });
  assert.ok(preview.response.content.some((item) => item.type === 'image'));
  const ready = () => one.locator('iframe.book-frame-book[data-current][data-ready]').waitFor();
  const artwork = () => one.frameLocator('iframe.book-frame-book[data-current][data-ready]');
  async function clickArtwork(selector) {
    const target = artwork().locator(selector);
    await target.scrollIntoViewIfNeeded();
    const bounds = await target.boundingBox();
    assert.ok(bounds);
    await one.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  }
  await ready();
  const mutation = (revision, key, operations) => ({ project: firstHandle, expectedRevision: revision, idempotencyKey: key,
    label: 'Agent ' + key, operations });

  // A real inline text draft survives refusal. Completion advances the revision and joins shared Undo.
  await clickArtwork('[data-edit="heading"]');
  const text = one.frameLocator('.inline-text-editor iframe').getByRole('textbox');
  await text.fill('Human heading');
  const old = await inspect(firstHandle);
  const headingEdit = mutation(old.revision, 'heading', [{ op: 'set_parameter', scope: 'spread', spread, key: 'heading', value: 'Agent heading' }]);
  assert.equal((await call('apply_project_changes', headingEdit)).data.error.code, 'EDIT_IN_PROGRESS');
  assert.equal(await text.innerText(), 'Human heading');
  assert.equal((await read(first)).spreads[0].params.heading, 'Opening');
  await one.getByRole('button', { name: 'Done', exact: true }).click();
  await one.locator('.inline-text-editor').waitFor({ state: 'detached' });
  await waitForProject(one, (book) => book.project.spreads[0].params.heading === 'Human heading');
  assert.equal((await call('apply_project_changes', headingEdit)).data.error.code, 'REVISION_CONFLICT');
  const headingSaved = await good('apply_project_changes', { ...headingEdit, expectedRevision: (await inspect(firstHandle)).revision });
  assert.equal(headingSaved.history.undo, 'Agent heading');
  await undoBook(one, 'undo');
  assert.equal((await read(first)).spreads[0].params.heading, 'Human heading');
  await undoBook(one, 'undo');
  assert.equal((await read(first)).spreads[0].params.heading, 'Opening');
  await undoBook(one, 'redo');
  assert.equal((await read(first)).spreads[0].params.heading, 'Human heading');

  // An inline custom editor owns element and spread fields; both retain their saved scope.
  await ready();
  await clickArtwork('[data-element="note"]');
  await one.locator('.inline-editor.showing').waitFor();
  const note = one.frameLocator('iframe.inline-editor-frame').getByRole('textbox', { name: 'Note text', exact: true });
  await note.fill('Human note');
  const noteEdit = mutation((await inspect(firstHandle)).revision, 'note', [
    { op: 'set_parameter', scope: 'element', spread, owner: 'note', key: 'text', value: 'Agent note' },
    { op: 'set_parameter', scope: 'spread', spread, key: 'subtitle', value: 'Owned spread subtitle' },
  ]);
  assert.equal((await call('apply_project_changes', noteEdit)).data.error.code, 'EDIT_IN_PROGRESS');
  assert.equal(await note.inputValue(), 'Human note');
  assert.equal((await read(first)).spreads[0].elements?.note?.params?.text, undefined);
  await one.getByRole('button', { name: 'Done', exact: true }).click();
  await one.locator('.inline-editor').waitFor({ state: 'detached' });
  await waitForProject(one, (book) => book.project.spreads[0].elements?.note?.params?.text === 'Human note');
  assert.equal((await call('apply_project_changes', noteEdit)).data.error.code, 'REVISION_CONFLICT');
  const noteSaved = await good('apply_project_changes', { ...noteEdit, expectedRevision: (await inspect(firstHandle)).revision });
  assert.equal(noteSaved.history.undo, 'Agent note');
  assert.equal((await read(first)).spreads[0].elements.note.params.text, 'Agent note');
  assert.equal((await read(first)).spreads[0].params.subtitle, 'Owned spread subtitle');
  await undoBook(one, 'undo');
  assert.equal((await read(first)).spreads[0].elements.note.params.text, 'Human note');
  assert.equal((await read(first)).spreads[0].params.heading, 'Human heading');
  assert.equal((await read(first)).spreads[0].params.subtitle, undefined);
  await undoBook(one, 'undo');
  assert.equal((await read(first)).spreads[0].elements?.note?.params?.text, undefined);

  // Identical titles stay distinguishable, and focus never redirects a mutation.
  const two = await testBook(app, second);
  await two.locator('iframe.book-frame-book[data-current][data-ready]').waitFor();
  const listed = (await good('list_projects')).projects;
  assert.equal(listed.length, 2);
  assert.ok(listed.every((book) => book.title === 'Same title'));
  assert.equal(listed.find((book) => book.folder === first).project, firstHandle);
  const secondHandle = listed.find((book) => book.folder === second).project;
  assert.notEqual(secondHandle, firstHandle);
  await app.browserWindow(two).then((window) => window.evaluate((window) => { window.show(); window.focus(); }));
  const renamed = await good('apply_project_changes', mutation((await inspect(firstHandle)).revision, 'rename', [{ op: 'set_title', title: 'Only first changed' }]));
  assert.equal(renamed.committed, true);
  assert.equal((await read(first)).title, 'Only first changed');
  assert.equal((await inspect(secondHandle)).title, 'Same title');
  await one.close();
  const stale = await call('inspect_book', { project: firstHandle, view: 'summary' });
  assert.equal(stale.data.error.code, 'PROJECT_CLOSED');
  one = await testBook(app, first);
  await ready();
  const reopenedHandle = (await good('list_projects')).projects.find((book) => book.folder === first).project;
  assert.notEqual(reopenedHandle, firstHandle);
  assert.equal((await call('inspect_book', { project: firstHandle, view: 'summary' })).data.error.code, 'PROJECT_CLOSED');

  // Hold a real mutation at its renderer lease, then close that book while another remains usable.
  const reopened = await inspect(reopenedHandle);
  await app.browserWindow(one).then((window) => window.evaluate((window) => {
    const send = window.webContents.send;
    globalThis.contextLeaseWaiting = false;
    window.webContents.send = function (channel, ...args) {
      if (channel === 'project:agent-lease') { globalThis.contextLeaseWaiting = true; return; }
      return send.call(this, channel, ...args);
    };
  }));
  const pending = call('apply_project_changes', { ...mutation(reopened.revision, 'close-pending', [{ op: 'set_title', title: 'Must never save' }]), project: reopenedHandle });
  let pendingSettled = false;
  void pending.then(() => { pendingSettled = true; }, () => { pendingSettled = true; });
  for (let attempt = 0; !await app.evaluate(() => globalThis.contextLeaseWaiting); attempt++) {
    assert.ok(attempt < 100, 'Pending mutation reached the book lease');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal((await inspect(secondHandle)).title, 'Same title');
  assert.equal(pendingSettled, false, 'The first book request remains pending while the second book responds');
  await one.close();
  const cancelled = await pending;
  assert.equal(cancelled.response.isError, true);
  assert.ok(['CANCELLED', 'PROJECT_CLOSED'].includes(cancelled.data.error.code), JSON.stringify(cancelled.data));
  assert.equal((await read(first)).title, 'Only first changed');
  assert.equal((await inspect(secondHandle)).title, 'Same title');
  assert.deepEqual((await good('list_projects')).projects.map((book) => book.project), [secondHandle]);
  // #136: a context call on the starter book stays near 8k tokens. The reference topics, examples and sources are
  // requested separately, so this budget covers the starter's declarations, file list and the table of contents.
  const starterFolder = join(work, 'Starter.imageflow');
  await testBook(app, starterFolder, true);
  const starter = (await good('list_projects')).projects.find((book) => book.folder === starterFolder).project;
  const starterContext = await good('get_authoring_context', { project: starter });
  const contextBytes = JSON.stringify(starterContext).length;
  assert.ok(contextBytes <= 30_000, 'The starter book context grew to ' + contextBytes + ' bytes; the budget is 30,000 (about 8k tokens).');
  assert.ok(starterContext.template.spreads.story && starterContext.topics.length > 20);
  console.log('ImageFlow MCP context, empty-book, single-page, inline drafts and multi-book workflows passed' + (packaged ? ' (packaged).' : '.'));
} catch (error) {
  if (one && !one.isClosed()) await one.screenshot({ path: join(root, '.build/mcp-context-failure.png') }).catch(() => {});
  throw error;
} finally {
  await client?.close();
  await app?.close();
  await rm(work, { recursive: true, force: true });
}
