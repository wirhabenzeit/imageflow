import { testBook } from './ui-actions.mjs';
import assert from 'node:assert/strict';
import { createCipheriv, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import sharp from 'sharp';
import electron from 'electron';
import { _electron } from 'playwright-core';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixtureKind = 'imageflow-authoring-benchmark-1';
const dimensions = { width: 6000, height: 4000 };
const minimumPhotoBytes = 15_000_000;
const maximumPhotoBytes = 20_000_000;
const baselineRevision = '4b9f0b61072613b1b596dd7c3e8b81d8b8eba3e2';
const execute = promisify(execFile);

function argumentsFor(argv) {
  const [command, ...args] = argv;
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    if (!args[index].startsWith('--') || args[index + 1] === undefined) throw new Error('Pass named options as --name value.');
    options[args[index].slice(2)] = args[index + 1];
  }
  return { command, options };
}

function photoPixels(index) {
  const { width, height } = dimensions;
  const key = createHash('sha256').update('ImageFlow benchmark unique photo ' + index).digest();
  const noise = createCipheriv('aes-256-ctr', key, Buffer.alloc(16)).update(Buffer.alloc(width * height * 3));
  const pixels = new Uint8ClampedArray(width * height * 3);
  const ridge = Float32Array.from({ length: width }, (_, x) =>
    height * (.38 + .08 * Math.sin(x / 650 + index * .17) + .025 * Math.sin(x / 110 + index)));
  const tint = index % 19;
  for (let y = 0; y < height; y++) {
    const foreground = y > height * .76;
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 3;
      const sky = y < ridge[x];
      const grain = (noise[offset] - 128) * .72;
      pixels[offset] = (sky ? 90 + tint : foreground ? 94 : 117) + grain + (noise[offset + 1] - 128) * .1;
      pixels[offset + 1] = (sky ? 134 : foreground ? 121 - tint : 109) + grain;
      pixels[offset + 2] = (sky ? 164 - tint : foreground ? 81 : 98 + tint) + grain + (noise[offset + 2] - 128) * .1;
    }
  }
  return Buffer.from(pixels.buffer);
}

async function encodedPhoto(index, initialQuality = 97) {
  const pixels = photoPixels(index);
  let quality = initialQuality;
  for (;;) {
    const bytes = await sharp(pixels, { raw: { ...dimensions, channels: 3 } })
      .jpeg({ quality, chromaSubsampling: '4:2:0' }).toBuffer();
    if (bytes.length >= minimumPhotoBytes && bytes.length <= maximumPhotoBytes) return { bytes, quality };
    const next = quality + (bytes.length < minimumPhotoBytes ? 1 : -1);
    if (next < 50 || next > 100) throw new Error('The generated JPEG cannot meet the required byte range.');
    quality = next;
  }
}

async function prepare(fixture, count) {
  assert.ok(Number.isInteger(count) && count >= 1 && count <= 300, 'Photo count must be between 1 and 300.');
  const book = join(fixture, 'book.imageflow');
  await mkdir(join(book, 'photos'), { recursive: true });
  const metadataPath = join(fixture, 'metadata.json');
  let metadata = await readFile(metadataPath, 'utf8').then(JSON.parse).catch(() => ({
    kind: fixtureKind, dimensions, synthesis: 'Unique deterministic textured landscape pixels, encoded as ordinary JPEGs without padding.', photos: [],
  }));
  assert.equal(metadata.kind, fixtureKind);
  const started = performance.now();
  for (let index = 0; index < count; index++) {
    const name = 'photo-' + String(index + 1).padStart(3, '0') + '.jpg';
    const path = join(book, 'photos', name);
    const existing = metadata.photos[index];
    if (existing && (await stat(path).catch(() => undefined))?.size === existing.bytes) continue;
    const { bytes, quality } = await encodedPhoto(index, metadata.photos[0]?.quality);
    const image = await sharp(bytes).metadata();
    assert.deepEqual([image.width, image.height], [dimensions.width, dimensions.height]);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    assert.ok(!metadata.photos.some((photo, other) => other !== index && photo.sha256 === sha256), 'Every original must have unique encoded image bytes.');
    await writeFile(path, bytes);
    metadata.photos[index] = { name, bytes: bytes.length, quality, sha256 };
    await writeFile(metadataPath, JSON.stringify(metadata, null, 2) + '\n');
    if (index === 0 || (index + 1) % 10 === 0 || index + 1 === count) {
      console.log(JSON.stringify({ phase: 'generate', completed: index + 1, count, sizeMB: Math.round(bytes.length / 100_000) / 10,
        elapsedSeconds: Math.round((performance.now() - started) / 1000) }));
    }
  }
  metadata = { ...metadata, count, totalBytes: metadata.photos.slice(0, count).reduce((sum, photo) => sum + photo.bytes, 0) };
  metadata.spreads = Math.ceil(count / 2);
  await createBook(fixture, metadata);
  await writeFile(metadataPath, JSON.stringify(metadata, null, 2) + '\n');
  console.log(JSON.stringify({ phase: 'prepared-originals', fixture, count, totalGB: metadata.totalBytes / 1e9 }));
}

