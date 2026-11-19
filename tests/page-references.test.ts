import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { configureSourceStore } from '../desktop/source-store';
import { configureSourceAccess } from '../desktop/source-access';
import { importIntoProject, loadProject, updateProject } from '../desktop/project';
import { removeSources } from '../desktop/source-actions';
import { copySample } from '../desktop/sample-book.mjs';
import { assetUsage, clearFileAssignments, fileAssigned } from '../src/asset-usage';
import { sourceUsage } from '../src/editing';
import { keptOutside } from '../src/layouts';
import type { Layouts } from '../src/layouts';
import { coverInstance, projectSchema, storedBoxes, storedStates } from '../src/project';
import type { Project, SpreadState } from '../src/project';

// Phase 2 of ADR 0009: every code path that reads or rewrites references reads every state a spread stores. These
// books reference their photos, texts and files only from page states, page parameters and replaced content.

const paged = (ids: { photo: string; text: string; file: string; replaced: string }): Pick<SpreadState, 'pages' | 'displaced'> => ({
  pages: {
    left: { definition: 'photoPage', params: { track: ids.file }, boxes: { hero: { photo: ids.photo, params: {} } }, elements: {} },
    right: { params: {}, boxes: { story: { text: ids.text, params: {} } }, elements: { map: { params: { tracks: [{ id: 'a', track: ids.file }] } } } },
  },
  displaced: [{ from: 'spread', box: 'hero', state: { photo: ids.replaced, params: { tilt: ids.file } } }],
});

test('every state and replaced box is listed, in order', () => {
  const spread = projectSchema.parse({ schemaVersion: 2, title: 'Book', template: { id: 't', version: '1' },
    spreads: [{ id: 's', definition: 'full', boxes: { own: { photo: 'own' } }, ...paged({ photo: 'p', text: 't', file: 'f', replaced: 'r' }) }] }).spreads[0];
  assert.deepEqual(storedStates(spread).map(({ location }) => location), ['spread', 'left', 'right']);
  assert.deepEqual(storedBoxes(spread).map(({ location, box, state, displaced }) => [location, box, state.photo ?? state.text, displaced]),
    [['spread', 'own', 'own', undefined], ['left', 'hero', 'p', undefined], ['right', 'story', 't', undefined], ['spread', 'hero', 'r', 0]]);
});

test('asset usage, file assignment and kept content read page states and replaced content', () => {
  const project: Project = projectSchema.parse({ schemaVersion: 2, title: 'Book', template: { id: 't', version: '1' },
    texts: { t: 'texts/t.md' }, files: { f: 'files/f.gpx' },
    spreads: [{ id: 's', definition: 'full', ...paged({ photo: 'p', text: 't', file: 'f', replaced: 'r' }) }] });
  const photoIndex = Object.fromEntries(['p', 'r', 'unused'].map((id) => [id, { path: 'photos/' + id + '.jpg' }]));
  const usage = assetUsage({ project, photoIndex }, ['2–3']);
  assert.deepEqual(usage.photo.p, [{ spread: 's', pages: '2–3' }]);
  assert.deepEqual(usage.photo.r, [{ spread: 's', pages: '2–3' }], 'replaced content is still the book\'s');
  assert.deepEqual(usage.text.t, [{ spread: 's', pages: '2–3' }]);
  assert.deepEqual(usage.file.f, [{ spread: 's', pages: '2–3' }]);
  assert.equal(usage.photo.unused, undefined);
  // Without layouts every stored box counts; with them, only what is shown (the spread's own layout here).
  assert.deepEqual(Object.keys(sourceUsage(project, ['2–3']).photo).sort(), ['p', 'r']);
  const layouts: Layouts = { full: { label: 'Full', span: 'spread', parameters: {}, boxes: {}, elements: {} } };
  assert.deepEqual(sourceUsage(project, ['2–3'], layouts), { photo: {}, text: {} });
  assert.deepEqual(keptOutside(project.spreads[0], layouts).map(({ source, location, replaced }) => [source, location, !!replaced]),
    [['p', 'left', false], ['t', 'right', false], ['r', 'spread', true]]);

  assert.equal(fileAssigned(project, 'f'), true);
  clearFileAssignments(project, ['f']);
  assert.equal(fileAssigned(project, 'f'), false);
  const [spread] = project.spreads;
  assert.deepEqual(spread.pages?.left?.params, {});
  assert.deepEqual(spread.pages?.right?.elements.map.params, { tracks: [{ id: 'a' }] });
  assert.deepEqual(spread.displaced?.[0].state.params, {});
});

