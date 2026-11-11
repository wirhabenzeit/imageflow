import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import sharp from 'sharp';

// Renders unused layouts with synthetic fixture content through a real ImageFlow instance and the official MCP client.
// Set IMAGEFLOW_FIXTURE_OUT to a folder to keep the returned fixture contact sheets for visual review.
const root = fileURLToPath(new URL('../', import.meta.url));
const out = process.env.IMAGEFLOW_FIXTURE_OUT;
const work = await mkdtemp(join(root, '.build', 'fixture-smoke-'));
const folder = join(work, 'book');
await Promise.all(['template', 'texts'].map((name) => mkdir(join(folder, name), { recursive: true })));
// `fragile` throws when its title is empty; `story` overflows with long Markdown. Neither layout is used by the book.
const source = `import { defineTemplate, mm, Spread, p } from 'imageflow';
const format = (label, w, h) => ({label, trim:{width:mm(w),height:mm(h)},
 bleed:{top:mm(3),bottom:mm(3),outside:mm(3),binding:mm(0)},
 safe:{top:mm(8),bottom:mm(8),outside:mm(8),binding:mm(8)},
 structure:{delivery:'pages',ends:'inside-covers',pageCount:{min:2,max:100,step:2}},
 output:{container:'pdf',colorSpace:'sRGB',transparency:'allow'}});
const abs = (left, top, width, height) => ({position:'absolute',left:left+'mm',top:top+'mm',width:width+'mm',height:height+'mm'});
export default defineTemplate({id:'fixture-test',version:'1',contract:1,
 formats:{portrait:format('Portrait',150,200),landscape:format('Landscape',200,150)},defaultFormat:'portrait',
 spreads:{
  base:{label:'Base',render:ctx=><Spread><p style={abs(20,20,60,10)}>Saved book</p></Spread>},
  story:{label:'Photo story',parameters:{heading:p.string({label:'Heading',default:'Along the coast',maxLength:80})},
   boxes:{hero:{type:'photo',label:'Photo'},text:{type:'markdown',label:'Text'}},
   render:ctx=><Spread><ctx.PhotoBox id="hero" style={abs(-3,-3,ctx.format.trim.width+3,ctx.format.trim.height+6)} />
    <h1 style={{...abs(ctx.format.trim.width+20,15,ctx.format.trim.width-40,30),margin:0,font:'600 20pt/1.2 serif'}}>{ctx.params.heading}</h1>
    <ctx.MarkdownBox id="text" style={{...abs(ctx.format.trim.width+20,50,ctx.format.trim.width-40,ctx.format.trim.height-70),font:'10pt/1.4 serif'}} /></Spread>},
  fragile:{label:'Fragile title',parameters:{title:p.string({label:'Title',default:'Ok'})},
   render:ctx=><Spread><h1 style={abs(20,20,100,20)}>{ctx.params.title[0].toUpperCase() + ctx.params.title.slice(1)}</h1></Spread>},
 }});`;
await Promise.all([
  writeFile(join(folder, 'template/index.tsx'), source),
  writeFile(join(folder, 'project.json'), JSON.stringify({ schemaVersion: 1, title: 'Fixture book', template: { id: 'fixture-test', version: '1' },
    spreads: [{ id: 'first', definition: 'base' }] })),
  writeFile(join(folder, 'photos.json'), '{}'),
]);
const starter = join(work, 'starter');
await cp(join(root, 'sample/starter'), starter, { recursive: true });

const app = await _electron.launch({ executablePath: electron, args: [join(root, '.build/desktop'), '--user-data-dir=' + join(work, 'profile')],
  env: { ...process.env, IMAGEFLOW_HIDE_WINDOW: '1' } });
