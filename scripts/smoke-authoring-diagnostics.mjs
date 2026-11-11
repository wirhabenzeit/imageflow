import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import sharp from 'sharp';

// Box-level text findings, source-located layout errors, declaration checks and preview overlays, through a real
// ImageFlow instance and the official MCP client. Set IMAGEFLOW_DIAGNOSTICS_OUT to keep the overlay previews.
const root = fileURLToPath(new URL('../', import.meta.url));
const out = process.env.IMAGEFLOW_DIAGNOSTICS_OUT;
const work = await mkdtemp(join(root, '.build', 'diagnostics-smoke-'));
const folder = join(work, 'book');
await mkdir(join(folder, 'template'), { recursive: true });
const helper = `export function initial(title: string) {
  // An empty title has no first letter.
  return title[0].toUpperCase();
}
`;
const template = (heading = `p.string({label:'Heading',default:'Field notes',maxLength:200})`) => `import { defineTemplate, mm, Spread, p } from 'imageflow';
import { initial } from './helper';
const abs = (left, top, width, height) => ({position:'absolute',left:left+'mm',top:top+'mm',width:width+'mm',height:height+'mm',margin:0});
export default defineTemplate({id:'diagnostics-test',version:'1',contract:1,
 format:{label:'Square',trim:{width:mm(150),height:mm(150)},
  bleed:{top:mm(3),bottom:mm(3),outside:mm(3),binding:mm(0)},safe:{top:mm(8),bottom:mm(8),outside:mm(8),binding:mm(8)},
  structure:{delivery:'pages',ends:'inside-covers',pageCount:{min:2,max:100,step:2}},
  output:{container:'pdf',colorSpace:'sRGB',transparency:'allow'}},
 spreads:{
  base:{label:'Title',parameters:{heading:${heading},note:p.string({label:'Note',default:'Short note'}),caption:p.string({label:'Caption',default:'A caption'})},
   boxes:{hero:{type:'photo',label:'Photo'}},
   render:ctx=><Spread>
    <ctx.PhotoBox id="hero" style={abs(10,10,100,100)} />
    <h1 {...ctx.edit('heading')} style={{...abs(170,20,110,12),font:'600 18pt/1.2 serif'}}>{ctx.params.heading}</h1>
    <p className="subtitle" style={{...abs(170,30,110,8),font:'11pt/1.2 sans-serif'}}>A subtitle under the heading</p>
    <div {...ctx.edit('note')} style={{...abs(170,60,40,6),overflow:'hidden',font:'10pt/1.2 sans-serif'}}>{ctx.params.note}</div>
    <div className="clip" style={{...abs(170,80,60,6),overflow:'hidden'}}><h2 {...ctx.edit('caption')} style={{margin:0,font:'10pt/1.2 sans-serif'}}>{ctx.params.caption}</h2></div>
    <h2 style={{...abs(170,100,100,8),visibility:'hidden',font:'12pt/1.2 sans-serif'}}>Hidden text in the same place</h2>
    <p style={{...abs(170,100,100,8),font:'12pt/1.2 sans-serif'}}>Visible text in the same place</p>
    <p style={{...abs(170,112,100,8),opacity:0,font:'12pt/1.2 sans-serif'}}>Transparent text over the next line</p>
    <p style={{...abs(170,112,100,8),font:'12pt/1.2 sans-serif'}}>Visible text under transparent text</p>
   </Spread>},
  initial:{label:'Initial',parameters:{title:p.string({label:'Title',default:''})},
   render:ctx=><Spread><h1 style={abs(170,20,100,20)}>{initial(ctx.params.title)}</h1></Spread>},
 }});`;
const entry = join(folder, 'template/index.tsx');
await Promise.all([
  writeFile(entry, template()),
  writeFile(join(folder, 'template/helper.ts'), helper),
  writeFile(join(folder, 'project.json'), JSON.stringify({ schemaVersion: 1, title: 'Diagnostics book', template: { id: 'diagnostics-test', version: '1' },
    spreads: [{ id: 'first', definition: 'base' }] })),
  writeFile(join(folder, 'photos.json'), '{}'),
]);

