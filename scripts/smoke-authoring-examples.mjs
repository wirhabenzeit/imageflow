import { menuAction } from './ui-actions.mjs';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import sharp from 'sharp';

// The template authoring workflow through MCP, starting from a shipped example: discover the API and examples, add a
// layout, preview it unsaved, introduce and fix type, render and capability errors, report a structured template
// finding, then save the layout and compare the saved render with its draft preview.
const root = fileURLToPath(new URL('../', import.meta.url));
const work = await mkdtemp(join(root, '.build', 'examples-smoke-'));
const folder = join(work, 'book');
const entry = join(folder, 'template', 'index.tsx');
await mkdir(join(folder, 'template'), { recursive: true });
const minimal = await readFile(join(root, 'docs', 'examples', 'minimal.tsx'), 'utf8');
const end = '\n  },\n});\n';
assert.ok(minimal.endsWith(end));
// A layout an agent adds to the example: an editable note in an element. An empty note is a structured error
// finding, attached directly to the platform component.
const note = `
    note: spread({
      label: 'Note page',
      parameters: { note: p.string({ label: 'Note', default: 'Written on the road.' }) },
      elements: { body: { label: 'Note' } },
      render: (ctx) => {
        const area = geometry.page(ctx.format, 'left', 'safe');
        return <Spread>
          <ctx.Element id="body" {...ctx.edit('note')} style={geometry.css({ ...area, height: 40 })}
            {...(ctx.params.note ? {} : issue({ code: 'note-empty', message: 'The note is empty.', parameter: 'note', severity: 'error',
              suggestion: 'Set the note parameter, or switch this spread to another layout.' }))}>
            <p style={{ margin: 0, font: '12pt/1.4 serif' }}>{ctx.params.note}</p>
          </ctx.Element>
        </Spread>;
      },
    }),`;
const withNote = (layout) => minimal.replace("import { defineTemplate, geometry,", "import { defineTemplate, geometry, issue,")
  .slice(0, -end.length) + layout + end;
await Promise.all([
  writeFile(entry, minimal),
  writeFile(join(folder, 'project.json'), JSON.stringify({ schemaVersion: 1, title: 'Examples', template: { id: 'example-minimal', version: '1.0.0' },
    spreads: [{ id: 'first', definition: 'photo' }] })),
  writeFile(join(folder, 'photos.json'), '{}'),
]);

const app = await _electron.launch({ executablePath: electron, args: [join(root, '.build/desktop'), '--user-data-dir=' + join(work, 'profile')],
  env: { ...process.env, IMAGEFLOW_HIDE_WINDOW: '1' } });
