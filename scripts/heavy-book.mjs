// A heavy test book, for measuring the editor at the size of a real book rather than the starter's 34 pages
// (beta finding: timings on small books hid costs that a 160-photo book with maps shows).
//
//   node scripts/heavy-book.mjs [--out .build/heavy-book] [--chapters 15] [--photos 300]
//
// It writes `<out>/Heavy.imageflow`, a copy of the starter with:
// - 15 chapters of 8 spreads each (244 pages): chapter openers, panoramas, grids, stories and notes;
// - 300 linked photos at camera size (6000 × 4000 JPEG, about 5 MB each) in `<out>/photos/`, outside the package,
//   so they are read like a linked Lightroom export folder, together with their capture times;
// - one long Markdown story per chapter, with front matter, flowing over three pages;
// - a Terrain page layout whose picture is drawn on a canvas, like a map's shaded relief (about as slow), offline;
// - `<out>/approvals.json`: the linked photos' approvals and the book's trust, for `approveHeavyBook` to put in a
//   test profile, so the photos load there without a Locate dialog.
//
// Photos are generated once and kept; the book is written anew on every run. Scripts call `heavyBook()`.
import { execFileSync } from 'node:child_process';
import { mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import sharp from 'sharp';
import { copySample } from '../desktop/sample-book.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

const pad = (n, width = 3) => String(n).padStart(width, '0');

async function photo(path, index) {
  // A smooth colour field with fine grain compresses like a photograph, not like noise or a flat colour.
  const small = await sharp({ create: { width: 60, height: 40, channels: 3, noise: { type: 'gaussian', mean: 110 + (index * 37) % 40, sigma: 45 } } })
    .png().toBuffer();
  const { data } = await sharp(small).resize(6000, 4000, { kernel: 'cubic' }).raw().toBuffer({ resolveWithObject: true });
  const grain = await sharp({ create: { width: 6000, height: 4000, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 10 } } }).raw().toBuffer();
  for (let i = 0; i < data.length; i++) data[i] = Math.max(0, Math.min(255, data[i] + grain[i] - 128));
  const taken = new Date(Date.UTC(2026, 7, 16, 6) + index * 23 * 60 * 1000).toISOString().replace('T', ' ').replace(/-/g, ':').slice(0, 19);
  await sharp(data, { raw: { width: 6000, height: 4000, channels: 3 } })
    .withExif({ IFD0: { Make: 'ImageFlow', Model: 'Heavy test book' }, IFD2: { DateTimeOriginal: taken } })
    .jpeg({ quality: 88 }).toFile(path);
}

async function photos(folder, count) {
  await mkdir(folder, { recursive: true });
  const existing = new Set(await readdir(folder));
  const missing = Array.from({ length: count }, (_, i) => i + 1).filter((i) => !existing.has('heavy-' + pad(i) + '.jpg'));
  if (missing.length) console.error('Generating ' + missing.length + ' photos in ' + folder + ' …');
  for (let i = 0; i < missing.length; i += 6) {
    await Promise.all(missing.slice(i, i + 6).map((n) => photo(join(folder, 'heavy-' + pad(n) + '.jpg'), n)));
  }
  return Array.from({ length: count }, (_, i) => join(folder, 'heavy-' + pad(i + 1) + '.jpg'));
}

