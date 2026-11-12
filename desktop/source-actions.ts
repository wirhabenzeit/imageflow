import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { copyFile, cp, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type { ProjectFiles } from '../src/project';
import { sourceEntries, sourceFolder } from '../src/source-locations';
import type { ImportMode, SourceEntry } from '../src/source-locations';
import { createDocument } from './documents';
import { loadProject, updateProject } from './project';
import type { OpenProject } from './project';
import { CommittedProjectSaveError } from './persistence';
import { captureProjectInputs } from './revisions';
import { digestBytes, SourceStore, within } from './source-store';

const filesOf = (book: OpenProject): ProjectFiles => structuredClone({ project: book.project, photoIndex: book.photoIndex });
function reference(files: ProjectFiles, source: SourceEntry, path: string, linked: boolean) {
  if (source.kind === 'photo') {
    files.photoIndex[source.id].path = path;
    if (linked) files.photoIndex[source.id].linked = true; else delete files.photoIndex[source.id].linked;
  } else files.project[source.kind === 'markdown' ? 'texts' : 'files'][source.id] = linked ? { path, linked: true } : path;
}
async function managedCopy(folder: string, source: SourceEntry, snapshot: string, copied: string[]) {
  const directory = join(folder, sourceFolder(source.kind));
  await mkdir(directory, { recursive: true });
  if (await realpath(directory) !== directory) throw new Error('Asset folder must be inside the book.');
  const name = basename(source.path).replace(/[^\p{L}\p{N} ._-]/gu, '-');
  const relativeFolder = sourceFolder(source.kind) + '/' + source.id + '-' + randomUUID().slice(0, 8);
  await mkdir(join(folder, relativeFolder));
  const path = relativeFolder + '/' + name.replace(/^(?:ph|tx|fl)-[a-f0-9-]{12}-/, '');
  await copyFile(snapshot, join(folder, path), constants.COPYFILE_EXCL);
  copied.push(join(folder, path));
  return path;
}

/** Source identity and book metadata survive changing location. External files are never modified. */
export async function relocateSource(book: OpenProject, key: string, selection?: string, copy = false) {
  const source = sourceEntries(book).find((source) => source.key === key);
  if (!source) throw new Error('This source is no longer registered.');
  const chosen = selection ? { ...source, path: await realpath(selection), linked: true } : source;
  const store = await SourceStore.forBook(book.folder, book.cache);
  const resolved = await store.resolve(book.folder, chosen);
  if (resolved.status.state !== 'available' || !resolved.stored) throw new Error(resolved.status.problem ?? 'The selected source is unavailable.');
  const files = filesOf(book);
  const copied: string[] = [];
  try {
    const linked = !copy && source.linked;
    const path = linked ? chosen.path : await managedCopy(book.folder, chosen, resolved.stored.snapshot, copied);
    reference(files, source, path, linked);
    const next = await updateProject(book, files, true);
    await store.settled();
    return next;
  } catch (error) {
    if (!(error instanceof CommittedProjectSaveError)) await Promise.all(copied.map((path) => rm(path, { force: true })));
    throw error;
  }
}

export async function collectSources(book: OpenProject) {
  const before = await captureProjectInputs(book.folder);
  const store = await SourceStore.forBook(book.folder, book.cache);
  const linked = sourceEntries(book);
  const originals = await Promise.all(linked.map(async (source) => ({ source, resolved: await store.resolve(book.folder, source) })));
  const missing = originals.filter(({ resolved }) => resolved.status.state !== 'available');
  if (missing.length) throw new Error('Cannot include all assets. Locate or restore: ' + missing.map(({ source }) => basename(source.path)).join(', ') + '.');
  const files = filesOf(book);
  const copied: string[] = [];
  try {
    for (const { source, resolved } of originals) if (source.linked) reference(files, source, await managedCopy(book.folder, source, resolved.stored!.snapshot, copied), false);
    const after = await captureProjectInputs(book.folder);
    if (before.revision !== after.revision || before.observation !== after.observation) throw new Error('Sources changed while collecting assets. Please retry.');
    files.project.importMode = 'copy';
    return await updateProject(book, files, true);
  } catch (error) {
    if (!(error instanceof CommittedProjectSaveError)) await Promise.all(copied.map((path) => rm(path, { force: true })));
    throw error;
  }
}

/** Only byte-identical candidates are proposed automatically. Filename alone is never an identity match. */
export async function relinkFolder(book: OpenProject, directory: string) {
  const { readdir } = await import('node:fs/promises');
  const root = await realpath(directory);
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const candidates = entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
  const store = await SourceStore.forBook(book.folder, book.cache);
  let next = book;
  const ambiguous: string[] = [];
  let repaired = 0;
  for (const source of sourceEntries(book)) {
    const state = await store.resolve(book.folder, source);
    if (state.status.state === 'available' || !state.stored?.digest) continue;
    const matches: string[] = [];
    for (const path of candidates) {
      if (basename(path) !== basename(source.path)) continue;
      const actual = await realpath(path);
      if (!within(root, actual) || (await stat(actual)).size > 50 * 1024 * 1024) continue;
      if (digestBytes(await readFile(actual)) === state.stored.digest) matches.push(actual);
    }
    if (matches.length === 1) { next = await relocateSource(next, source.key, matches[0]); repaired++; }
    else if (matches.length > 1) ambiguous.push(source.key);
  }
  return { book: next, repaired, ambiguous };
}

/** Save a consistent copy. Collection is prepared before publishing any destination document. */
export async function saveDocumentCopy(source: OpenProject, destination: string, includeAssets: boolean, importMode?: ImportMode) {
  const before = await captureProjectInputs(source.folder);
  const book = await loadProject(source.folder, source.cache, true);
  const work = await realpath(await mkdtemp(join(source.cache, 'save-copy-')));
  const stage = join(work, 'book');
  try {
    await cp(book.folder, stage, { recursive: true, dereference: true, filter: async (path) => {
      if (basename(path) === '.imageflow') return false;
      const actual = await realpath(path);
      if (actual !== book.folder && !within(book.folder, actual)) throw new Error('The package contains a link outside the book: ' + path);
      return true;
    } });
    const files = filesOf(book);
    const store = await SourceStore.forBook(book.folder, book.cache);
    for (const entry of sourceEntries(book)) {
      const { status, stored } = await store.resolve(book.folder, entry);
      if (includeAssets && status.state !== 'available') throw new Error('Cannot include all assets. Locate or restore ' + basename(entry.path) + '.');
      if (!entry.linked && stored && status.state === 'available') {
        await copyFile(stored.snapshot, join(stage, entry.path));
      } else if (includeAssets && entry.linked && stored) {
        reference(files, entry, await managedCopy(stage, entry, stored.snapshot, []), false);
      }
    }
    if (includeAssets) files.project.importMode = 'copy'; else if (importMode) files.project.importMode = importMode;
    await writeFile(join(stage, 'project.json'), JSON.stringify(files.project, null, 2) + '\n');
    await writeFile(join(stage, 'photos.json'), JSON.stringify(files.photoIndex, null, 2) + '\n');
    const after = await captureProjectInputs(source.folder);
    if (before.revision !== after.revision || before.observation !== after.observation) throw new Error('Sources changed while preparing the saved copy. Retry after the external save finishes.');
    return await createDocument(destination, stage);
  } finally { await rm(work, { recursive: true, force: true }); }
}
