import assert from 'node:assert/strict';
import { access, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import sharp from 'sharp';
import { renderData, saveGeneratedFile, unreferencedGeneratedFiles } from '../desktop/project';
import type { OpenProject } from '../desktop/project';
import { ProjectSession } from '../desktop/project-session';
import { projectSchema } from '../src/project';
import type { ProjectFiles } from '../src/project';

// Files element editors generate with saveFile (ADR 0006): storage, image metadata, and collection that keeps
// every file the saved state or Undo/Redo still refers to.

async function fixture(t: TestContext) {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'imageflow-generated-')));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const book: OpenProject = {
    folder, cache: join(folder, 'cache'), readOnly: false,
    project: projectSchema.parse({ schemaVersion: 1, title: 'Map book', template: { id: 'test', version: '1' }, spreads: [{ id: 'one', definition: 'main' }] }),
    photoIndex: {}, assets: { files: new Map(), urls: {} }, photos: new Map(), texts: {}, files: {}, problems: [],
    manifests: { 'project.json': Buffer.from(''), 'photos.json': Buffer.from('') },
  };
  book.manifests = { 'project.json': Buffer.from(JSON.stringify(book.project)), 'photos.json': Buffer.from('{}') };
  await writeFile(join(folder, 'project.json'), book.manifests['project.json']);
  await writeFile(join(folder, 'photos.json'), book.manifests['photos.json']);
  const session = new ProjectSession(book);
  t.after(() => session.close());
  return session;
}

const png = (width: number) => sharp({ create: { width, height: 10, channels: 3, background: '#3a6' } }).png().toBuffer();
const exists = (path: string) => access(path).then(() => true, () => false);

async function generate(session: ProjectSession, name: string, bytes: Uint8Array) {
  const { book, id, path } = await saveGeneratedFile(session.book, { name, bytes });
  session.record(book, 'Generate file', false);
  return { id, path };
}

const assign = (session: ProjectSession, id: string): ProjectFiles => {
  const files = structuredClone({ project: session.book.project, photoIndex: session.book.photoIndex });
  files.project.spreads[0].elements.map = { params: { snapshot: id } };
  return files;
};

test('a generated image is stored under a new gn- ID with its pixel size and served by URL, not read as text', async (t) => {
  const session = await fixture(t);
  const { id, path } = await generate(session, 'Map snapshot.png', await png(40));
  assert.match(id, /^gn-[0-9a-f-]{12}$/);
  assert.equal(session.book.project.files[id], 'files/' + id + '-Map snapshot.png');
  assert.ok(await exists(path));
  assert.deepEqual(session.book.files[id], { name: 'Map snapshot.png', extension: '.png', generated: true, image: { width: 40, height: 10 } });
  const data = renderData(session.book, 'view', 'edit');
  assert.match(data.files[id].image!.url!, new RegExp('/render/view/file/' + id + '$'));
  // A second save never replaces the first file.
  const again = await generate(session, 'Map snapshot.png', await png(40));
  assert.notEqual(again.id, id);
  assert.ok(await exists(path));
});

test('saveFile refuses unknown types, mislabelled images and non-UTF-8 text', async (t) => {
  const session = await fixture(t);
  await assert.rejects(saveGeneratedFile(session.book, { name: 'tool.exe', bytes: new Uint8Array([1]) }), /accepts .*\.png/);
  await assert.rejects(saveGeneratedFile(session.book, { name: 'map.jpg', bytes: await png(4) }), /not a valid JPG image/);
  await assert.rejects(saveGeneratedFile(session.book, { name: 'track.gpx', bytes: new Uint8Array([0xff, 0xfe, 0xfd]) }), /not UTF-8/);
  const { id } = await generate(session, 'route.geojson', new TextEncoder().encode('{"type":"FeatureCollection","features":[]}'));
  assert.equal(session.book.files[id].text, '{"type":"FeatureCollection","features":[]}');
  assert.deepEqual(await readdir(join(session.book.folder, 'files')), [id + '-route.geojson']);
});

test('only references outside the file registry keep a generated file', () => {
  const project = projectSchema.parse({ schemaVersion: 1, title: 'T', template: { id: 'test', version: '1' },
    files: { 'gn-aaaaaaaaaaaa': 'files/a.png', 'gn-bbbbbbbbbbbb': 'files/b.png', 'fl-cccccccccccc': 'files/c.gpx' },
    spreads: [{ id: 'one', definition: 'main', elements: { map: { params: { snapshot: 'gn-aaaaaaaaaaaa' } } } }] });
  const older = structuredClone(project);
  older.spreads[0].elements.map.params.snapshot = 'gn-bbbbbbbbbbbb';
  assert.deepEqual(unreferencedGeneratedFiles(project, []), ['gn-bbbbbbbbbbbb']);
  assert.deepEqual(unreferencedGeneratedFiles(project, [older]), []);
  // Files the user chose are never collected.
  older.spreads[0].elements.map.params.snapshot = 'x';
  assert.deepEqual(unreferencedGeneratedFiles(project, [older]), ['gn-bbbbbbbbbbbb']);
});

test('collection keeps files Undo or Redo can restore, and deletes them once no state refers to them', async (t) => {
  const session = await fixture(t);
  const first = await generate(session, 'map.png', await png(20));
  await session.save(assign(session, first.id), 'Edit map');
  const second = await generate(session, 'map.png', await png(30));
  await session.save(assign(session, second.id), 'Edit map');
  // Undo can bring back the first snapshot, so it stays.
  assert.ok(await exists(first.path) && await exists(second.path));
  await session.undo('undo');
  assert.equal(session.book.project.spreads[0].elements.map.params.snapshot, first.id);
  assert.ok(await exists(second.path), 'Redo can restore the second snapshot.');
  // A new edit drops Redo: nothing refers to the second snapshot any more.
  const removed: string[][] = [];
  session.removing = (paths) => { removed.push(paths); };
  await session.save(assign(session, 'none'), 'Clear map');
  assert.ok(await exists(first.path), 'Undo still refers to the first snapshot.');
  assert.ok(!await exists(second.path));
  assert.deepEqual(removed, [['files/' + second.id + '-map.png']]);
  assert.equal(session.book.project.files[second.id], undefined);
  // Undo never brings a collected file back into the registry.
  await session.undo('undo');
  assert.equal(session.book.project.files[second.id], undefined);
  assert.equal(session.book.project.spreads[0].elements.map.params.snapshot, first.id);
  // Closing ends Undo and Redo; only the current state counts then.
  await session.save(assign(session, 'none'), 'Clear map');
  await session.collectGenerated(false);
  assert.ok(!await exists(first.path));
  assert.deepEqual(Object.keys(session.book.project.files), []);
});

test('a draft saved but never assigned is collected at the next save', async (t) => {
  const session = await fixture(t);
  const draft = await generate(session, 'map.png', await png(20));
  await session.save(assign(session, 'none'), 'Edit map');
  assert.ok(!await exists(draft.path));
});