test('removing sources referenced from pages, replaced content and the cover leaves no reference behind', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'if-page-references-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = join(root, 'Book.imageflow');
  const external = join(root, 'external');
  const cache = join(root, 'cache');
  await Promise.all([mkdir(external), mkdir(cache)]);
  configureSourceStore(join(root, 'source-cache'));
  configureSourceAccess(join(root, 'source-access'));
  await copySample(resolve('sample/starter'), folder);
  for (const name of ['one', 'two', 'cover']) await sharp({ create: { width: 60, height: 40, channels: 3, background: '#336699' } }).png().toFile(join(external, name + '.png'));
  await writeFile(join(external, 'story.md'), '# Story');
  await writeFile(join(external, 'route.gpx'), '<gpx/>');
  let book = await loadProject(folder, cache);
  const photos = await importIntoProject(book, { kind: 'photo' }, ['one.png', 'two.png'].map((name) => join(external, name)));
  const coverPath = join(external, 'cover.png');
  const coverAsset = await importIntoProject(photos.book, { kind: 'photo', mode: 'link' }, [coverPath]);
  const text = await importIntoProject(coverAsset.book, { kind: 'markdown' }, [join(external, 'story.md')]);
  const file = await importIntoProject(text.book, { kind: 'file', accept: ['.gpx'] }, [join(external, 'route.gpx')]);
  const [photo, replaced] = photos.imported;
  const [coverPhoto] = coverAsset.imported;
  const files = structuredClone({ project: file.book.project, photoIndex: file.book.photoIndex });
  Object.assign(files.project.spreads[0], paged({ photo, text: text.imported[0], file: file.imported[0], replaced }));
  files.project.spreads[0].pages!.left!.boxes.hero.crops = { photoPage: { centerX: .4, centerY: .5, zoom: 2 } };
  files.project.spreads[0].pages!.left!.boxes.hero.focus = { centerX: .4, centerY: .5 };
  files.project.cover = { definition: 'wrapPhoto', params: { track: file.imported[0] },
    boxes: { kept: { photo: coverPhoto, params: {}, crops: { wrapPhoto: { centerX: .5, centerY: .5, zoom: 2 } } } }, elements: {} };
  book = await updateProject(file.book, files);
  assert.equal(book.project.schemaVersion, 3);
  assert.equal(book.photoIndex[coverPhoto].linked, true);
  assert.equal(assetUsage(book, []).photo[coverPhoto][0].cover, true);
  assert.equal(assetUsage(book, [], ['hero']).photo[coverPhoto], undefined);
  assert.deepEqual(assetUsage(book, [], ['kept']).photo[coverPhoto], [{ cover: true, spread: coverInstance, pages: 'Cover' }]);
  const keys = ['photo:' + photo, 'photo:' + replaced, 'photo:' + coverPhoto, 'markdown:' + text.imported[0], 'file:' + file.imported[0]];
  const removed = await removeSources(book, keys);
  const [spread] = removed.project.spreads;
  assert.deepEqual(spread.pages?.left, { definition: 'photoPage', params: {}, boxes: { hero: { params: {} } }, elements: {} });
  assert.deepEqual(spread.pages?.right?.boxes.story, { params: {} });
  assert.deepEqual(spread.pages?.right?.elements.map.params, { tracks: [{ id: 'a' }] });
  assert.equal(spread.displaced, undefined, 'replaced content without its source has nothing left to set aside');
  assert.deepEqual(removed.project.cover, { definition: 'wrapPhoto', params: {}, boxes: { kept: { params: {} } }, elements: {} });
  assert.equal(removed.photoIndex[coverPhoto], undefined);
  assert.equal((await stat(coverPath)).isFile(), true);
  const left = JSON.stringify(removed.project);
  for (const id of [photo, replaced, text.imported[0], file.imported[0]]) assert.ok(!left.includes('"' + id + '"'), id + ' is not referenced');
  // The saved book opens again.
  assert.deepEqual((await loadProject(folder, cache)).project, removed.project);
});