let client;
try {
  const window = await app.firstWindow();
  window.setDefaultTimeout(30000);
  const open = async (path) => {
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, path);
    await window.getByRole('button', { name: 'Open project…', exact: true }).click();
    await window.waitForFunction(() => document.querySelector('iframe.book-frame-book[data-current][data-ready]') && !document.querySelector('.preview-state'));
  };
  await open(folder);
  await window.getByRole('button', { name: 'Connect an agent…', exact: true }).click();
  const dialog = window.getByRole('dialog', { name: 'Connect your agent' });
  await dialog.getByRole('button', { name: 'Enable local connection', exact: true }).click();
  const configuration = dialog.getByRole('textbox', { name: 'MCP connection configuration' });
  await configuration.waitFor();
  const config = JSON.parse(await configuration.inputValue()).mcpServers.imageflow;
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  client = new Client({ name: 'ImageFlow fixture test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ ...config, command: process.execPath, stderr: 'pipe' }));
  const call = async (name, args = {}) => {
    const response = await client.callTool({ name, arguments: args }, { timeout: 110000 });
    const data = response.structuredContent ?? JSON.parse(response.content.find((c) => c.type === 'text').text);
    assert.ok(!response.isError, JSON.stringify(data).slice(0, 2000));
    return { data, image: response.content.find((c) => c.type === 'image') };
  };
  const decode = async (image, name) => {
    const bytes = Buffer.from(image.data, 'base64');
    if (out) { await mkdir(out, { recursive: true }); await writeFile(join(out, name), bytes); }
    return { bytes, ...(await sharp(bytes).metadata()) };
  };

  let project = (await call('list_projects')).data.projects[0].project;
  const context = (await call('get_authoring_context', { project })).data;
  assert.equal(context.capabilities.fixtures.maxPreviewFixtures, 12);
  const before = await readFile(join(folder, 'project.json'), 'utf8');
  const started = Date.now();
  const { data, image } = await call('check_book', { project, fixtures: { formats: 'all', layouts: ['story', 'fragile'],
    preview: { printFormat: 'landscape', maxEdge: 900, columns: 2, cells: [
      { layout: 'story', case: 'typical' }, { layout: 'story', case: 'portrait-photos' },
      { layout: 'story', case: 'long-text' }, { layout: 'fragile', case: 'empty' }, { layout: 'fragile', case: 'typical' }] } } });
  const elapsed = Date.now() - started;
  const report = data.fixtures;
  assert.equal(data.checks.fixtures, 'completed');
  assert.equal(data.checks.layout, 'completed');
  assert.deepEqual(report.matrix.formats, ['portrait', 'landscape']);
  const cell = (layout, fixture, format) => report.cells.find((c) => c.layout === layout && c.case === fixture && c.format === format);
  for (const format of ['portrait', 'landscape']) {
    // An empty title makes the fragile layout throw. Only that fixture fails; the error boundary keeps the rest.
    assert.equal(cell('fragile', 'empty', format).state, 'failed');
    assert.match(cell('fragile', 'empty', format).message, /undefined|toUpperCase/);
    assert.equal(cell('fragile', 'typical', format).state, 'passed');
    assert.ok(cell('story', 'long-text', format).codes.includes('text-overflow'), JSON.stringify(cell('story', 'long-text', format)));
    assert.equal(cell('story', 'typical', format).state, 'passed', JSON.stringify(report.diagnostics));
    assert.equal(cell('story', 'portrait-photos', format).state, 'passed');
  }
  assert.ok(report.diagnostics.some((d) => d.code === 'layout-render-failed' && d.fixture.layout === 'fragile' && d.fixture.case === 'empty'));
  assert.ok(report.coverage.skipped.some((s) => s.layout === 'fragile' && s.case === 'portrait-photos'));
  // The image is the bannered fixture sheet without the failing fixture, and never the saved book.
  assert.ok(image, 'A fixture contact sheet is returned.');
  assert.equal(data.image.fixture, true);
  assert.equal(data.image.kind, 'contact-sheet');
  assert.deepEqual(data.image.cells.map((c) => c.spread), ['fixture-typical-story', 'fixture-portrait-photos-story', 'fixture-long-text-story', 'fixture-typical-fragile']);
  assert.ok(data.image.cells.every((c) => c.label.startsWith('FIXTURE · ')));
  assert.equal(data.image.banner.text, 'SYNTHETIC FIXTURES · Landscape · not the saved book');
  const sheet = await decode(image, 'fixtures-landscape.png');
  assert.ok(Math.max(sheet.width, sheet.height) <= 900);
  assert.deepEqual([sheet.width, sheet.height], [data.image.width, data.image.height]);
  const { data: banner } = await sharp(sheet.bytes).extract({ left: 0, top: 0, width: sheet.width, height: data.image.banner.height }).removeAlpha()
    .raw().toBuffer({ resolveWithObject: true });
  const dark = [...Array(banner.length / 3).keys()].filter((i) => banner[i * 3] < 60 && banner[i * 3 + 1] < 60 && banner[i * 3 + 2] < 60).length;
  assert.ok(dark / (banner.length / 3) > 0.6, 'The banner is a dark band across the sheet.');
  // The synthetic photo fills the left page of the first fixture.
  const first = data.image.cells[0];
  const page = await sharp(sheet.bytes).extract({ left: first.x + 4, top: first.y + 4, width: Math.floor(first.width / 2) - 8, height: first.height - 8 }).toBuffer();
  const { channels } = await sharp(page).stats();
  assert.ok(channels[0].stdev > 20 && channels[2].mean > channels[0].mean, 'The synthetic photo renders: ' + JSON.stringify(channels));
  assert.equal(await readFile(join(folder, 'project.json'), 'utf8'), before);
  console.log('Fixture matrix: ' + report.coverage.planned + ' fixtures in ' + elapsed + ' ms');

  // The starter template: every layout and case in its current format, with the GPX map element fed malformed data.
  await open(starter);
  project = (await call('list_projects')).data.projects[0].project;
  const starterCheck = await call('check_book', { project, fixtures: { preview: { maxEdge: 1200, columns: 3 } } });
  const starterReport = starterCheck.data.fixtures;
  assert.equal(starterCheck.data.checks.fixtures, 'completed');
  assert.equal(starterReport.coverage.notIsolated, 0);
  assert.ok(starterReport.cells.some((c) => c.case === 'malformed-files'), 'The starter map element receives a malformed GPX file.');
  for (const c of starterReport.cells.filter((c) => c.case === 'typical')) assert.notEqual(c.state, 'failed', JSON.stringify(c));
  // Box-level text checks stay quiet for ordinary content, and catch the long title running into the subtitle.
  const boxText = ['text-overflows-box', 'text-clipped', 'text-overlap'];
  for (const c of starterReport.cells.filter((c) => c.case !== 'long-text')) assert.ok(!c.codes.some((code) => boxText.includes(code)), JSON.stringify(c));
  assert.ok(starterReport.cells.find((c) => c.layout === 'title' && c.case === 'long-text').codes.includes('text-overlap'));
  await decode(starterCheck.image, 'fixtures-starter.png');
  if (process.env.IMAGEFLOW_FIXTURE_DEBUG) console.log(JSON.stringify(starterReport.diagnostics.filter((d) => d.code.startsWith('text-') && d.code !== 'text-overflow'), null, 1));
  console.log('Starter fixtures: ' + JSON.stringify(starterReport.cells.map((c) => [c.layout, c.case, c.state, c.codes.join(',')])));
} finally {
  await client?.close();
  await app.close();
  await rm(work, { recursive: true, force: true });
}
