import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import sharp from 'sharp';
import { closeApp, testBook } from './ui-actions.mjs';

// Layout-family pickers through check_book (API-008): the picker drawn as the settings show it, and a click on one of
// its controls reported as the variant it chooses, for a built-in choice and a template component. Nothing is saved.
const root = fileURLToPath(new URL('../', import.meta.url));
const work = await mkdtemp(join(root, '.build', 'mcp-picker-'));
const folder = join(work, 'Picker.imageflow');
let app, client;
try {
  await mkdir(join(folder, 'template'), { recursive: true });
  await writeFile(join(folder, 'template/index.tsx'), `import { Choice, defineTemplate, mm, printFormat, Spread } from 'imageflow';
import type { LayoutPickerProps } from 'imageflow';
function GridPicker({ variants, current, choose, find, readOnly }: LayoutPickerProps) {
  const tags = variants.find(({ id }) => id === current)?.variant ?? {};
  return <div>
    <Choice label="Columns" value={tags.columns as number} disabled={readOnly}
      options={[2, 3].map((value) => ({ value, label: value + ' columns', disabled: !find({ columns: value, rows: tags.rows }) }))}
      onChange={(value) => choose(find({ columns: value, rows: tags.rows })!)} />
    <Choice label="Rows" value={tags.rows as number} disabled={readOnly}
      options={[2, 3].map((value) => ({ value, label: value + ' rows', disabled: !find({ columns: tags.columns, rows: value }) }))}
      onChange={(value) => choose(find({ columns: tags.columns, rows: value })!)} />
  </div>;
}
const plain = (label: string) => ({ label, render: () => <Spread><p>{label}</p></Spread> });
export default defineTemplate({ id: 'mcp-picker', version: '1', contract: 1,
  format: printFormat({ label: 'Square', trim: { width: mm(100), height: mm(100) }, bleed: mm(0), safe: mm(5), ends: 'inside-covers', pageCount: { min: 2, max: 100, step: 2 } }),
  layoutFamilies: {
    pair: { label: 'Photo pair', picker: { label: 'Arrangement', choice: { tag: 'arrangement', options: { stacked: 'Stacked', side: 'Side by side' } } } },
    grid: { label: 'Photo grid', picker: { label: 'Grid size', component: GridPicker } },
  },
  spreads: {
    stacked: { ...plain('Stacked pair'), family: 'pair', variant: { arrangement: 'stacked' } },
    side: { ...plain('Side-by-side pair'), family: 'pair', variant: { arrangement: 'side' } },
    g22: { ...plain('Grid 2 × 2'), family: 'grid', variant: { columns: 2, rows: 2 } },
    g32: { ...plain('Grid 3 × 2'), family: 'grid', variant: { columns: 3, rows: 2 } },
    g33: { ...plain('Grid 3 × 3'), family: 'grid', variant: { columns: 3, rows: 3 } },
    text: plain('Text'),
  },
});`);
  const project = { schemaVersion: 1, title: 'Picker', template: { id: 'mcp-picker', version: '1' },
    spreads: [{ id: 'pair', definition: 'stacked' }, { id: 'grid', definition: 'g22' }, { id: 'text', definition: 'text' }] };
  await writeFile(join(folder, 'project.json'), JSON.stringify(project));
  await writeFile(join(folder, 'photos.json'), '{}');
  app = await _electron.launch({ executablePath: electron, args: [join(root, '.build/desktop'), '--user-data-dir=' + join(work, 'profile')],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, IMAGEFLOW_HIDE_WINDOW: '1' } });
  const window = await testBook(app, folder);
  const connection = await window.evaluate(() => window.imageflow.mcpSettings(true));
  client = new Client({ name: 'Picker MCP smoke', version: '1' });
  await client.connect(new StdioClientTransport({ ...connection.value.launch, stderr: 'pipe' }));
  async function call(name, args = {}) {
    const response = await client.callTool({ name, arguments: args }, { timeout: 110000 });
    const data = response.structuredContent ?? JSON.parse(response.content.find((item) => item.type === 'text').text);
    return { data, response };
  }
  const good = async (name, args) => {
    const result = await call(name, args);
    assert.ok(!result.response.isError, JSON.stringify(result.data));
    return result;
  };
  const handle = (await good('list_projects')).data.projects.find((item) => item.folder === folder).project;
  const picker = (target) => good('check_book', { project: handle, preview: { target: { picker: true, ...target } } });
  const pixels = async (response) => {
    const image = response.content.find((item) => item.type === 'image');
    assert.ok(image, 'the picker comes back as an image');
    return sharp(Buffer.from(image.data, 'base64')).metadata();
  };

  // A built-in choice picker: shown with the saved variant, and a click on another option chooses it.
  const shown = await picker({ spread: 'pair' });
  assert.deepEqual({ kind: shown.data.image.kind, family: shown.data.image.family, picker: shown.data.image.picker, current: shown.data.image.current },
    { kind: 'picker', family: 'pair', picker: 'choice', current: 'stacked' });
  assert.equal(shown.data.image.chosen, undefined);
  assert.deepEqual(shown.data.image.variants.map(({ id }) => id), ['stacked', 'side']);
  const size = await pixels(shown.response);
  assert.equal(size.width, shown.data.image.width);
  assert.equal(size.height, shown.data.image.height);
  assert.equal((await picker({ spread: 'pair', choose: 'Side by side' })).data.image.chosen, 'side');

  // A template's component picker with two independent choices, from another current variant.
  const grid = await picker({ spread: 'grid', choose: '3 columns' });
  assert.equal(grid.data.image.picker, 'component');
  assert.equal(grid.data.image.chosen, 'g32');
  assert.equal((await picker({ spread: 'grid', current: 'g32', choose: '3 rows' })).data.image.chosen, 'g33');
  // 2 × 3 has no variant, so the template disables that option; clicking it is reported, not chosen.
  const disabled = await picker({ spread: 'grid', choose: '3 rows' });
  assert.equal(disabled.data.image.chosen, undefined);
  assert.match(disabled.data.image.notices[0], /disabled/);

  // Errors name what exists.
  const unknown = await call('check_book', { project: handle, preview: { target: { spread: 'grid', picker: true, choose: '4 columns' } } });
  assert.ok(unknown.response.isError || unknown.data.diagnostics?.some(({ message }) => /2 columns/.test(message)), JSON.stringify(unknown.data));
  const none = await call('check_book', { project: handle, preview: { target: { spread: 'text', picker: true } } });
  assert.ok(none.response.isError || none.data.diagnostics?.some(({ message }) => /Families: pair, grid/.test(message)), JSON.stringify(none.data));
  assert.equal((await picker({ spread: 'text', family: 'pair' })).data.image.current, 'stacked');

  // Nothing was saved.
  assert.deepEqual(JSON.parse(await readFile(join(folder, 'project.json'), 'utf8')).spreads, project.spreads);
  console.log('MCP picker smoke passed');
} finally {
  await client?.close().catch(() => {});
  if (app) await closeApp(app);
  await rm(work, { recursive: true, force: true });
}
