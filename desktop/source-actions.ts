import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { copyFile, cp, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, posix } from 'node:path';
import { storedBoxes } from '../src/project';
import type { ProjectFiles } from '../src/project';
import { clearFileAssignments, fileAssigned } from '../src/asset-usage';
import { sourceEntries, sourceFolder, storedFileName } from '../src/source-locations';
import type { ImportMode, SourceEntry } from '../src/source-locations';
import { createDocument } from './documents';
import { loadProject, updateProject } from './project';
import type { OpenProject } from './project';
import { CommittedProjectSaveError } from './persistence';
import { captureProjectInputs } from './revisions';
import { digestBytes, originalPath, SourceStore, within } from './source-store';
import { approveSource, approvedExtensions, transferSourceAccess, transferBookTrust } from './source-access';

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
  const name = storedFileName(basename(source.path));
  const relativeFolder = sourceFolder(source.kind) + '/' + source.id + '-' + randomUUID().slice(0, 8);
  await mkdir(join(folder, relativeFolder));
  const path = relativeFolder + '/' + name.replace(storedPrefix, '');
  await copyFile(snapshot, join(folder, path), constants.COPYFILE_EXCL);
  copied.push(join(folder, path));
  return path;
}

// Imported copies are stored as "<id>-<name>", or as "<id>-<random>/<name>" when collected into the book.
const storedPrefix = /^(?:ph|tx|fl)-[a-f0-9-]{12}-/;

/**
 * Renames a text or file stored in the book (beta finding F-027): its copy is renamed in place, keeping its ID
 * prefix, folder and extension, and the book refers to the new path. Assignments refer to the ID, so they keep
 * working. Not undoable, like other changes of a source's location; Undo and Revert keep the current paths. A linked
 * original is never renamed, and a photo is named by its title.
 */
export async function renameSource(book: OpenProject, key: string, requested: unknown) {
  const source = sourceEntries(book).find((entry) => entry.key === key);
  if (!source) throw new Error('This asset is no longer in the book.');
  if (source.kind === 'photo') throw new Error('A photo is named by its title. Change the title in the Inspector.');
  if (source.linked) throw new Error('A linked file keeps the name of its original. Copy it into the book to rename it.');
  if (typeof requested !== 'string') throw new Error('Enter a name.');
  const stored = posix.basename(source.path);
  const prefix = stored.match(storedPrefix)?.[0] ?? '';
  const current = stored.slice(prefix.length);
  const extension = extname(current);
  let name = storedFileName(requested.trim()).replace(/^[.\s]+/, '');
  if (extension && extname(name).toLowerCase() !== extension.toLowerCase()) name += extension;
  if (!name || name === extension) throw new Error('Enter a name.');
  if (name.length > 200) throw new Error('Choose a shorter name.');
  if (name === current) return book;
  const relative = posix.join(posix.dirname(source.path), prefix + name);
  // Both names must stay inside the book's own folder for this kind of asset, also when a folder on the way has been
  // replaced by a link: the stored copy resolves there (originalPath), and so does the folder the manifest names.
  const from = await originalPath(book.folder, source);
  const root = await realpath(join(book.folder, sourceFolder(source.kind)));
  const folder = await realpath(join(book.folder, posix.dirname(source.path)));
  if (folder !== dirname(from) || (folder !== root && !within(root, folder))) throw new Error('This asset is not stored in the book’s own folder.');
  const to = join(folder, prefix + name);
  if (!within(root, to)) throw new Error('Choose another name.');
  // An existing name is free only when it is this very file, as a change of case is on a case-insensitive volume;
  // on a case-sensitive one, Notes.md and notes.md are two files.
  const [own, existing] = await Promise.all([stat(from), stat(to).catch(() => undefined)]);
  if (existing && (existing.ino !== own.ino || existing.dev !== own.dev)) throw new Error('Another asset already has this name.');
  await rename(from, to);
  const files = filesOf(book);
  reference(files, source, relative, false);
  try { return await updateProject(book, files, true, { origin: 'app', label: 'Rename asset' }); }
  catch (error) {
    if (!(error instanceof CommittedProjectSaveError)) await rename(to, from).catch(() => {});
    throw error;
  }
}

