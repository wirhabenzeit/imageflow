import assert from 'node:assert/strict';
import fs, { cp, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import type { TestContext } from 'node:test';
import sharp from 'sharp';
import { photoDetails, photoFile } from '../desktop/photos';
import { captureProjectInputs, captureProjectRevision, ProjectRevisionError } from '../desktop/revisions';

const project = {
  schemaVersion: 1,
  title: 'Revision test',
  template: { id: 'sample', version: '1.0.0' },
  spreads: [{ id: 'cover', definition: 'cover' }],
  texts: { note: 'texts/note.md' },
  files: { route: 'files/route.gpx' },
};
const photos = { image: { path: 'photos/image.jpg' } };
const css = 'body { color: red }';
const newCss = 'body { color: tan }';

async function makeProject(t: TestContext) {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'imageflow-revision-')));
  t.after(() => rm(folder, { recursive: true, force: true }));
  for (const name of ['template', 'texts', 'photos', 'files']) await mkdir(join(folder, name));
  for (const [name, bytes] of Object.entries({
    'project.json': JSON.stringify(project), 'photos.json': JSON.stringify(photos),
    'template/index.tsx': "import './styles.css';", 'template/styles.css': css,
    'texts/note.md': '# Note', 'files/route.gpx': '<gpx/>', 'photos/image.jpg': 'photo bytes',
  })) await writeFile(join(folder, name), bytes);
  return folder;
}

async function replacePreservingTime(path: string, before: Buffer | string, after: Buffer | string) {
  const timestamp = new Date('2024-02-20T00:00:00.000Z');
  await writeFile(path, before);
  await utimes(path, timestamp, timestamp);
  const previous = await stat(path);
  await writeFile(path, after);
  await utimes(path, timestamp, timestamp);
  const next = await stat(path);
  assert.equal(next.ino, previous.ino);
  assert.equal(next.size, previous.size);
  assert.equal(next.mtimeMs, previous.mtimeMs);
}

test('a project revision is deterministic across copies and ignores temporary, cache, and unregistered files', async (t) => {
  const folder = await makeProject(t);
  const { revision, observation } = await captureProjectInputs(folder);
  assert.match(revision, /^[a-f0-9]{64}$/);
  const copy = join(folder, 'copy');
  await mkdir(copy);
  for (const name of ['files', 'photos', 'template', 'texts', 'photos.json', 'project.json']) {
    await cp(join(folder, name), join(copy, name), { recursive: true });
  }
  const copied = await captureProjectInputs(copy);
  assert.equal(copied.revision, revision);
  assert.notEqual(copied.observation, observation);

  await mkdir(join(folder, '.imageflow'));
  await writeFile(join(folder, '.imageflow', 'thumbnail.png'), 'cache');
  await writeFile(join(folder, 'template', '.DS_Store'), 'macOS metadata');
  await writeFile(join(folder, 'template', 'styles.css.swp'), 'editor swap');
  await writeFile(join(folder, 'template', 'styles.css.tmp'), 'editor temporary');
  await writeFile(join(folder, 'photos', 'unused.jpg'), 'unregistered original');
  assert.equal(await captureProjectRevision(folder), revision);
});

test('revision changes with TSX, CSS, manifests, and registered source contents', async (t) => {
  const folder = await makeProject(t);
  let revision = await captureProjectRevision(folder);
  for (const [path, contents] of Object.entries({
    'template/index.tsx': "import './styles.css';\nexport default undefined;",
    'project.json': JSON.stringify({ ...project, title: 'A new title' }),
    'photos.json': JSON.stringify({ image: { ...photos.image, caption: 'A new caption' } }),
    'texts/note.md': '# Another note',
    'files/route.gpx': '<gpx><trk/></gpx>',
  })) {
    await writeFile(join(folder, path), contents);
    const changed = await captureProjectRevision(folder);
    assert.notEqual(changed, revision, path);
    revision = changed;
  }
  await replacePreservingTime(join(folder, 'template/styles.css'), css, newCss);
  const changedCss = await captureProjectRevision(folder);
  assert.notEqual(changedCss, revision);
  await replacePreservingTime(join(folder, 'photos/image.jpg'), 'photo bytes', 'other bytes');
  assert.notEqual(await captureProjectRevision(folder), changedCss);
});

test('a reverted edit restores the content revision and changes the local observation', async (t) => {
  const folder = await makeProject(t);
  const path = join(folder, 'template/styles.css');
  const timestamp = new Date('2024-02-20T00:00:00.000Z');
  await utimes(path, timestamp, timestamp);
  const initial = await captureProjectInputs(folder);
  await replacePreservingTime(path, newCss, css);
  const reverted = await captureProjectInputs(folder);
  assert.equal(reverted.revision, initial.revision);
  assert.notEqual(reverted.observation, initial.observation);
});