async function createBook(fixture, metadata) {
  const book = join(fixture, 'book.imageflow');
  await Promise.all(['template', 'texts'].map((folder) => mkdir(join(book, folder), { recursive: true })));
  const template = `import { defineTemplate, mm, Spread, PhotoBox, MarkdownBox } from 'imageflow';
import './style.css';
export default defineTemplate({
  id:'authoring-performance',version:'1',contract:1,
  format:{label:'Large book proof',trim:{width:mm(210),height:mm(210)},
    bleed:{top:mm(3),bottom:mm(3),outside:mm(3),binding:mm(0)},
    safe:{top:mm(5),bottom:mm(5),outside:mm(5),binding:mm(5)},
    structure:{delivery:'pages',ends:'inside-covers',pageCount:{min:2,max:500,step:2}},
    output:{container:'pdf',colorSpace:'sRGB',transparency:'allow',resolution:{minimum:100,target:150,maximum:150}}},
  spreads:{essay:{label:'Photo essay',boxes:{left:{type:'photo',label:'Left photo'},right:{type:'photo',label:'Right photo'},story:{type:'markdown',label:'Story'}},
    render:ctx=><Spread><div className="bleed" />
      <PhotoBox id="left" style={{position:'absolute',left:'15mm',top:'20mm',width:'180mm',height:'120mm'}} />
      <PhotoBox id="right" style={{position:'absolute',left:'225mm',top:'20mm',width:'180mm',height:'120mm'}} />
      <p className="caption" style={{left:'15mm'}}>{ctx.boxes.left.photo?.title}</p>
      <MarkdownBox id="story" className="story" />
      <span className="folio" style={{left:'15mm'}}>{ctx.page.left}</span>
      <span className="folio" style={{left:'225mm'}}>{ctx.page.right}</span>
    </Spread>},
  },
});
`;
  const css = `@font-face{font-family:Benchmark;src:url('./font.woff2')}
.if-spread>.bleed{background:#fcfaf5}
.caption,.story,.folio{position:absolute;font-family:Benchmark,serif;font-size:12px;line-height:16px}
.caption{top:150mm;width:180mm;margin:0}
.story{left:225mm;top:150mm;width:180mm;height:45mm}
.story p{margin:0 0 8px}
.folio{top:200mm}
`;
  const photoIndex = Object.fromEntries(metadata.photos.slice(0, metadata.count).map((photo, index) =>
    ['photo-' + (index + 1), { path: 'photos/' + photo.name, title: 'Synthetic landscape texture ' + (index + 1) }]));
  const project = { schemaVersion: 1, title: 'Large authoring benchmark', template: { id: 'authoring-performance', version: '1' },
    texts: { story: 'texts/story.md' }, spreads: Array.from({ length: metadata.spreads }, (_, index) => ({
      id: 'spread-' + String(index + 1).padStart(3, '0'), definition: 'essay',
      boxes: { left: { photo: 'photo-' + (index * 2 + 1) },
        ...(index * 2 + 2 <= metadata.count ? { right: { photo: 'photo-' + (index * 2 + 2) } } : {}), story: { text: 'story' } },
    })) };
  const sentence = 'The trail follows the water past weathered rock, quiet woodland and the shifting light of the coast. ';
  const story = Array.from({ length: metadata.spreads * 2 }, (_, index) =>
    'Field note ' + (index + 1) + '. ' + sentence.repeat(5)).join('\n\n');
  const originals = { 'project.json': JSON.stringify(project, null, 2) + '\n', 'photos.json': JSON.stringify(photoIndex, null, 2) + '\n',
    'template/index.tsx': template, 'template/style.css': css, 'texts/story.md': story };
  await Promise.all(Object.entries(originals).map(([path, bytes]) => writeFile(join(book, path), bytes)));
  await copyFile(join(root, 'sample/starter/template/fonts/source-serif-4-latin-400-normal.woff2'), join(book, 'template/font.woff2'));
  await writeFile(join(fixture, 'original-inputs.json'), JSON.stringify(originals, null, 2) + '\n');
  await copyFile(join(book, 'photos', metadata.photos[0].name), join(fixture, 'original-photo.jpg'));
  const replacement = join(fixture, 'replacement-photo.jpg');
  if (!await stat(replacement).catch(() => undefined)) {
    const { bytes, quality } = await encodedPhoto(1001, metadata.photos[0].quality);
    await writeFile(replacement, bytes);
    metadata.replacement = { bytes: bytes.length, quality, sha256: createHash('sha256').update(bytes).digest('hex') };
  }
}