/** Source identity and book metadata survive changing location. External files are never modified. */
export async function relocateSource(book: OpenProject, key: string, selection?: string, copy = false, accept?: string[]) {
  const source = sourceEntries(book).find((source) => source.key === key);
  if (!source) throw new Error('This source is no longer registered.');
  const chosen = selection ? { ...source, path: await realpath(selection), linked: true } : source;
  if (selection) await approveSource(book.folder, chosen, accept ?? await approvedExtensions(book.folder, key));
  const store = await SourceStore.forBook(book.folder, book.cache);
  const resolved = await store.resolve(book.folder, chosen);
  if (resolved.status.state !== 'available' || !resolved.stored) throw new Error(resolved.status.problem ?? 'The selected source is unavailable.');
  const files = filesOf(book);
  const copied: string[] = [];
  try {
    const linked = !copy && source.linked;
    const path = linked ? chosen.path : await managedCopy(book.folder, chosen, resolved.stored.snapshot, copied);
    reference(files, source, path, linked);
    const next = await updateProject(book, files, true, { origin: 'app', label: 'Locate source' });
    await store.settled();
    return next === book ? await loadProject(book.folder, book.cache, book.readOnly) : next;
  } catch (error) {
    if (!(error instanceof CommittedProjectSaveError)) await Promise.all(copied.map((path) => rm(path, { force: true })));
    throw error;
  }
}

export async function collectSources(book: OpenProject, keys?: readonly string[]) {
  const before = await captureProjectInputs(book.folder);
  const store = await SourceStore.forBook(book.folder, book.cache);
  const linked = sourceEntries(book).filter(({ key }) => !keys || keys.includes(key));
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
    return await updateProject(book, files, true, { origin: 'app', label: 'Collect assets' });
  } catch (error) {
    if (!(error instanceof CommittedProjectSaveError)) await Promise.all(copied.map((path) => rm(path, { force: true })));
    throw error;
  }
}

/** Recover exact registered originals in a selected folder, or byte-identical relocated candidates. */
export async function relinkFolder(book: OpenProject, directory: string, keys?: readonly string[]) {
  const { readdir } = await import('node:fs/promises');
  const root = await realpath(directory);
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const candidates = entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
  const store = await SourceStore.forBook(book.folder, book.cache);
  let next = book;
  const ambiguous: string[] = [];
  let repaired = 0;
  for (const source of sourceEntries(book).filter(({ key }) => !keys || keys.includes(key))) {
    const state = await store.resolve(book.folder, source);
    if (state.status.state === 'available') continue;
    // Explicit folder selection can reapprove the registered original even when its cache was lost.
    // A same-named file elsewhere still requires a known digest; never guess by filename.
    if (state.status.state === 'unapproved' && source.linked && within(root, source.path) && candidates.includes(source.path) &&
        await realpath(source.path).then((actual) => actual === source.path, () => false)) {
      next = await relocateSource(next, source.key, source.path); repaired++;
      continue;
    }
    const digest = state.status.digest ?? state.stored?.digest;
    if (!digest) continue;
    const matches: string[] = [];
    for (const path of candidates) {
      if (basename(path) !== basename(source.path)) continue;
      const actual = await realpath(path);
      if (!within(root, actual) || (await stat(actual)).size > 50 * 1024 * 1024) continue;
      if (digestBytes(await readFile(actual)) === digest) matches.push(actual);
    }
    if (matches.length === 1) { next = await relocateSource(next, source.key, matches[0]); repaired++; }
    else if (matches.length > 1) ambiguous.push(source.key);
  }
  return { book: next, repaired, ambiguous };
}

export const fileIsAssigned = (book: OpenProject, id: string) => fileAssigned(book.project, id);

/** Removes assets from the book. Files still assigned to parameters are cleared from those parameters in the same
 * edit, so one Undo restores the registry entry and every assignment. Copied bytes stay in the book for Undo; a
 * linked original is never touched. */