let client;
try {
  const window = await app.firstWindow();
  window.setDefaultTimeout(30000);
  await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, folder);
  await menuAction(app, 'Open project…');
  const shown = () => window.evaluate(() => (document.querySelector('iframe.book-frame-book[data-current][data-ready]')?.getAttribute('src') ?? '') +
    '|' + (document.querySelector('.status-error')?.textContent ?? ''));
  await window.waitForFunction(() => document.querySelector('iframe.book-frame-book[data-current][data-ready]'));
  // Writes a template and waits until the app has rendered it or reported its error, so checks see settled inputs.
  const write = async (text) => {
    const before = await shown();
    await writeFile(entry, text);
    await window.waitForFunction((before) => {
      const state = (document.querySelector('iframe.book-frame-book[data-current][data-ready]')?.getAttribute('src') ?? '') +
        '|' + (document.querySelector('.status-error')?.textContent ?? '');
      return state !== before && (!document.querySelector('.preview-state') || !!document.querySelector('.status-error'));
    }, before, { timeout: 30000 });
  };
  await menuAction(app, 'Agent Connections…');
  const dialog = window.getByRole('dialog', { name: 'Connect your agent' });
  await dialog.getByRole('button', { name: 'Enable local connection', exact: true }).click();
  const configuration = dialog.getByRole('textbox', { name: 'MCP connection configuration' });
  await configuration.waitFor();
  const config = JSON.parse(await configuration.inputValue()).mcpServers.imageflow;
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  client = new Client({ name: 'ImageFlow examples test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ ...config, command: process.execPath, stderr: 'pipe' }));
  const call = async (name, args = {}) => {
    const response = await client.callTool({ name, arguments: args }, { timeout: 110000 });
    return { response, data: response.structuredContent ?? JSON.parse(response.content.find((c) => c.type === 'text').text) };
  };
  const good = async (name, args = {}) => {
    const { response, data } = await call(name, args);
    assert.ok(!response.isError, JSON.stringify(data));
    return data;
  };
  const project = (await good('list_projects')).projects[0].project;

  // Discovery: the installed API, its capabilities and the examples to copy from.
  const context = await good('get_authoring_context', { project, includeExamples: true });
  const shipped = (await readdir(join(root, 'docs', 'examples'))).filter((name) => name.endsWith('.tsx')).map((name) => name.slice(0, -4)).sort();
  assert.deepEqual(context.examples.map(({ name }) => name), shipped);
  assert.ok(context.examples.every(({ description, source }) => description.length > 10 && source.includes('defineTemplate')));
  assert.ok(context.capabilities.templateApi.capabilities.includes('typed-components'));
  const baseline = await good('check_book', { project, typescript: true });
  assert.equal(baseline.state, 'ready', JSON.stringify(baseline.diagnostics));
  assert.equal(baseline.checks.typescript, 'passed');
  assert.deepEqual(baseline.diagnostics, []);

  // Add a layout and preview it unsaved through a draft that inserts it.
  await write(withNote(note));
  const insert = [{ op: 'insert_spread', definition: 'note', ref: 'note', after: 'first' }];
  const draftCheck = async () => {
    const { revision } = (await good('list_projects')).projects[0];
    // A check result with state error is an MCP error result; its structured content is the full report.
    const { response, data } = await call('check_book', { project, expectedRevision: revision, typescript: true,
      draft: { operations: insert }, preview: { target: { spread: '$note' }, maxEdge: 400 } });
    return { revision, result: data, bytes: response.content.find((content) => content.type === 'image')?.data };
  };
  const drafted = await draftCheck();
  assert.equal(drafted.result.state, 'ready', JSON.stringify(drafted.result.diagnostics));
  assert.equal(drafted.result.checks.typescript, 'passed');
  assert.equal(drafted.result.image.draft, true);
  assert.deepEqual(drafted.result.image.page, { left: 3, right: 4 });

  // A type error is located in the source and still returns artwork.
  await write(withNote(note.replace('{ctx.params.note}</p>', '{ctx.params.notes}</p>')));
  const typed = (await draftCheck()).result;
  assert.equal(typed.checks.typescript, 'failed');
  const typeError = typed.diagnostics.find(({ code }) => code === 'typescript-error');
  assert.equal(typeError.location.path, 'template/index.tsx');
  assert.ok(typeError.location.line > 30 && typeError.message.includes('notes'), JSON.stringify(typeError));
  assert.ok(typed.image);

  // A layout that renders a box it does not declare fails to render; the draft reports it without saving anything.
  await write(withNote(note.replace('<ctx.Element id="body"', '<ctx.PhotoBox id={"hero" as never} style={{}} /><ctx.Element id="body"')));
  const broken = (await draftCheck()).result;
  assert.equal(broken.state, 'error');
  assert.match(broken.diagnostics.map(({ message }) => message).join('\n'), /unknown, duplicate, or incompatible box: hero/);

  // A required capability this app lacks, and a helper it does not export, are named before any layout runs.
  await write(minimal.replace("requires: ['geometry', 'typed-components']", "requires: ['geometry', 'teleport']"));
  const capability = (await call('check_book', { project })).data;
  assert.equal(capability.state, 'error');
  assert.match(capability.diagnostics[0].message, /does not provide: teleport\. Update ImageFlow/);
  await write(minimal.replace("import { defineTemplate,", "import { teleport, defineTemplate,") + 'teleport();\n');
  const helper = (await call('check_book', { project })).data;
  assert.equal(helper.state, 'error');
  assert.equal(helper.diagnostics[0].code, 'template-compile-error');
  assert.match(helper.diagnostics[0].suggestion, /does not provide teleport\. Update ImageFlow/);

  // Fixed: save the layout with the operations the draft used. The saved render matches the draft preview.
  await write(withNote(note));
  const fixed = await draftCheck();
  assert.equal(fixed.result.state, 'ready', JSON.stringify(fixed.result.diagnostics));
  const saved = await good('apply_project_changes', { project, expectedRevision: fixed.revision, idempotencyKey: 'add-note', label: 'Add note page',
    operations: insert });
  assert.equal(saved.committed, true);
  const inserted = saved.references.note;
  const checkedSave = await call('check_book', { project, expectedRevision: saved.revision, preview: { target: { spread: inserted }, maxEdge: 400 } });
  const committed = checkedSave.data;
  assert.equal(committed.state, 'ready');
  assert.deepEqual(committed.image.page, fixed.result.image.page);
  const pixels = async (data) => sharp(Buffer.from(data, 'base64')).removeAlpha().raw().toBuffer();
  const [draftPixels, savedPixels] = await Promise.all([pixels(fixed.bytes), pixels(checkedSave.response.content.find((c) => c.type === 'image').data)]);
  assert.equal(draftPixels.length, savedPixels.length);
  let difference = 0;
  for (let i = 0; i < draftPixels.length; i++) difference += Math.abs(draftPixels[i] - savedPixels[i]);
  assert.ok(difference / draftPixels.length < 1, 'The saved render differs from its draft preview by ' + difference / draftPixels.length);

  // A structured template finding on a platform component reaches MCP with its code, severity and location, as the
  // app's Book check shows it, and as an error it blocks print export.
  const emptied = await good('apply_project_changes', { project, expectedRevision: committed.revision, idempotencyKey: 'empty-note', label: 'Empty note',
    operations: [{ op: 'set_parameter', scope: 'spread', spread: inserted, key: 'note', value: '' }] });
  const finding = (await call('check_book', { project, expectedRevision: emptied.revision })).data.diagnostics
    .filter(({ code }) => code === 'template:note-empty');
  assert.deepEqual(finding.map(({ severity, location, suggestion }) => ({ severity, spread: location.spread, element: location.element,
    parameter: location.parameter, hint: !!suggestion })), [{ severity: 'error', spread: inserted, element: 'body', parameter: 'note', hint: true }]);
  const inApp = async () => (await window.frameLocator('iframe.book-frame-book[data-current][data-ready]').locator('body')
    .evaluate(() => window.imageflowRenderStatus))?.errors?.filter(({ code }) => code === 'template:note-empty') ?? [];
  for (let attempt = 0; !(await inApp()).length && attempt < 100; attempt++) await window.waitForTimeout(100);
  assert.deepEqual((await inApp()).map(({ spread, element, parameter, message }) => ({ spread, element, parameter, message })),
    finding.map(({ location, message }) => ({ spread: location.spread, element: location.element, parameter: location.parameter, message })));
  const pdf = join(work, 'print.pdf');
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, pdf);
  await window.locator('.export-menu > summary').click();
  assert.equal(await window.getByRole('button', { name: 'Export print PDF', exact: true }).isDisabled(), true);
  await window.keyboard.press('Escape');
  await menuAction(app, 'Export Print PDF…');
  await window.locator('.status-error', { hasText: 'The note is empty.' }).waitFor({ timeout: 60000 });
  await assert.rejects(readFile(pdf), { code: 'ENOENT' });
  console.log('ImageFlow authoring examples passed.');
} finally {
  await client?.close().catch(() => {});
  await app.close();
  await rm(work, { recursive: true, force: true });
}