async function restore(fixture, metadata, clearCache) {
  const book = join(fixture, 'book.imageflow');
  const writer = await stat(join(book, '.imageflow/writer.lock')).catch(() => undefined);
  const journal = await stat(join(book, '.imageflow/persistence/pending-save.json')).catch(() => undefined);
  assert.ok(!writer && !journal, 'Close the benchmark app cleanly before restoring fixture inputs or clearing derived caches.');
  const originals = JSON.parse(await readFile(join(fixture, 'original-inputs.json'), 'utf8'));
  await Promise.all(Object.entries(originals).map(([path, bytes]) => writeFile(join(book, path), bytes)));
  await copyFile(join(fixture, 'original-photo.jpg'), join(book, 'photos', metadata.photos[0].name));
  if (clearCache) await rm(join(book, '.imageflow'), { recursive: true, force: true });
}

async function prepareBaseline(destination) {
  await mkdir(dirname(destination), { recursive: true });
  await mkdir(destination);
  const archive = join(destination, '.baseline-source.tar');
  try {
    await execute('git', ['archive', '--format=tar', '--output=' + archive, baselineRevision], { cwd: root });
    await execute('tar', ['-xf', archive, '-C', destination]);
  } finally { await rm(archive, { force: true }); }
  await symlink(join(root, 'node_modules'), join(destination, 'node_modules'), 'dir');
  const path = join(destination, 'desktop/revisions.ts');
  let source = await readFile(path, 'utf8');
  const replace = (before, after) => {
    assert.ok(source.includes(before), 'The baseline instrumentation requires the expected 4b9f0b6 source.');
    source = source.replace(before, after);
  };
  replace("const manifests = ['project.json', 'photos.json'] as const;", `const manifests = ['project.json', 'photos.json'] as const;
const benchmarkInputMetrics = { captures: 0, filesHashed: 0, bytesHashed: 0, cacheHits: 0, photoFilesHashed: 0, photoBytesHashed: 0 };
const metrics = process.env.IMAGEFLOW_BENCHMARK === '1' ? benchmarkInputMetrics : undefined;
if (metrics) Object.assign(globalThis, { imageflowBenchmarkInputs: () => ({ ...metrics }) });`);
  replace("const hash = createHash('sha256');\n      const bytes", `const hash = createHash('sha256');
      if (metrics) { metrics.filesHashed++; if (input.folder === 'photos') metrics.photoFilesHashed++; }
      const hashBytes = (bytes: Buffer | string) => {
        hash.update(bytes);
        if (metrics) {
          const length = typeof bytes === 'string' ? Buffer.byteLength(bytes) : bytes.length;
          metrics.bytesHashed += length;
          if (input.folder === 'photos') metrics.photoBytesHashed += length;
        }
      };
      const bytes`);
  replace('if (bytes) hash.update(bytes);', 'if (bytes) hashBytes(bytes);');
  replace('for await (const chunk of handle.createReadStream({ autoClose: false, signal })) hash.update(chunk);',
    'for await (const chunk of handle.createReadStream({ autoClose: false, signal })) hashBytes(chunk);');
  replace('async function capture(folder: string, signal?: AbortSignal): Promise<ProjectInputCapture> {',
    'async function capture(folder: string, signal?: AbortSignal): Promise<ProjectInputCapture> {\n  if (metrics) metrics.captures++;');
  await writeFile(path, source);
  await execute('npm', ['run', 'build'], { cwd: destination, maxBuffer: 10 * 1024 * 1024 });
  await execute(process.execPath, ['scripts/stage-desktop.mjs'], { cwd: destination, maxBuffer: 10 * 1024 * 1024 });
  console.log(JSON.stringify({ phase: 'prepared-baseline', revision: baselineRevision, app: join(destination, '.build/desktop'),
    instrumentation: 'Counters only in revision capture and hash updates; hashing behavior unchanged.' }));
}