// The Terrain layout: a page-size picture drawn pixel by pixel from layered noise and shaded from its slope.
const terrainLayout = `
    terrainPage: pageLayout({
      label: 'Terrain', parameters: { seed: p.number({ label: 'Seed', default: 1, min: 1, max: 1000, step: 1 }) },
      render: ctx => {
        const at = ctx.geometry.design(canvas);
        const seed = ctx.params.seed;
        return <PagePaper context={ctx}>
          <div style={{ ...ctx.geometry.css(at.page(24, 24, 242, 242)), position: 'absolute' }}>
            <TerrainPicture seed={seed} />
          </div>
        </PagePaper>;
      },
    }),
`;
// In its own file, as a template keeps its map code apart from its layouts.
const terrainModule = `import { RenderedImage } from 'imageflow';

export function TerrainPicture({ seed }: { seed: number }) {
  return <RenderedImage label="Terrain" output="raster" inputs={{ seed }} style={{ position: 'absolute', inset: 0 }}
    draw={async ({ width, height, pixelRatio }) => drawTerrain(seed, Math.ceil(width * pixelRatio), Math.ceil(height * pixelRatio))} />;
}

// Heavy test book: a shaded terrain drawn on a canvas, about as slow as a map's relief.
function drawTerrain(seed: number, width: number, height: number) {
  const target = new OffscreenCanvas(width, height);
  const image = new ImageData(width, height);
  const hash = (x: number, y: number) => {
    let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(seed, 1442695041);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  };
  const noise = (x: number, y: number) => {
    const xi = Math.floor(x), yi = Math.floor(y), u = x - xi, v = y - yi;
    const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
    const su = u * u * (3 - 2 * u), sv = v * v * (3 - 2 * v);
    return a + (b - a) * su + (c - a) * sv + (a - b - c + d) * su * sv;
  };
  const scale = 5 / Math.max(width, height);
  const elevation = (x: number, y: number) => {
    let sum = 0, amplitude = 1, frequency = scale;
    for (let octave = 0; octave < 6; octave++) { sum += amplitude * noise(x * frequency, y * frequency); amplitude /= 2; frequency *= 2; }
    return sum;
  };
  let above = Float32Array.from({ length: width }, (_, x) => elevation(x, -1));
  for (let y = 0; y < height; y++) {
    const row = Float32Array.from({ length: width }, (_, x) => elevation(x, y));
    for (let x = 0; x < width; x++) {
      const shade = Math.max(0, Math.min(1, .55 + ((row[x] - (x ? row[x - 1] : row[x])) - (row[x] - above[x])) * width / 6));
      const i = (y * width + x) * 4;
      image.data[i] = 70 + 150 * shade; image.data[i + 1] = 80 + 140 * shade; image.data[i + 2] = 70 + 120 * shade; image.data[i + 3] = 255;
    }
    above = row;
  }
  target.getContext('2d')!.putImageData(image, 0, 0);
  return target;
}
`;

function story(chapter, paragraphs) {
  const body = Array.from({ length: 18 }, (_, i) => paragraphs[(chapter * 7 + i * 3) % paragraphs.length]);
  body.splice(9, 0, '## Day ' + (chapter * 2 + 2));
  return `---\ntitle: Stage ${chapter + 1}\ndate: 2026-08-${pad(16 + chapter, 2)}\n---\n\n${body.join('\n\n')}\n`;
}