export async function removeSources(book: OpenProject, keys: readonly string[]) {
  const sources = sourceEntries(book).filter(({ key }) => keys.includes(key));
  if (sources.length !== new Set(keys).size) throw new Error('An asset changed. Select it again.');
  const files = filesOf(book);
  clearFileAssignments(files.project, sources.filter(({ kind }) => kind === 'file').map(({ id }) => id));
  for (const source of sources) {
    if (source.kind === 'photo') delete files.photoIndex[source.id];
    else delete files.project[source.kind === 'markdown' ? 'texts' : 'files'][source.id];
    // Every box the spread stores, on its pages too. A photo's crops and focus go with it; replaced content that
    // held the source has nothing left to set aside, so its entry goes.
    if (source.kind !== 'file') for (const spread of files.project.spreads) {
      for (const { state: box } of storedBoxes(spread)) {
        if (source.kind === 'photo' && box.photo === source.id) { delete box.photo; delete box.crops; delete box.focus; }
        if (source.kind === 'markdown' && box.text === source.id) delete box.text;
      }
      if (spread.displaced) {
        spread.displaced = spread.displaced.filter(({ state }) => state.photo || state.text);
        if (!spread.displaced.length) delete spread.displaced;
      }
    }
  }
  return updateProject(book, files, true, { origin: 'app', label: 'Remove sources' });
}

/** Save a consistent copy. Collection is prepared before publishing any destination document. */
export async function saveDocumentCopy(source: OpenProject, destination: string, includeAssets: boolean, importMode?: ImportMode) {
  const before = await captureProjectInputs(source.folder);
  const book = await loadProject(source.folder, source.cache, true);
  const result = await createDocument(destination, async (stage) => {
    await cp(book.folder, stage, { recursive: true, dereference: true, filter: async (path) => {
      // Installed packages are not part of the book; it uses the saved bundle in template/vendor (ADR 0006).
      // A Git repository, at any depth, can hold deleted captions and metadata, as .imageflow/ can.
      if (basename(path) === '.imageflow' || basename(path) === 'node_modules' || basename(path) === '.git') return false;
      const actual = await realpath(path);
      if (actual !== book.folder && !within(book.folder, actual)) throw new Error('The package contains a link outside the book: ' + path);
      return true;
    } });
    const files = filesOf(book);
    const store = await SourceStore.forBook(book.folder, book.cache);
    for (const entry of sourceEntries(book)) {
      const { status, stored } = await store.resolve(book.folder, entry);
      if (includeAssets && status.state !== 'available') throw new Error('Cannot include all assets. Locate or restore ' + basename(entry.path) + '.');
      if (includeAssets && entry.linked && stored) {
        reference(files, entry, await managedCopy(stage, entry, stored.snapshot, []), false);
      }
    }
    if (includeAssets) files.project.importMode = 'copy'; else if (importMode) files.project.importMode = importMode;
    await writeFile(join(stage, 'project.json'), JSON.stringify(files.project, null, 2) + '\n');
    await writeFile(join(stage, 'photos.json'), JSON.stringify(files.photoIndex, null, 2) + '\n');
    const after = await captureProjectInputs(source.folder);
    if (before.revision !== after.revision || before.observation !== after.observation) throw new Error('Sources changed while preparing the saved copy. Retry after the external save finishes.');
  });
  if (!includeAssets) await transferSourceAccess(book.folder, result, sourceEntries(book));
  // A copy of the user's own book is theirs too (ADR 0006).
  await transferBookTrust(book.folder, result);
  return result;
}

/** Create an ordinary in-book source; the stable source ID is independent of its filename. */
export async function createMarkdownSource(book: OpenProject, title: string) {
  if (book.readOnly) throw new Error('Create an editable book before adding text.');
  const name = title.trim().replace(/\.md$/i, '');
  if (!name || name.length > 100 || /[\/\\\x00-\x1f]/.test(name) || name === '.' || name === '..') throw new Error('Choose a text name of 1–100 characters without slashes.');
  const directory = join(book.folder, 'texts');
  await mkdir(directory, { recursive: true });
  if (await realpath(directory) !== directory) throw new Error('Texts must be a real folder inside the book.');
  const id = 'tx-' + randomUUID().slice(0, 12);
  const path = 'texts/' + id + '-' + name + '.md';
  const files = filesOf(book);
  files.project.texts[id] = path;
  await writeFile(join(book.folder, path), '', { flag: 'wx' });
  try { return { id, book: await updateProject(book, files, true, { origin: 'app', label: 'New text' }) }; }
  catch (error) {
    if (!(error instanceof CommittedProjectSaveError)) await rm(join(book.folder, path), { force: true });
    throw error;
  }
}