function metricDelta(before, after) {
  if (!before || !after) return null;
  return Object.fromEntries(Object.keys(after).map((key) => [key, after[key] - (before[key] ?? 0)]));
}

async function run(fixture, options) {
  assert.ok(options.app && options.label, 'run requires --app <staged desktop> and --label <baseline|current>.');
  const repetitions = Number(options.repetitions ?? 3);
  assert.ok(Number.isInteger(repetitions) && repetitions >= 1 && repetitions <= 5, 'Use between one and five warm repetitions.');
  const metadata = JSON.parse(await readFile(join(fixture, 'metadata.json'), 'utf8'));
  assert.equal(metadata.kind, fixtureKind);
  await restore(fixture, metadata, true);
  const output = resolve(options.output ?? join(fixture, '..', options.label + '.json'));
  const profile = join(fixture, '..', options.label + '-profile-' + Date.now());
  const result = { label: options.label, revision: options.revision ?? null, startedAt: new Date().toISOString(),
    stagedMainSha256: createHash('sha256').update(await readFile(join(resolve(options.app), 'main.cjs'))).digest('hex'),
    fixture: { count: metadata.count, spreads: metadata.spreads, pages: metadata.spreads * 2, totalBytes: metadata.totalBytes,
      minPhotoBytes: Math.min(...metadata.photos.map(({ bytes }) => bytes)), maxPhotoBytes: Math.max(...metadata.photos.map(({ bytes }) => bytes)),
      dimensions, synthetic: metadata.synthesis, proofMaximumPpi: 150 },
    machine: { platform: process.platform, arch: process.arch, cpus: os.cpus().length, cpu: os.cpus()[0]?.model,
      memoryBytes: os.totalmem(), node: process.version },
    cacheConditions: 'New app process/profile, fixture-derived caches cleared. OS file cache was not flushed and may be warm.', records: [] };
  const save = () => writeFile(output, JSON.stringify(result, null, 2) + '\n');
  await mkdir(join(output, '..'), { recursive: true });
  let app;
  let client;
  let sampler;
  let sampling = false;
  let peakMemoryMiB = 0;
  let bridgeErrors = '';
  try {
    const opening = performance.now();
    app = await _electron.launch({ executablePath: electron, args: [resolve(options.app), '--user-data-dir=' + profile],
      env: { ...process.env, IMAGEFLOW_HIDE_WINDOW: '1', IMAGEFLOW_BENCHMARK: '1' }, timeout: 20000 });
    const window = await testBook(app, join(fixture, 'book.imageflow'));
    result.runtime = await app.evaluate(() => ({ electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node }));
    window.setDefaultTimeout(120000);
    const project = (await window.evaluate(() => window.imageflow.currentProject())).value.handle;
    const ready = () => window.waitForFunction(() => document.querySelector('iframe.book-frame-book[data-current][data-ready]') &&
      document.querySelector('iframe.book-frame-thumbs[data-current][data-ready]') && !document.querySelector('.preview-state'));
    await ready();
    result.openMs = performance.now() - opening;
    const enabled = await window.evaluate(() => window.imageflow.mcpSettings(true));
    assert.ok(enabled.value?.enabled, JSON.stringify(enabled));
    const transport = new StdioClientTransport({ ...enabled.value.launch, stderr: 'pipe' });
    transport.stderr?.on('data', (chunk) => { bridgeErrors += String(chunk); });
    client = new Client({ name: 'ImageFlow authoring benchmark', version: '1' });
    await client.connect(transport);
    const metrics = () => app.evaluate(() => globalThis.imageflowBenchmarkInputs?.() ?? null);
    const sample = async () => {
      if (sampling) return;
      sampling = true;
      try {
        const memory = await app.evaluate(({ app }) => app.getAppMetrics().reduce((sum, process) => sum + process.memory.workingSetSize, 0));
        peakMemoryMiB = Math.max(peakMemoryMiB, memory / 1024);
      } catch {} finally { sampling = false; }
    };
    sampler = setInterval(() => { void sample(); }, 1000);
    const failedCalls = new Map();
    const measure = async (name, tool, args, edit) => {
      const before = await metrics();
      const started = performance.now();
      await edit?.();
      let response;
      let data;
      let failure;
      try {
        response = await client.callTool({ name: tool, arguments: args }, { timeout: 115000 });
        data = response.structuredContent ?? JSON.parse(response.content.find((item) => item.type === 'text').text);
      } catch (error) { failure = error instanceof Error ? error.message : String(error); }
      const elapsedMs = performance.now() - started;
      const after = await metrics();
      const artwork = response?.content.find((item) => item.type === 'image');
      let image;
      if (artwork) {
        const bytes = Buffer.from(artwork.data, 'base64');
        const decoded = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        image = { width: decoded.info.width, height: decoded.info.height, bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'), pixelSha256: createHash('sha256').update(decoded.data).digest('hex') };
        if (options['audit-dir']) {
          const directory = resolve(options['audit-dir']);
          await mkdir(directory, { recursive: true });
          await writeFile(join(directory, name + '.png'), bytes);
        }
      }
      const record = { name, tool, elapsedMs, success: !failure && !response?.isError && data?.state !== 'error',
        ...(failure ? { failure } : {}), ...(data?.error ? { error: data.error } : {}),
        revision: data?.revision ?? data?.projects?.[0]?.revision ?? null, checks: data?.checks,
        diagnosticCounts: data?.diagnostics?.reduce((counts, item) => { counts[item.severity]++; return counts; }, { error: 0, warning: 0 }),
        diagnostics: data?.diagnostics?.slice(0, 5), image, inputs: metricDelta(before, after), peakMemoryMiB };
      result.records.push(record);
      if (!record.success || record.checks?.layout === 'failed') failedCalls.set(tool, (failedCalls.get(tool) ?? 0) + 1);
      await save();
      console.log(JSON.stringify(record));
      return { data, record };
    };
    const preview = { target: { spread: 'spread-001' }, maxEdge: 400, format: 'png', bounds: 'trim' };
    await measure('cold-context', 'get_authoring_context', { project });
    await measure('first-check-preview', 'check_book', { project, preview });
    const finish = async () => {
      await sample();
      result.peakMemoryMiB = peakMemoryMiB;
      result.finishedAt = new Date().toISOString();
      result.bridgeErrors = bridgeErrors;
      await save();
    };
    if (options['audit-only'] === 'true') {
      await measure('second-check-preview', 'check_book', { project, preview });
      await finish();
      return;
    }
    for (let round = 1; round <= repetitions; round++) {
      for (const [name, tool, args] of [
        ['list', 'list_projects', {}], ['context', 'get_authoring_context', { project }],
        ['inspect', 'inspect_book', { project, view: 'summary' }], ['check-preview', 'check_book', { project, preview }],
      ]) {
        if ((failedCalls.get(tool) ?? 0) >= 2) {
          const skipped = { name: 'warm-' + name + '-' + round, tool, skipped: 'Two earlier calls failed. Further identical warm calls are omitted.' };
          result.records.push(skipped);
          await save();
          console.log(JSON.stringify(skipped));
        } else await measure('warm-' + name + '-' + round, tool, args);
      }
    }
    const discovered = await measure('before-title-list', 'list_projects', {});
    await measure('title-edit', 'apply_project_changes', { project, expectedRevision: discovered.data.projects[0].revision,
      idempotencyKey: options.label + '-title', label: 'Benchmark title edit', operations: [{ op: 'set_title', title: 'Large authoring benchmark edited' }] });
    await ready();
    const cssPath = join(fixture, 'book.imageflow/template/style.css');
    const css = await readFile(cssPath, 'utf8');
    const cssChanged = await measure('template-css-edit-preview', 'check_book', { project, preview }, () => writeFile(cssPath, css.replace('#fcfaf5', '#f3f7ef')));
    await ready();
    const changed = await measure('one-photo-replaced-preview', 'check_book', { project, preview },
      () => copyFile(join(fixture, 'replacement-photo.jpg'), join(fixture, 'book.imageflow/photos', metadata.photos[0].name)));
    if (cssChanged.record.image && changed.record.image) assert.notEqual(cssChanged.record.image.sha256, changed.record.image.sha256);
    await finish();
  } catch (error) {
    result.failure = error instanceof Error ? error.stack : String(error);
    await save();
    throw error;
  } finally {
    clearInterval(sampler);
    await client?.close();
    await app?.close();
    await restore(fixture, metadata, false);
  }
}

async function main() {
  const { command, options } = argumentsFor(process.argv.slice(2));
  const fixture = resolve(options.fixture ?? join(root, '.build', 'authoring-benchmark', 'fixture'));
  if (command === 'prepare') return prepare(fixture, Number(options.count ?? 300));
  if (command === 'prepare-baseline') return prepareBaseline(resolve(options.destination ?? join(root, '.build/authoring-benchmark/baseline')));
  if (command === 'run') return run(fixture, options);
  throw new Error('Usage: node scripts/bench-authoring.mjs prepare, prepare-baseline [--destination path], or run --app path --label baseline|current [--repetitions 3]');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