test('missing registered sources have a distinct revision and missing manifests fail', async (t) => {
  const folder = await makeProject(t);
  const revision = await captureProjectRevision(folder);
  await rm(join(folder, 'texts/note.md'));
  const missing = await captureProjectRevision(folder);
  assert.notEqual(missing, revision);
  assert.equal(await captureProjectRevision(folder), missing);
  await writeFile(join(folder, 'texts/note.md'), '# Note');
  assert.equal(await captureProjectRevision(folder), revision);

  const index = join(folder, 'photos.json');
  await writeFile(index, '{');
  assert.notEqual(await captureProjectRevision(folder), revision);
  await rm(index);
  await assert.rejects(captureProjectRevision(folder), { code: 'source-missing', path: 'photos.json' });
});

test('revision capture rejects absolute paths, traversal, and symlinks outside the source folder', async (t) => {
  const folder = await makeProject(t);
  for (const path of ['texts/../photos/image.jpg', join(folder, 'texts/note.md')]) {
    await writeFile(join(folder, 'project.json'), JSON.stringify({ ...project, texts: { note: path } }));
    await assert.rejects(captureProjectRevision(folder), { code: 'source-outside-project', path });
  }
  await writeFile(join(folder, 'project.json'), JSON.stringify(project));
  await symlink('../photos/image.jpg', join(folder, 'template/escaped.jpg'));
  await assert.rejects(captureProjectRevision(folder), { code: 'source-outside-project', path: 'template/escaped.jpg' });
});

test('contained template and source aliases track their targets', async (t) => {
  const folder = await makeProject(t);
  await mkdir(join(folder, 'template/components'));
  await writeFile(join(folder, 'template/components/layout.tsx'), 'export const label = "First";');
  await symlink('components', join(folder, 'template/alias'));
  await symlink('note.md', join(folder, 'texts/alias.md'));
  await writeFile(join(folder, 'project.json'), JSON.stringify({ ...project, texts: { note: 'texts/alias.md' } }));
  const initial = await captureProjectRevision(folder);
  await writeFile(join(folder, 'template/components/layout.tsx'), 'export const label = "Second";');
  const changedTemplate = await captureProjectRevision(folder);
  assert.notEqual(changedTemplate, initial);
  await writeFile(join(folder, 'texts/note.md'), '# Another note');
  assert.notEqual(await captureProjectRevision(folder), changedTemplate);
});

test('capture retries a detected change and rejects inputs that keep changing', async (t) => {
  const folder = await makeProject(t);
  const path = join(folder, 'template/styles.css');
  const open = fs.open;
  let mutations = 1;
  let reads = 0;
  const patchedOpen = mock.method(fs, 'open', async (...args: Parameters<typeof open>) => {
    const handle = await open(...args);
    if (args[0] === path) {
      reads++;
      if (mutations) {
        mutations--;
        await writeFile(path, reads % 2 ? newCss + ' ' : css);
      }
    }
    return handle;
  });
  syncBuiltinESMExports();
  try {
    const recovered = await captureProjectRevision(folder);
    assert.equal(reads, 2);
    assert.equal(recovered, await captureProjectRevision(folder));

    reads = 0;
    mutations = 2;
    // Start the next run from a different size so both mutations change the open input.
    await writeFile(path, css);
    await assert.rejects(captureProjectRevision(folder), (error) =>
      error instanceof ProjectRevisionError && error.code === 'source-changed' && error.path === 'template/styles.css');
    assert.equal(reads, 2);
  } finally {
    patchedOpen.mock.restore();
    syncBuiltinESMExports();
  }
});

test('a file added after directory discovery invalidates the in-progress capture', async (t) => {
  const folder = await makeProject(t);
  const open = fs.open;
  const patchedOpen = mock.method(fs, 'open', async (...args: Parameters<typeof open>) => {
    const handle = await open(...args);
    if (args[0] === join(folder, 'template/styles.css')) {
      await writeFile(join(folder, 'template/added.tsx'), 'export const label = "Added";');
    }
    return handle;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(captureProjectRevision(folder, { attempts: 1 }), { code: 'source-changed', path: 'template' });
  } finally {
    patchedOpen.mock.restore();
    syncBuiltinESMExports();
  }
});

test('capture respects cancellation', async (t) => {
  const folder = await makeProject(t);
  await assert.rejects(captureProjectRevision(folder, { signal: AbortSignal.abort() }), { name: 'AbortError' });
});

test('an in-place photo edit with restored mtime uses a fresh thumbnail', async (t) => {
  const folder = await makeProject(t);
  const original = join(folder, 'photos/image.png');
  const cache = join(folder, '.imageflow/photos');
  const png = (background: string) => sharp({ create: { width: 8, height: 8, channels: 3, background } })
    .png({ compressionLevel: 0 }).toBuffer();
  const [red, blue] = await Promise.all([png('#ff0000'), png('#0000ff')]);
  const timestamp = new Date('2024-02-20T00:00:00.000Z');
  await writeFile(original, red);
  await utimes(original, timestamp, timestamp);
  const before = await photoDetails(original);
  const beforeThumb = await photoFile({ ...before, original, cache }, 'thumb');

  await replacePreservingTime(original, red, blue);
  const after = await photoDetails(original);
  const afterThumb = await photoFile({ ...after, original, cache }, 'thumb');
  assert.notEqual(afterThumb, beforeThumb);
  assert.notDeepEqual(await readFile(afterThumb), await readFile(beforeThumb));
});