export async function heavyBook({ out = join(root, '.build', 'heavy-book'), chapters = 15, photoCount = 300 } = {}) {
  out = resolve(out);
  const files = await photos(join(out, 'photos'), photoCount);
  const book = join(out, 'Heavy.imageflow');
  await rm(book, { recursive: true, force: true });
  await copySample(join(root, 'sample', 'starter'), book);
  // The starter's own photos and GPX file are not used: every photo is linked.
  await Promise.all(['photos', 'files'].map((folder) => rm(join(book, folder), { recursive: true, force: true })));

  // The template: more pages allowed, and the Terrain layout.
  const entry = join(book, 'template', 'index.tsx');
  let source = await readFile(entry, 'utf8');
  const patch = (from, to) => {
    if (!source.includes(from)) throw new Error('The starter template changed; update scripts/heavy-book.mjs (' + from.slice(0, 40) + ').');
    source = source.replace(from, to);
  };
  patch("import './styles.css';", "import './styles.css';\nimport { TerrainPicture } from './terrain';");
  // 244 pages: the cover formats' spine widths must cover every page count the format allows.
  patch('pageCount: { min: 28, max: 112, step: 4 }', 'pageCount: { min: 28, max: 248, step: 4 }');
  patch('bands: Array.from({ length: 11 }', 'bands: Array.from({ length: 28 }');
  patch('    contents: pageLayout({', terrainLayout.trimStart().replace(/^/, '    ') + '\n    contents: pageLayout({');
  await writeFile(entry, source);
  await writeFile(join(book, 'template', 'terrain.tsx'), terrainModule);

  // Stories: one per chapter, from the starter's paragraphs.
  const paragraphs = (await Promise.all(['arrival', 'notebook', 'return'].map((name) => readFile(join(root, 'sample', 'starter', 'texts', name + '.md'), 'utf8'))))
    .flatMap((text) => text.replace(/^---[\s\S]*?---\n/, '').split(/\n\n+/).map((part) => part.trim()).filter((part) => part && !part.startsWith('#')));
  await mkdir(join(book, 'texts'), { recursive: true });
  const texts = {};
  for (let c = 0; c < chapters; c++) {
    texts['stage-' + pad(c + 1, 2)] = 'texts/stage-' + pad(c + 1, 2) + '.md';
    await writeFile(join(book, texts['stage-' + pad(c + 1, 2)]), story(c, paragraphs));
  }

  // Photos: linked, by absolute path, like an export folder outside the book.
  const index = {};
  const real = await Promise.all(files.map((file) => realpath(file)));
  real.forEach((path, i) => { index['heavy-' + pad(i + 1)] = { path, linked: true, title: 'Heavy ' + pad(i + 1) }; });
  await writeFile(join(book, 'photos.json'), JSON.stringify(index, null, 2) + '\n');

  const project = JSON.parse(await readFile(join(book, 'project.json'), 'utf8'));
  let next = 0;
  const take = () => 'heavy-' + pad(next++ % photoCount + 1);
  const photoBox = () => ({ photo: take() });
  const grid = (ids) => Object.fromEntries(ids.map((id) => [id, photoBox()]));
  const split = (id, left, right) => ({ id, definition: left.definition, split: true, params: {}, boxes: {}, elements: {}, pages: { left: { params: {}, boxes: {}, elements: {}, ...left }, right: { params: {}, boxes: {}, elements: {}, ...right } } });
  const spreads = [];
  for (let c = 0; c < chapters; c++) {
    const text = 'stage-' + pad(c + 1, 2);
    const id = (name) => 'c' + pad(c + 1, 2) + '-' + name;
    spreads.push(
      { id: id('opener'), definition: 'opener', params: { heading: 'Stage ' + (c + 1) }, boxes: { hero: photoBox() } },
      split(id('arrival'), { definition: 'photo', boxes: { hero: photoBox() } }, { definition: 'textPage', params: { heading: '' }, boxes: { body: { text } } }),
      { id: id('panorama'), definition: 'panorama', params: {}, boxes: { hero: photoBox() } },
      split(id('notes'), { definition: 'notePage', params: { heading: 'Along the way', note: 'Four views from stage ' + (c + 1) + '.' } },
        { definition: 'gridPage', boxes: grid(['hero', 'second', 'third', 'fourth']) }),
      split(id('terrain'), { definition: 'terrainPage', params: { seed: c * 2 + 1 } }, { definition: 'textPage', params: { heading: '' }, boxes: { body: { text } } }),
      split(id('grid'), { definition: 'photo', boxes: { hero: photoBox() } },
        { definition: 'gridPage9', boxes: grid(['hero', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth']) }),
      split(id('story'), { definition: 'textPage', params: { heading: '' }, boxes: { body: { text } } }, { definition: 'photo', boxes: { hero: photoBox() } }),
      split(id('quote'), { definition: 'quotePage', params: { quote: 'Each turn opened a different view of the same water.', attribution: 'Stage ' + (c + 1) } },
        { definition: 'terrainPage', params: { seed: c * 2 + 2 } }),
    );
  }
  const [title, contents] = project.spreads;
  title.boxes = { hero: photoBox() };
  contents.pages.left.boxes = { hero: photoBox() };
  project.title = 'Heavy test book';
  project.texts = texts;
  project.files = {};
  project.spreads = [title, contents, ...spreads,
    { id: 'closing', definition: 'notePage', params: { heading: 'The end', note: 'A heavy test book made by scripts/heavy-book.mjs.' }, boxes: {} }];
  await writeFile(join(book, 'project.json'), JSON.stringify(project, null, 2) + '\n');

  const approvals = { 'trust:book': { path: 'trusted' }, ...Object.fromEntries(Object.keys(index).map((id) => ['photo:' + id, { path: index[id].path }])) };
  await writeFile(join(out, 'approvals.json'), JSON.stringify(approvals));
  return { book, approvals, photos: real };
}

// The key ImageFlow files a book's approvals under (desktop/source-identity.ts): its volume, inode and birth time.
export async function bookKey(folder) {
  const info = await stat(folder, { bigint: true });
  let volume = String(info.dev);
  if (process.platform === 'darwin') {
    try {
      const device = execFileSync('/bin/df', ['-P', folder]).toString().trim().split('\n').at(-1).split(/\s+/)[0];
      const uuid = execFileSync('/usr/sbin/diskutil', ['info', '-plist', device]).toString().match(/<key>VolumeUUID<\/key>\s*<string>([A-Fa-f0-9-]+)<\/string>/)?.[1];
      if (uuid) volume = 'volume-' + uuid.toLowerCase();
    } catch { /* The device number stands in, as in the app. */ }
  }
  return `${volume}-${info.ino}-${info.birthtimeNs}`;
}

/** Puts a book's approvals into a test profile (its user data folder) before the app starts. */
export async function approveHeavyBook(profile, book, approvals) {
  await mkdir(join(profile, 'source-access'), { recursive: true });
  await writeFile(join(profile, 'source-access', await bookKey(await realpath(book)) + '.json'), JSON.stringify(approvals));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { out: { type: 'string' }, chapters: { type: 'string' }, photos: { type: 'string' } } });
  const result = await heavyBook({ ...(values.out ? { out: values.out } : {}), ...(values.chapters ? { chapters: Number(values.chapters) } : {}),
    ...(values.photos ? { photoCount: Number(values.photos) } : {}) });
  console.log(result.book);
}