const app = await _electron.launch({ executablePath: electron, args: [join(root, '.build/desktop'), '--user-data-dir=' + join(work, 'profile')],
  env: { ...process.env, IMAGEFLOW_HIDE_WINDOW: '1' } });
let client;
try {
  const window = await app.firstWindow();
  window.setDefaultTimeout(30000);
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, folder);
  await window.getByRole('button', { name: 'Open project…', exact: true }).click();
  await window.waitForFunction(() => document.querySelector('iframe.book-frame-book[data-current][data-ready]') && !document.querySelector('.preview-state'));
  await window.getByRole('button', { name: 'Connect an agent…', exact: true }).click();
  const dialog = window.getByRole('dialog', { name: 'Connect your agent' });
  await dialog.getByRole('button', { name: 'Enable local connection', exact: true }).click();
  const configuration = dialog.getByRole('textbox', { name: 'MCP connection configuration' });
  await configuration.waitFor();
  const config = JSON.parse(await configuration.inputValue()).mcpServers.imageflow;
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  client = new Client({ name: 'ImageFlow diagnostics test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ ...config, command: process.execPath, stderr: 'pipe' }));
  const call = async (name, args = {}) => {
    const response = await client.callTool({ name, arguments: args }, { timeout: 110000 });
    const data = response.structuredContent ?? JSON.parse(response.content.find((c) => c.type === 'text').text);
    return { data, isError: !!response.isError, image: response.content.find((c) => c.type === 'image') };
  };
  const project = (await call('list_projects')).data.projects[0].project;
  const text = (diagnostics) => diagnostics.filter(({ code }) => code.startsWith('text-'));

  // The saved book fits: no box-level text findings, and every check level reports its outcome.
  let check = (await call('check_book', { project })).data;
  assert.equal(check.state, 'ready');
  assert.deepEqual(check.checks, { bundle: 'passed', declarations: 'passed', layout: 'completed', typescript: 'not-run', fixtures: 'not-run', print: 'not-run' });
  assert.deepEqual(text(check.diagnostics), [], JSON.stringify(check.diagnostics));
  const revision = check.revision;

  // A long heading runs out of its fixed box into the subtitle; a long note is cut off by its clipping box.
  const long = 'An unusually long heading that wraps onto several lines in this narrow box';
  const drafted = (await call('check_book', { project, expectedRevision: revision, draft: { operations: [
    { op: 'set_parameter', scope: 'spread', spread: 'first', key: 'heading', value: long },
    { op: 'set_parameter', scope: 'spread', spread: 'first', key: 'note', value: 'A note far too long for its little clipped box' },
    { op: 'set_parameter', scope: 'spread', spread: 'first', key: 'caption', value: 'A caption that wraps onto many lines inside a container that only has room for one of them, so most of it is hidden' },
  ] } })).data;
  const find = (code) => drafted.diagnostics.find((d) => d.code === code);
  const overflow = find('text-overflows-box'), overlap = find('text-overlap'), clipped = find('text-clipped');
  assert.ok(overflow && overlap && clipped, JSON.stringify(drafted.diagnostics));
  assert.equal(overflow.severity, 'warning');
  assert.deepEqual([overflow.location.spread, overflow.location.parameter, overflow.details.tag], ['first', 'heading', 'h1']);
  assert.ok(overflow.details.overflowBottomMm > 2, JSON.stringify(overflow));
  assert.match(overflow.suggestion, /shorten heading/);
  assert.equal(overlap.location.parameter, 'heading');
  assert.equal(overlap.details.otherTag, 'p');
  assert.ok(overlap.details.overlapMm > 1);
  assert.deepEqual([clipped.location.parameter, clipped.details.tag], ['note', 'div']);
  assert.ok(clipped.details.overflowBottomMm > 0);
  // A heading that fits its own block can still be cut off by a clipping container further out.
  const container = drafted.diagnostics.find((d) => d.code === 'text-clipped' && d.location.parameter === 'caption');
  assert.ok(container, JSON.stringify(drafted.diagnostics));
  assert.deepEqual([container.details.tag, container.details.clippedByTag], ['h2', 'div']);
  assert.ok(container.details.overflowBottomMm > 5, JSON.stringify(container));
  assert.match(container.message, /cut off by its container <div>/);
  // Hidden and transparent text never overlaps visible text.
  assert.ok(!drafted.diagnostics.some((d) => d.code === 'text-overlap' && /same place|transparent/i.test(d.details.text + d.details.otherText)),
    JSON.stringify(drafted.diagnostics));

  // A layout that throws names its spread and the template source line, through the bundle's source map.
  const thrown = (await call('check_book', { project, expectedRevision: revision, draft: { operations: [
    { op: 'insert_spread', definition: 'initial', ref: 'initial', after: 'first' },
  ] } })).data;
  assert.equal(thrown.state, 'error');
  assert.equal(thrown.checks.declarations, 'passed');
  assert.equal(thrown.checks.layout, 'failed');
  const failure = thrown.diagnostics.find((d) => d.code === 'layout-render-failed');
  assert.ok(failure, JSON.stringify(thrown.diagnostics));
  assert.deepEqual([failure.location.spread, failure.location.path, failure.location.line], [thrown.draft.references.initial, 'template/helper.ts', 3]);
  assert.match(failure.message, /toUpperCase|undefined/);

  // Guides and labels are opt-in overlays; clean artwork stays the default.
  const preview = { target: { spread: 'first' }, maxEdge: 800 };
  const clean = await call('check_book', { project, preview });
  const marked = await call('check_book', { project, preview: { ...preview, guides: true, labels: true } });
  assert.equal(clean.data.image.guides, undefined);
  assert.deepEqual([marked.data.image.guides, marked.data.image.labels], [true, true]);
  const pixels = async ({ image }, name) => {
    const bytes = Buffer.from(image.data, 'base64');
    if (out) { await mkdir(out, { recursive: true }); await writeFile(join(out, name), bytes); }
    return sharp(bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  };
  const [plain, overlaid] = [await pixels(clean, 'clean.png'), await pixels(marked, 'guides-labels.png')];
  assert.deepEqual([plain.info.width, plain.info.height], [overlaid.info.width, overlaid.info.height]);
  const count = ({ data }, match) => { let n = 0; for (let i = 0; i < data.length; i += 3) if (match(data[i], data[i + 1], data[i + 2])) n++; return n; };
  const magenta = (r, g, b) => r > 180 && g < 80 && b > 80 && b < 200;
  const orange = (r, g, b) => r > 220 && g > 80 && g < 200 && b < 150 && r - b > 100;
  assert.equal(count(plain, magenta), 0);
  assert.ok(count(overlaid, magenta) > 200, 'Trim guides are drawn.');
  assert.ok(count(overlaid, orange) > 100, 'The photo box is outlined and labelled.');
  assert.equal(count(plain, orange), 0);

  // A declaration that breaks the template contract is reported by path, separately from bundling and layout.
  await writeFile(entry, template(`p.string({label:'Heading',default:'A default longer than allowed',maxLength:5})`));
  const declared = (await call('check_book', { project })).data;
  assert.equal(declared.state, 'error');
  assert.deepEqual([declared.checks.bundle, declared.checks.declarations, declared.checks.layout], ['passed', 'failed', 'failed']);
  const declaration = declared.diagnostics.find((d) => d.code === 'template-declaration-invalid');
  assert.ok(declaration, JSON.stringify(declared.diagnostics));
  assert.equal(declaration.stage, 'template');
  assert.match(declaration.location.declaration, /^spreads\.base\.parameters\.heading/);

  // Template module code that throws while loading is located too.
  await writeFile(entry, template() + '\nif (true) throw new Error("Module setup failed");\n');
  const loading = (await call('check_book', { project })).data;
  const setup = loading.diagnostics.find((d) => /Module setup failed/.test(d.message));
  assert.ok(setup, JSON.stringify(loading.diagnostics));
  assert.equal(setup.location?.path, 'template/index.tsx');
  assert.equal(setup.location?.line, template().split('\n').length + 1);
  assert.equal(loading.checks.declarations, 'not-run');

  await writeFile(entry, template());
  assert.equal((await call('check_book', { project })).data.state, 'ready');
  assert.equal(JSON.parse(await readFile(join(folder, 'project.json'), 'utf8')).spreads.length, 1);
  console.log('ImageFlow authoring diagnostics passed.');
} finally {
  await client?.close();
  await app.close();
  await rm(work, { recursive: true, force: true });
}
