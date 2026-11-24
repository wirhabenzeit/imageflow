import { scopeSpread } from '../src/project';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { access, copyFile, mkdir, readFile, readdir, realpath, rm, rmdir, stat, utimes } from 'node:fs/promises';
import * as ReactExports from 'react';
import { dependencyWarning, isBareImport, missingDependency, readDependencyManifest, vendoredModule } from './dependencies';
import { bundledFontCoverage } from './fonts';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { BuildFailure, Loader } from 'esbuild';
import type { AuthoringDiagnostic } from '../src/authoring';
import { boxBase, parseDocument, photoIndexSchema, projectSchema, unsupportedBookMessage, withBookFormat } from '../src/project';
import type { FixtureMarking, PhotoIndex, Project, ProjectFile, ProjectFiles, RenderProject } from '../src/project';
import { renderOrigin } from '../src/desktop';
import type { ImportCounts, ImportRequest, ProjectSummary } from '../src/desktop';
import { importPhotoDetails, photoDetails, photoExtensions } from './photos';
import { renditionCacheFor } from './rendition-cache';
import { photoDate } from './capture-time';
import type { ProjectPhoto } from './photos';
import { CommittedProjectSaveError, persistProjectManifests, recoverProjectSave } from './persistence';
import type { SaveCheckpoint } from './persistence';
import { fileSourceOf, sourceEntries, sourcePath, sourceLinked, storedFileName } from '../src/source-locations';
import type { PhotoSourceEntry, SourceEntry, SourceStatus } from '../src/source-locations';
import { isFileLocator, locatorKindOf } from '../src/source-locator';
import type { Locator, PhotoLocator } from '../src/source-locator';
import { providerOf } from './providers';
import type { Observed, SourceRef } from './source-provider';
import { refreshProvided } from './provided-photos';
import { materializePhotos, placedPhotos } from './materialized-photos';
import type { MaterializeOptions } from './materialized-photos';
import type { ProvidedOutcome } from './provided-photos';
import { digestBytes, SourceStore } from './source-store';
import type { ResolvedSource, StoredSource } from './source-store';
import { AssetFacts } from './asset-facts';
import { proxyStore } from './proxy-store';
import { keptOriginalProblem, keptOriginals, resumeSyncPull } from './sync-pull';
import { providedFieldNames } from '../src/asset-facts';
import type { AssetFact, ProvidedField, ProvidedMetadata } from '../src/asset-facts';
import { captureFields } from '../src/photo-metadata';
import { approveSources, sourceBookKey } from './source-access';
import { runtimeExports } from '../src/runtime-exports';
import { templateHash } from './template-library';
import { pictureScopes, scopedRuntimePrefix } from './picture-scopes';

export const assetTypes: Record<string, string> = {
  '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf',
};

function isInside(directory: string, path: string) {
  const rel = relative(directory, path);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
}

export async function containedPath(root: string, path: string, folder?: string) {
  const base = folder ? resolve(root, folder) : root;
  const candidate = resolve(root, path);
  if (isAbsolute(path) || !isInside(base, candidate)) {
    throw new Error(path + ' must be inside ' + (folder ?? 'the project folder') + '.');
  }
  let actual: string;
  try {
    actual = await realpath(candidate);
  } catch {
    throw new Error('Missing project file: ' + path);
  }
  if (!isInside(base, actual)) throw new Error(path + ' points outside ' + (folder ?? 'the project folder') + '.');
  return actual;
}

type ManifestName = 'project.json' | 'photos.json';

export async function readProjectManifest(root: string, name: ManifestName) {
  return readFile(await containedPath(root, name));
}

function parseJson(source: Buffer, name: ManifestName) {
  try {
    return JSON.parse(source.toString('utf8')) as unknown;
  } catch {
    throw new Error(name + ' contains invalid JSON.');
  }
}

export function readProjectDocument(root: string, name: 'project.json'): Promise<{ document: Project; source: Buffer }>;
export function readProjectDocument(root: string, name: 'photos.json'): Promise<{ document: PhotoIndex; source: Buffer }>;
export async function readProjectDocument(root: string, name: ManifestName): Promise<{ document: Project | PhotoIndex; source: Buffer }> {
  const source = await readProjectManifest(root, name);
  const value = parseJson(source, name);
  // Refused before validation so the message is only the request to update, not a schema path.
  const unsupported = name === 'project.json' ? unsupportedBookMessage(value) : undefined;
  if (unsupported) throw new Error(unsupported);
  const document = name === 'project.json' ? parseDocument(projectSchema, value, name) : parseDocument(photoIndexSchema, value, name);
  return { document, source };
}

const hostModules = new Map([
  ['imageflow', 'export const { ' + runtimeExports.join(', ') + ' } = globalThis.ImageFlowRuntime;'],
  // All of React's named exports, so bundled dependencies that use hooks share the app's React.
  ['react', 'export default globalThis.ImageFlowReact; export const { ' + Object.keys(ReactExports).filter((name) => /^[A-Za-z_$][\w$]*$/.test(name) && name !== 'default').join(', ') + ' } = globalThis.ImageFlowReact;'],
  ['react/jsx-runtime', 'export const { jsx, jsxs, Fragment } = globalThis.ImageFlowJSX;'],
]);
// `imageflow` as one template file imports it: the same exports, with a RenderedImage that names the file, so the
// picture cache can be scoped to that file and its imports (picture-scopes.ts).
function scopedRuntime(file: string) {
  const others = runtimeExports.filter((name) => name !== 'RenderedImage');
  return 'export const { ' + others.join(', ') + ' } = globalThis.ImageFlowRuntime;\n' +
    'const placed = globalThis.ImageFlowRuntime.RenderedImage;\n' +
    'export const RenderedImage = (props) => globalThis.ImageFlowReact.createElement(placed, { ...props, pictureModule: ' + JSON.stringify(file) + ' });\n';
}

export class TemplateCompileError extends Error {
  constructor(message: string, readonly diagnostics: AuthoringDiagnostic[]) {
    super(message);
    this.name = 'TemplateCompileError';
  }
}

export async function bundleTemplate(folder: string) {
  const entry = await containedPath(folder, 'template/index.tsx', 'template');
  const root = resolve(folder, 'template');
  const loader: Record<string, Loader> = Object.fromEntries(
    Object.keys(assetTypes).filter((ext) => ext !== '.js' && ext !== '.css').map((ext) => [ext, 'file']),
  );
  const manifest = await readDependencyManifest(root).catch((error: Error) => {
    throw new TemplateCompileError(error.message, [{ code: 'template-compile-error', stage: 'template', severity: 'error', message: error.message }]);
  });
  const dependencies = await dependencyWarning(root, manifest);
  try {
    // esbuild reads its executable path when the module is first loaded.
    const { build } = await import('esbuild');
    const { outputFiles, metafile } = await build({
      entryPoints: [entry],
      outfile: resolve(root, 'template.js'),
      assetNames: 'asset-[name]-[hash]',
      metafile: true,
      // Kept beside the bundle so checks can map runtime errors back to template source lines; never linked from it.
      sourcemap: 'external',
      sourcesContent: false,
      absWorkingDir: root,
      bundle: true,
      write: false,
      format: 'esm',
      jsx: 'automatic',
      // The template's tsconfig.json is for code editors; bundling must not depend on it.
      tsconfigRaw: {},
      loader,
      logLevel: 'silent',
      plugins: [{
        name: 'project-template',
        setup(builder) {
          builder.onResolve({ filter: /.*/ }, async (args) => {
            if (args.kind === 'entry-point' || args.pluginData) return;
            if (args.path === 'imageflow' && args.namespace === 'file' && isInside(root, args.importer)) {
              return { path: scopedRuntimePrefix + relative(root, args.importer).split(sep).join('/'), namespace: 'imageflow-host' };
            }
            if (hostModules.has(args.path)) return { path: args.path, namespace: 'imageflow-host' };
            // Packages resolve only through the saved dependency bundle, never through node_modules (ADR 0006).
            if (isBareImport(args.path)) {
              if (vendoredModule(root, manifest, args.path) === undefined) return { errors: [{ text: missingDependency(args.path) }] };
              return { path: args.path, namespace: 'imageflow-vendor' };
            }
            // Inline images in stylesheets, such as icons in vendored CSS, need no file and stay as they are.
            if (args.kind === 'url-token' && args.path.startsWith('data:')) return { path: args.path, external: true };
            if (!args.path.startsWith('./') && !args.path.startsWith('../')) {
              return { errors: [{ text: 'Use a relative template import instead of ' + args.path + '.' }] };
            }
            const result = await builder.resolve(args.path, {
              kind: args.kind, importer: args.importer, resolveDir: args.resolveDir, pluginData: true,
            });
            if (result.errors.length) return { errors: result.errors };
            const path = await realpath(result.path);
            if (!isInside(root, path)) return { errors: [{ text: args.path + ' points outside template/.' }] };
            // A template runs only files its hash covers and its copies carry, so installed packages and dotfiles stay
            // out of reach of relative imports too (ADR 0006).
            const excluded = relative(root, path).split(sep).find((part) => part === 'node_modules' || part.startsWith('.'));
            if (excluded) return { errors: [{ text: args.path + (excluded === 'node_modules'
              ? ' is an installed package file. Import the package by name, which resolves through the saved dependency bundle (the template dependency rebuild script).'
              : ' is inside ' + excluded + ', which templates leave out of their hash and copies. Move it to a folder without a leading dot.') }] };
            return { path };
          });
          builder.onLoad({ filter: /.*/, namespace: 'imageflow-host' }, (args) => ({
            contents: args.path.startsWith(scopedRuntimePrefix) ? scopedRuntime(args.path.slice(scopedRuntimePrefix.length)) : hostModules.get(args.path),
          }));
          builder.onLoad({ filter: /.*/, namespace: 'imageflow-vendor' }, (args) => ({
            contents: vendoredModule(root, manifest, args.path), resolveDir: root, loader: 'js',
          }));
        },
      }],
    });
    const urls: Record<string, string> = Object.fromEntries(Object.entries(metafile.outputs)
      .filter(([, output]) => Object.keys(output.inputs).length === 1)
      .map(([out, output]) => [Object.keys(output.inputs)[0], basename(out)])
      .filter(([input, out]) => input.startsWith('assets/') && out.startsWith('asset-')));
    const files = new Map(outputFiles.map((file) => [basename(file.path), file.contents]));
    const assetEntries = await readdir(join(root, 'assets'), { recursive: true, withFileTypes: true }).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
      return [];
    });
    for (const entry of assetEntries) {
      if (!entry.isFile() || !assetTypes[extname(entry.name).toLowerCase()]) continue;
      const path = relative(root, join(entry.parentPath, entry.name));
      if (urls[path]) continue;
      const source = await containedPath(root, path, 'assets');
      const name = 'asset-extra-' + Object.keys(urls).length + extname(source);
      files.set(name, await readFile(source));
      urls[path] = name;
    }
    const scopes = await pictureScopes(metafile, async (input) => input.startsWith('imageflow-vendor:')
      ? vendoredModule(root, manifest, input.slice('imageflow-vendor:'.length)) : readFile(resolve(root, input)).catch(() => undefined));
    return { files, urls, pictureScopes: scopes, ...(dependencies ? { warnings: [dependencies] } : {}) };
  } catch (error) {
    const message = 'Template could not be bundled. ' + (error instanceof Error ? error.message : String(error));
    const errors = (error as Partial<BuildFailure> | null)?.errors;
    // An import of a helper this app's `imageflow` module lacks usually means the template needs a newer app.
    const missingHelper = (text: string) => /No matching export in "imageflow-host:imageflow(?:\?[^"]*)?" for import "([^"]+)"/.exec(text)?.[1];
    const diagnostics: AuthoringDiagnostic[] = Array.isArray(errors) ? errors.slice(0, 50).map(({ text, location }) => ({
      code: 'template-compile-error', stage: 'template', severity: 'error', message: text,
      ...(missingHelper(text) ? { suggestion: 'This version of ImageFlow does not provide ' + missingHelper(text) + '. Update ImageFlow, ' +
        'or use only the exports it lists: ' + runtimeExports.join(', ') + '.' } : {}),
      ...(location ? { location: {
        path: relative(folder, resolve(root, location.file)), line: location.line, column: location.column + 1,
      } } : {}),
    })) : [{ code: 'template-compile-error', stage: 'template', severity: 'error', message }];
    throw new TemplateCompileError(message, diagnostics);
  }
}

type TemplateAssets = Awaited<ReturnType<typeof bundleTemplate>>;
export type OpenProject = ProjectFiles & {
  folder: string; viewKey?: string; cache: string; assets: TemplateAssets; photos: Map<string, ProjectPhoto>;
  texts: Record<string, string>; files: Record<string, ProjectFile>; problems: string[]; readOnly: boolean;
  sources?: Record<string, SourceStatus>;
  // Derived facts (assets-meta.json) of photos whose original is missing and that nothing else stands in for: their size
  // and capture time still lay out the book, while the source stays missing (ADR 0005, ADR 0010).
  unavailablePhotos?: Record<string, AssetFact>;
  manifests: Record<ManifestName, Buffer>;
  // Set only on synthetic fixture books rendered by authoring checks.
  fixture?: FixtureMarking;
  // The hash of the template files as loaded (see templateHash); network approvals hold for this hash only (ADR 0006).
  templateHash?: string;
  // Set only by an export load: the photos without a file it prints from their full-resolution originals, with the
  // provider revision each original was made from, so the export can tell them from what the open book has seen.
  materialized?: Record<string, string>;
};

// Files for file parameters are read whole into the render data, so preview and export use the same input.
export const maximumFileSize = 20 * 1024 * 1024;
const fileName = (path: string) => basename(path).replace(/^fl-[0-9a-f-]{12}-/, '');

/**
 * Loads a book. `pinSources` is an export's load: every photo is read from a private copy in `fallback`'s
 * `pinned-sources`, and the placed photos without a file are materialized first (`options` reports progress and
 * cancels that; a cancelled load still returns, drawing those photos from their previews).
 */
export async function loadProject(path: string, fallback: string, readOnly = false, pinSources = false, options: MaterializeOptions = {}): Promise<OpenProject> {
  const folder = await realpath(path);
  await recoverProjectSave(folder, { readOnly });
  // A sync pull interrupted after it began changing the book is finished from what it staged (ADR 0010).
  await resumeSyncPull(folder, { readOnly });
  const [{ document: project, source: projectFile }, { document: photoIndex, source: photoFile }] = await Promise.all([
    readProjectDocument(folder, 'project.json'), readProjectDocument(folder, 'photos.json'),
  ]);
  // Hashed before bundling: if the template changes in between, the watcher loads the book again.
  const hash = await templateHash(join(folder, 'template')).catch(() => undefined);
  const assets = await bundleTemplate(folder);
  const cache = fallback;
  return readContent({ folder, viewKey: createHash('sha256').update(await sourceBookKey(folder)).digest('hex'), assets, cache, readOnly, project: withBookFormat(project, photoIndex), photoIndex, ...(hash ? { templateHash: hash } : {}), manifests: { 'project.json': projectFile, 'photos.json': photoFile } }, pinSources, options);
}

async function readContent(book: Omit<OpenProject, 'photos' | 'texts' | 'files' | 'problems'>, pinSources = false, options: MaterializeOptions = {}): Promise<OpenProject> {
  const photos = new Map<string, ProjectPhoto>();
  const texts: Record<string, string> = {};
  const files: Record<string, ProjectFile> = {};
  const sources: Record<string, SourceStatus> = {};
  const problems: string[] = [];
  const entries = sourceEntries(book);
  // Only a writable, unpinned load keeps derived facts up to date, and only that one registers them for the session
  // that owns the book; read-only, pinned and temporary loads just read the file.
  const writable = !book.readOnly && !pinSources;
  const facts = writable ? await AssetFacts.forBook(book.folder) : await AssetFacts.readOnly(book.folder);
  if (!entries.length) {
    // The last source was removed: its facts go too.
    if (writable) facts.prune([]);
    return { ...book, photos, texts, files, sources, problems };
  }
  const store = await SourceStore.forBook(book.folder, book.cache);
  // Derived facts follow photos the editor reads in place; a private export read changes nothing.
  if (writable) store.onDigest = (key, observation, digest) => { if (key.startsWith('photo:')) facts.digest(key.slice('photo:'.length), observation, digest); };
  const unavailablePhotos: Record<string, AssetFact> = {};
  // Older originals a sync pull kept until the remote has their new versions: drawn from the new preview (see below).
  const kept = await keptOriginals(book.folder);
  // Each provider is asked about all its photos at once (ADR 0011), and photos it reports facts for get their facts
  // and previews brought up to date before they load.
  const observed = await observePhotos(book.folder, entries, store, facts);
  const provided = await refreshPhotos(book, observed, facts, writable ? 'background' : 'held');
  // An export prints the placed photos without a file from their full-resolution originals, where their provider can
  // produce them now; the others stay drawn from their previews, as proofs.
  const originals = pinSources ? await pinnedOriginals(book, entries, provided, store, options) : new Map<string, PinnedOriginal>();
  for (let i = 0; i < entries.length; i += 8) {
    await Promise.all(entries.slice(i, i + 8).map(async (source) => {
      if (source.kind === 'photo' && provided.has(source.id)) {
        const { status, loaded } = await loadProvidedPhoto(book, source, provided.get(source.id)!, store, pinSources, originals.get(source.id));
        sources[source.key] = status;
        if (status.problem && !status.pending) problems.push('photo ' + source.id + ' · ' + status.problem);
        if (loaded?.photo) photos.set(source.id, loaded.photo);
        if (loaded?.fact) unavailablePhotos[source.id] = loaded.fact;
        return;
      }
      const { status, stored } = await store.resolve(book.folder, source, { pin: pinSources, cache: book.cache, observed: source.kind === 'photo' ? observed.get(source.id)?.observed : undefined });
      sources[source.key] = status;
      if (status.problem && source.kind !== 'file') problems.push(source.kind + ' ' + source.id + ' · ' + status.problem);
      // An older original a pull kept (#295, #283): the book state, crop and size are the new version's, so the photo is
      // drawn from the new version's preview and marked as still uploading from another Mac, in the editor, an export and
      // print alike, until the new file replaces the kept one. Its fact stays the new version's. A file changed here
      // since (another digest) is this Mac's own and loads as any file.
      const older = source.kind === 'photo' ? kept.get(source.id) : undefined;
      if (older && status.state === 'available' && (status.digest ?? stored?.digest ?? older.kept) === older.kept) {
        const fact = facts.get(source.id);
        const photo = fact?.digest === older.current ? await proxyPhoto(book, source.id, fact, keptOriginalProblem) : undefined;
        // Nothing to locate: the file is here, at its older version. Replace stays, and what the user chooses then is this
        // Mac's own change; Remove, Copy into Book and Locate Folder leave the kept file where it is.
        sources[source.key] = { ...status, state: 'missing', problem: keptOriginalProblem, repairs: [], ...(photo ? { cached: true } : {}) };
        problems.push('photo ' + source.id + ' · ' + keptOriginalProblem);
        if (photo) photos.set(source.id, photo);
        else if (fact) unavailablePhotos[source.id] = fact;
        return;
      }
      if (source.kind === 'photo') {
        const loaded = await loadPhoto(book, source, { status, stored }, facts, writable);
        if (loaded?.photo) photos.set(source.id, loaded.photo);
        // Shown like a cached preview: the source keeps its honest state, and print marks and blocks it.
        if (loaded?.standIn) sources[source.key] = { ...status, cached: true };
        if (loaded?.fact) unavailablePhotos[source.id] = loaded.fact;
      } else if (source.kind === 'markdown') {
        if (stored) texts[source.id] = await readFile(stored.snapshot, 'utf8');
      } else {
        files[source.id] = { name: fileName(source.path), extension: extname(source.path).toLowerCase(),
          ...(stored ? { text: await readFile(stored.snapshot, 'utf8') } : {}), ...(status.problem ? { problem: status.problem } : {}) };
      }
    }));
  }
  await store.settled();
  if (writable) facts.prune(Object.keys(book.photoIndex));
  return { ...book, photos, texts, files, sources, problems: problems.sort(), ...(Object.keys(unavailablePhotos).length ? { unavailablePhotos } : {}),
    ...(originals.size ? { materialized: Object.fromEntries([...originals].map(([id, { revision }]) => [id, revision])) } : {}) };
}

type ObservedPhoto = { ref: SourceRef<Locator>; observed: Observed };
/**
 * The state of every photo of a book, from one `observe` per provider (ADR 0011). Each photo is handed in with the
 * revisions last stored for it: a file's last read stamp, or the revisions recorded with the fact of a photo that is not
 * a file. A provider that fails as a whole leaves its photos unreadable.
 */
export async function observePhotos(folder: string, entries: readonly SourceEntry[], store: Pick<SourceStore, 'observed'>, facts: Pick<AssetFacts, 'get'>): Promise<Map<string, ObservedPhoto>> {
  const photos = entries.filter((entry): entry is PhotoSourceEntry => entry.kind === 'photo');
  const result = new Map<string, ObservedPhoto>();
  await Promise.all([...new Set(photos.map(({ locator }) => locator.provider))].map(async (name) => {
    const refs = photos.filter(({ locator }) => locator.provider === name).map((entry): SourceRef<Locator> => {
      const stamp = isFileLocator(entry.locator) ? store.observed(entry.key) : undefined;
      const known = stamp ? { revision: stamp } : facts.get(entry.id)?.revisions;
      return { id: entry.id, locator: entry.locator, ...(known ? { known: { ...known } } : {}) };
    });
    let answers: Observed[];
    try {
      answers = await providerOf(refs[0].locator).observe(folder, refs);
      if (answers.length !== refs.length) throw new Error('The source answered for ' + answers.length + ' of ' + refs.length + ' photos.');
    } catch (error) {
      const problem = 'Original unavailable: ' + (error instanceof Error ? error.message : String(error));
      answers = refs.map(() => ({ state: 'unreadable', problem }));
    }
    refs.forEach((ref, index) => result.set(ref.id, { ref, observed: answers[index] }));
  }));
  return result;
}

/**
 * Brings the facts of the photos whose provider reported facts up to date, one provider at a time, and their previews:
 * an open book's session fetches those after the load (`backgroundPreviews`), any other load waits for them.
 */
async function refreshPhotos(book: Pick<OpenProject, 'folder' | 'cache'>, observed: Map<string, ObservedPhoto>, facts: AssetFacts, previews: 'background' | 'held') {
  const reported = [...observed.values()].filter(({ observed }) => observed.state === 'available' && observed.facts);
  const outcomes = new Map<string, ProvidedOutcome>();
  for (const name of new Set(reported.map(({ ref }) => ref.locator.provider))) {
    const group = reported.filter(({ ref }) => ref.locator.provider === name);
    const results = await refreshProvided(book.folder, providerOf(group[0].ref.locator), group.map(({ ref }) => ref), group.map(({ observed }) => observed), facts,
      { staging: join(book.cache, 'provider-staging'), previews });
    for (const [id, outcome] of results) outcomes.set(id, outcome);
  }
  return outcomes;
}

type PinnedOriginal = { pinned: string; stored: StoredSource; revision: string };
/**
 * The full-resolution originals of the placed photos without a file, materialized into the source cache (or found there
 * for the revision just observed) and pinned into the export job. A photo its provider cannot produce now is left out:
 * it is printed from its preview, as a proof.
 */
async function pinnedOriginals(book: Pick<OpenProject, 'folder' | 'cache' | 'project' | 'photoIndex'>, entries: readonly SourceEntry[],
  provided: Map<string, ProvidedOutcome>, store: SourceStore, options: MaterializeOptions) {
  const placed = placedPhotos(book);
  const requests = entries.flatMap((entry) => {
    const outcome = entry.kind === 'photo' && placed.has(entry.id) ? provided.get(entry.id) : undefined;
    return entry.kind === 'photo' && outcome?.state === 'available' && outcome.fact.revisions ? [{ source: entry, revisions: outcome.fact.revisions }] : [];
  });
  const originals = new Map<string, PinnedOriginal>();
  if (!requests.length) return originals;
  for (const [id, result] of await materializePhotos(book.folder, store, requests, options)) {
    if (result.state !== 'available' || options.signal?.aborted) continue;
    try { originals.set(id, { pinned: await store.pinMaterialized(result.stored, book.cache), stored: result.stored, revision: result.revision }); }
    catch { /* Not pinned: printed from its preview. */ }
  }
  return originals;
}

/** A photo's title, caption, credit and alt text: the book's override where photos.json has the key, else its provider's. */
export function photoMetadata(entry: PhotoIndex[string], provided?: ProvidedMetadata) {
  return Object.fromEntries(providedFieldNames.flatMap((field) => {
    const value = Object.hasOwn(entry, field) ? entry[field] : provided?.[field];
    return value === undefined ? [] : [[field, value]];
  })) as Pick<ProjectPhoto, ProvidedField>;
}

/**
 * A photo without a file, from what its provider reported: laid out from its fact and drawn from its preview in the
 * proxy store. Available, it has no problem; one drawn from before its latest edit is marked out of date. A photo whose preview could not be stored keeps its state and stands in
 * from what was stored before.
 * An export (`pinned`) prints a photo whose full-resolution original was pinned (`original`) from it, and any other
 * only as a proof (`previewOnly`). The editor marks none of them: an export materializes what its provider can produce.
 */
async function loadProvidedPhoto(book: Pick<OpenProject, 'folder' | 'photoIndex' | 'cache'>, source: PhotoSourceEntry, outcome: ProvidedOutcome, store: SourceStore,
  pinned: boolean, original?: PinnedOriginal): Promise<{ status: SourceStatus; loaded?: { photo?: ProjectPhoto; fact?: AssetFact } }> {
  if (original && outcome.state === 'available') {
    const photo = await originalPhoto(book, source.id, outcome.fact, original).catch(() => undefined);
    if (photo) return { status: { ...source, state: 'available', digest: outcome.fact.digest }, loaded: { photo } };
  }
  // The status of a photo that cannot be shown as reported, with the repairs its provider offers.
  const failed = async (failure: { state: Exclude<SourceStatus['state'], 'available'>; problem: string }) =>
    (await store.resolve(book.folder, source, { observed: failure })).status;
  // Its preview is being fetched: laid out by what its provider reported, and drawn once the preview comes.
  if (outcome.state === 'pending') return { status: { ...source, state: 'unreadable', pending: true, problem: 'The preview is still loading.', repairs: [] }, loaded: { fact: outcome.fact } };
  if (outcome.state !== 'available' && !('fact' in outcome)) return { status: await failed(outcome) };
  const fact = outcome.fact;
  const status: SourceStatus = outcome.state === 'available' ? { ...source, state: 'available', ...(pinned ? { previewOnly: true } : outcome.outOfDate ? { outOfDate: true } : {}), digest: outcome.fact.digest } : await failed(outcome);
  if (!fact) return { status };
  const photo = await proxyPhoto(book, source.id, fact, outcome.state === 'available' ? undefined : outcome.problem);
  if (!photo) return { status, loaded: { fact } };
  return { status: outcome.state === 'available' ? status : { ...status, cached: true }, loaded: { photo } };
}

/**
 * A photo drawn from its pinned full-resolution original. Its size is the original's own, so the layout matches the
 * pixels printed; its titles and capture data are what the provider reported, which a render need not carry.
 */
async function originalPhoto(book: Pick<OpenProject, 'photoIndex' | 'cache'>, id: string, fact: AssetFact, { pinned, stored }: PinnedOriginal): Promise<ProjectPhoto> {
  const { captured: _captured, location: _location, camera: _camera, ...details } = await photoDetails(pinned, null);
  const capture = Object.fromEntries(captureFields.flatMap((field) => fact[field] ? [[field, fact[field]]] : []));
  return { ...photoMetadata(book.photoIndex[id], fact.provided), ...details, ...capture, estimatedCapture: undefined,
    ...(fact.provided ? { provided: fact.provided } : {}),
    width: stored.width ?? details.width, height: stored.height ?? details.height, original: pinned,
    key: digestBytes(Buffer.from(stored.digest + ':rendition-3')), cache: renditionCacheFor(book.cache) };
}

/** A photo drawn from its proxy, with the size and capture data of its fact, and the problem it is shown with. */
async function proxyPhoto(book: Pick<OpenProject, 'photoIndex' | 'cache'>, id: string, fact: AssetFact, problem: string | undefined): Promise<ProjectPhoto | undefined> {
  const proxy = await (await proxyStore())?.path(fact.digest);
  const details = proxy ? await photoDetails(proxy, null).catch(() => undefined) : undefined;
  if (!proxy || !details) return undefined;
  // The proxy's own size and capture data never reach layout: the original's do, from assets-meta.json, so
  // aspect ratios, crop limits and resolution checks match the real photo.
  const { captured: _captured, location: _location, camera: _camera, ...rendition } = details;
  const capture = Object.fromEntries(captureFields.flatMap((field) => fact[field] ? [[field, fact[field]]] : []));
  // A proxy is never changed in place: `put` replaces it by a rename, which gives it another inode. So it carries no
  // observation (looking a proxy up touches its times for LRU pruning, which must not count as a change), and its
  // renditions are keyed by inode and size only, so they survive reopening.
  const identity = details.observation.split(':').slice(0, 2).join(':');
  return { ...photoMetadata(book.photoIndex[id], fact.provided), ...rendition, ...capture, estimatedCapture: undefined, observation: undefined,
    ...(fact.provided ? { provided: fact.provided } : {}),
    width: fact.width, height: fact.height, original: proxy, key: digestBytes(Buffer.from(fact.digest + ':proxy-v1:' + identity)),
    cache: renditionCacheFor(book.cache), ...(problem ? { problem } : {}) };
}

/**
 * A photo as the book renders it. Its pixels are always a file on this Mac, whatever the photo's provider (ADR 0011):
 * - the original, read where it is, or a private copy of it (an export);
 * - what was last read of an original that cannot be read now;
 * - a proxy from the proxy store, with the original's size and capture data from `assets-meta.json`, for an original
 *   that is not here, or whose provider is not reachable now.
 * Without any of them, only the fact is returned, so the book still lays out. A photo whose provider reports facts is
 * loaded by `loadProvidedPhoto` instead.
 */
async function loadPhoto(book: Pick<OpenProject, 'photoIndex' | 'cache'>, source: SourceEntry, { status, stored }: ResolvedSource, facts: AssetFacts, writable: boolean):
  Promise<{ photo?: ProjectPhoto; standIn?: true; fact?: AssetFact } | undefined> {
  // Only the editable metadata reaches templates; unknown keys of the entry stay in photos.json (ADR 0010).
  const entry = book.photoIndex[source.id];
  const cache = renditionCacheFor(book.cache);
  if (stored) {
    const details = await photoDetails(stored.snapshot, null);
    // Without an EXIF capture time, photo views use the original's modification time, not the snapshot's.
    const present = status.state === 'available' && !status.problem;
    const remembered = present ? undefined : facts.get(source.id);
    // A rendition has no EXIF block, so a missing original's capture data comes from assets-meta.json.
    const capture = remembered ? Object.fromEntries(captureFields.flatMap((field) => remembered[field] ? [[field, remembered[field]]] : [])) : {};
    const estimate = details.captured || remembered?.captured ? undefined : stored.modified ?? details.estimatedCapture;
    if (present && writable) facts.note(source.id, stored.observation, details, status.digest ?? stored.digest);
    return { photo: { ...photoMetadata(entry), ...details, ...capture, estimatedCapture: estimate, observation: stored.direct && status.state === 'available' ? stored.observation : details.observation,
      width: stored.width!, height: stored.height!, original: stored.snapshot,
      key: stored.direct ? status.problem ? digestBytes(Buffer.from(stored.key + ':stale')) : stored.key! : digestBytes(Buffer.from(stored.digest + ':rendition-3')),
      cache, ...(status.problem ? { problem: status.problem } : {}) } };
  }
  const fact = facts.get(source.id);
  if (!fact) return undefined;
  // A sync proxy stored by digest stands in on the canvas for an original that is missing here (a linked photo not
  // yet located, an owned photo not yet downloaded), not approved on this Mac, or whose provider is not reachable. It
  // is read from the proxy store only, never from the original's path, so an unapproved location stays unread (ADR
  // 0005, ADR 0010, ADR 0011).
  if (!standInStates.has(status.state)) return { fact };
  const photo = await proxyPhoto(book, source.id, fact, status.problem ?? 'Original unavailable');
  return photo ? { standIn: true, photo } : { fact };
}
const standInStates = new Set<SourceStatus['state']>(['missing', 'unapproved', 'offline', 'needs-sign-in']);

function projectJson(value: unknown) {
  return JSON.stringify(value, null, 2) + '\n';
}

export async function updateProject(book: OpenProject, files: ProjectFiles, reloadContent = false,
  checkpoint: SaveCheckpoint = { origin: 'app', label: 'Project edit' }) {
  if (book.readOnly) throw new Error('Use New Project to make an editable copy of the sample.');
  // `bookId` is the book's lineage (ADR 0010): an ordinary save, an undo or a redo never changes it, even when the files
  // handed in come from an older snapshot or a caller that does not know the field.
  const photoIndex = parseDocument(photoIndexSchema, files.photoIndex, 'photos.json');
  // The format follows the photo index too: a book that holds a photo without a file is written as format 4.
  let project = withBookFormat(parseDocument(projectSchema, { ...files.project, ...(book.project.bookId ? { bookId: book.project.bookId } : {}) }, 'project.json'), photoIndex);
  const unchanged = projectJson(book.project) === projectJson(project);
  // A legacy book gets its `bookId` with the first save that writes something, so it adds no undo step of its own and
  // no write when nothing changed.
  // Parsed again, so the field takes its place in the schema's key order like one read from disk.
  if (!project.bookId && !unchanged) project = withBookFormat(parseDocument(projectSchema, { ...project, bookId: randomUUID() }, 'project.json'), photoIndex);
  const projectSource = projectJson(project);
  const indexSource = projectJson(photoIndex);
  const projectChanged = !unchanged || project.bookId !== book.project.bookId;
  const indexChanged = projectJson(book.photoIndex) !== indexSource;
  if (!projectChanged && !indexChanged) return book;
  const [projectFile, photoFile] = await Promise.all([readProjectManifest(book.folder, 'project.json'), readProjectManifest(book.folder, 'photos.json')]);
  const currentIndex = parseDocument(photoIndexSchema, parseJson(photoFile, 'photos.json'), 'photos.json');
  const currentProject = withBookFormat(parseDocument(projectSchema, parseJson(projectFile, 'project.json'), 'project.json'), currentIndex);
  if (projectJson(currentProject) !== projectJson(book.project) || projectJson(currentIndex) !== projectJson(book.photoIndex)) {
    throw new Error('The project changed on disk. Reload before making more edits.');
  }
  const manifests = {
    'project.json': projectChanged ? Buffer.from(projectSource) : projectFile,
    'photos.json': indexChanged ? Buffer.from(indexSource) : photoFile,
  };
  await persistProjectManifests(book.folder, { 'project.json': projectFile, 'photos.json': photoFile }, manifests, checkpoint);
  if (reloadContent) {
    try { return await readContent({ ...book, project, photoIndex, manifests }); }
    catch (error) {
      throw new CommittedProjectSaveError('The project was saved, but its content could not be reloaded. Reload the project before making more edits.', { cause: error });
    }
  }
  return { ...withProjectFiles(book, { project, photoIndex }), manifests };
}

/** The open book with other project/index data, without touching disk. Commands only reference registered sources,
 * so loaded photo, text and file contents stay valid; photo metadata follows the new index. */
export function withProjectFiles(book: OpenProject, files: ProjectFiles): OpenProject {
  const photoIndex = parseDocument(photoIndexSchema, files.photoIndex, 'photos.json');
  const project = withBookFormat(parseDocument(projectSchema, files.project, 'project.json'), photoIndex);
  const photos = new Map([...book.photos].flatMap(([id, photo]) => {
    if (!photoIndex[id]) return [];
    const { title: _title, caption: _caption, credit: _credit, altText: _altText, ...rest } = photo;
    return [[id, { ...rest, ...photoMetadata(photoIndex[id], photo.provided) }] as const];
  }));
  return { ...book, project, photoIndex, photos };
}

/** Progress of an import: files checked so far out of all those chosen, then `saving` while the book is updated. */
export type ImportProgress = { done: number; total: number; saving?: boolean };
// Checking a photo decodes it, which dominates a large import; a few at a time keep the cores busy without
// holding many full-size images in memory (the same batch size as loading a book's sources).
const importConcurrency = 8;

export async function importIntoProject(book: OpenProject, request: ImportRequest, paths: string[], progress?: (value: ImportProgress) => void,
  checkpoint: SaveCheckpoint = { origin: 'app', label: 'Import sources' }) {
  const project = structuredClone(book.project);
  const photoIndex: PhotoIndex = structuredClone(book.photoIndex);
  const mode = request.mode ?? book.project.importMode ?? 'copy';
  if (mode !== 'copy' && mode !== 'link') throw new Error('Unknown import mode.');
  const imported: string[] = [];
  const copied: string[] = [];
  const counts: ImportCounts = { photos: 0, texts: 0, files: 0, skipped: 0, failed: 0 };
  const createdDirectories: string[] = [];
  const prepare = async (folder: string) => {
    const destination = join(book.folder, folder);
    try { await mkdir(destination); createdDirectories.push(destination); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    if (await realpath(destination) !== destination) throw new Error(folder + '/ must be a folder inside the project.');
  };
  // First check every file, several at a time, without changing anything; then add them in the chosen order.
  type Checked = { file: string; kind: 'photo' | 'markdown' | 'file'; info: import('node:fs').Stats } | 'skipped' | 'failed';
  const checked: Checked[] = new Array(paths.length);
  let done = 0;
  let next = 0;
  progress?.({ done, total: paths.length });
  const check = async (file: string): Promise<Checked> => {
    const info = await stat(file).catch(() => undefined);
    if (!info) return 'failed';
    const extension = extname(file).toLowerCase();
    // Without a kind, photos and Markdown are recognised by type. Other files are imported only when a file
    // parameter of the template accepts their extension; nothing else is guessed.
    const kind = request.kind ?? (photoExtensions.has(extension) ? 'photo' : extension === '.md' ? 'markdown' : request.accept?.includes(extension) ? 'file' : undefined);
    const extensions = kind === 'photo' ? photoExtensions : kind === 'file' ? new Set(request.accept) : new Set(['.md']);
    if (!info.isFile() || !kind || !extensions.has(extension)) return 'skipped';
    try {
      if (kind === 'photo') await importPhotoDetails(file);
      if (kind === 'markdown' && info.size > 5 * 1024 * 1024) throw new Error('Markdown files must be smaller than 5 MB.');
      if (kind === 'file' && info.size > maximumFileSize) throw new Error(basename(file) + ' is larger than 20 MB.');
      await access(file, constants.R_OK);
    } catch { return 'failed'; }
    return { file, kind, info };
  };
  await Promise.all(Array.from({ length: Math.min(importConcurrency, paths.length) }, async () => {
    while (next < paths.length) {
      const index = next++;
      checked[index] = await check(paths[index]);
      progress?.({ done: ++done, total: paths.length });
    }
  }));
  const approvals: { key: string; kind: 'photo' | 'markdown' | 'file'; path: string; linked: true }[] = [];
  // What the book holds already (F-044): a file it links, or whose copy it stores, by path, or with the same bytes
  // elsewhere, is reported as already in the book rather than added again. Under the book's import policy that holds
  // whether the source is linked or copied; a copy or link asked for explicitly may add the other kind of source.
  type Held = { kind: 'photo' | 'markdown' | 'file'; id: string; path: string; linked: boolean };
  const held: Held[] = [
    // Only a photo that is a file can be held by path or bytes; one from another provider is imported through it.
    ...sourceEntries({ project, photoIndex }).filter(({ kind }) => kind === 'photo').flatMap((entry) => {
      const file = fileSourceOf(entry);
      return file ? [{ kind: 'photo' as const, id: entry.id, linked: file.linked, path: file.linked ? file.path : join(book.folder, file.path) }] : [];
    }),
    ...Object.entries(project.texts).map(([id, ref]) => ({ kind: 'markdown' as const, id, linked: sourceLinked(ref), path: sourceLinked(ref) ? sourcePath(ref) : join(book.folder, sourcePath(ref)) })),
    ...Object.entries(project.files).map(([id, ref]) => ({ kind: 'file' as const, id, linked: sourceLinked(ref), path: sourceLinked(ref) ? sourcePath(ref) : join(book.folder, sourcePath(ref)) })),
  ];
  const sizes = new Map<string, Promise<number | undefined>>();
  const digests = new Map<string, Promise<string | undefined>>();
  const sizeOf = (path: string) => sizes.get(path) ?? sizes.set(path, stat(path).then((info) => info.isFile() ? info.size : undefined, () => undefined)).get(path)!;
  const digestOf = (path: string) => digests.get(path) ?? digests.set(path, readFile(path).then(digestBytes, () => undefined)).get(path)!;
  async function alreadyHeld(kind: Held['kind'], file: string, original: string, size: number) {
    const same = held.filter((entry) => entry.kind === kind && (!request.mode || entry.linked === (mode === 'link') || isInside(book.folder, file)));
    const byPath = same.find(({ path }) => path === file || path === original);
    if (byPath) return byPath.id;
    for (const entry of same) {
      if (await sizeOf(entry.path) !== size) continue;
      const digest = await digestOf(original);
      if (digest && await digestOf(entry.path) === digest) return entry.id;
    }
  }
  try {
    for (const entry of checked) {
      if (entry === 'skipped' || entry === 'failed') { counts[entry]++; continue; }
      const { file, kind, info } = entry;
      const folder = kind === 'photo' ? 'photos' : kind === 'file' ? 'files' : 'texts';
      const registry = kind === 'file' ? project.files : project.texts;
      const previous = await alreadyHeld(kind, file, await realpath(file), info.size);
      if (previous) {
        counts.existing = (counts.existing ?? 0) + 1;
        // One ID per file, in order: an agent's import maps them to the paths it asked for.
        imported.push(previous);
        continue;
      }
      const id = newSourceId(kind);
      const name = storedFileName(basename(file));
      const relativePath = folder + '/' + id + '-' + name;
      const path = join(book.folder, relativePath);
      const original = await realpath(file);
      const linked = mode === 'link' && !isInside(book.folder, original);
      if (linked) approvals.push({ key: kind + ':' + id, kind, path: original, linked });
      if (!linked) { await prepare(folder); await copyFile(original, path, constants.COPYFILE_EXCL); copied.push(path);
        // Keep the original's modification time: photo views estimate an undated photo's capture time from it.
        await utimes(path, info.atime, info.mtime).catch(() => {}); }
      if (kind === 'photo') photoIndex[id] = { path: linked ? original : relativePath, ...(linked ? { linked: true } : {}), title: basename(file, extname(file)) };
      else registry[id] = linked ? { path: original, linked: true } : relativePath;
      if (kind === 'photo') counts.photos++; else if (kind === 'markdown') counts.texts++; else counts.files++;
      imported.push(id);
      held.push({ kind, id, linked, path: linked ? original : path });
    }
    // Links are approved before the book refers to them, all in one write.
    await approveSources(book.folder, approvals, request.accept);
    const next = await finishImport(book, { project, photoIndex }, { imported, counts }, request, progress, checkpoint);
    return { book: next, imported, copied, createdDirectories, counts };
  } catch (error) {
    // A durable save intent may already refer to these assets, including when it needs recovery on next open.
    if (!(error instanceof CommittedProjectSaveError)) {
      await Promise.all(copied.map((path) => rm(path, { force: true })));
      for (const folder of [...createdDirectories].reverse()) await rmdir(folder).catch(() => {});
    }
    throw error;
  }
}

/** A new source ID: `ph-`, `tx-` or `fl-` and twelve hex digits. */
const newSourceId = (kind: 'photo' | 'markdown' | 'file') => ({ photo: 'ph-', markdown: 'tx-', file: 'fl-' }[kind] + randomUUID().slice(0, 12));

/**
 * The host step every import ends in, whatever the sources came from (ADR 0011): the new entries are in `files`
 * already; the first new photo or text goes into the target box, if one was asked for, and the book is saved and
 * loaded again. Loading is what records the new photos' facts and, for photos without a file, has their previews fetched
 * (`observePhotos`, `refreshProvided`). Nothing new and nothing to place leaves the book as it is.
 */
async function finishImport(book: OpenProject, { project, photoIndex }: ProjectFiles, { imported, counts }: { imported: string[]; counts: ImportCounts },
  request: Pick<ImportRequest, 'target' | 'kind'>, progress: ((value: ImportProgress) => void) | undefined, checkpoint: SaveCheckpoint) {
  if (!imported.length || (!request.target && !(counts.photos + counts.texts + counts.files))) return book;
  if (request.target && request.kind && request.kind !== 'file') {
    const spread = scopeSpread(project.spreads.find(({ id }) => id === request.target?.spread), request.target.page);
    if (!spread) throw new Error('The selected spread no longer exists.');
    const id = request.target.box;
    spread.boxes[id] = {
      ...boxBase(spread.boxes[id]),
      ...(request.kind === 'photo' ? { photo: imported[0] } : { text: imported[0] }),
    };
  }
  progress?.({ done: imported.length, total: imported.length, saving: true });
  if (checkpoint.mcp) checkpoint.mcp.sources = [...imported];
  return updateProject(book, { project, photoIndex }, true, checkpoint);
}

/**
 * Imports photos that are not files, by their locators: Lightroom Classic photos sent from the plugin or picked there
 * for Import from Lightroom Classic…. A photo the book holds already, by its locator's key (same catalog and UUID),
 * is reported as existing and not added again, as a file is by path. A new photo gets no title of its own, so it
 * inherits its provider's (ADR 0011, §1). The rest is the same host step as a file import.
 */
export async function importProvidedPhotos(book: OpenProject, locators: readonly PhotoLocator[], { target, progress, checkpoint = { origin: 'app', label: 'Import sources' } }:
  { target?: ImportRequest['target']; progress?: (value: ImportProgress) => void; checkpoint?: SaveCheckpoint } = {}) {
  const project = structuredClone(book.project);
  const photoIndex: PhotoIndex = structuredClone(book.photoIndex);
  const counts: ImportCounts = { photos: 0, texts: 0, files: 0, skipped: 0, failed: 0 };
  const imported: string[] = [];
  const keyOf = (locator: PhotoLocator) => locator.provider + '\0' + locatorKindOf(locator).key(locator);
  const held = new Map(sourceEntries({ project, photoIndex }).flatMap((entry) => entry.kind === 'photo' ? [[keyOf(entry.locator), entry.id] as const] : []));
  for (const locator of locators) {
    if (isFileLocator(locator)) { counts.skipped++; continue; }
    const key = keyOf(locator);
    const previous = held.get(key);
    if (previous) { counts.existing = (counts.existing ?? 0) + 1; imported.push(previous); continue; }
    const id = newSourceId('photo');
    photoIndex[id] = locatorKindOf(locator).write(locator) as PhotoIndex[string];
    held.set(key, id);
    imported.push(id);
    counts.photos++;
  }
  const next = await finishImport(book, { project, photoIndex }, { imported, counts }, { target, kind: 'photo' }, progress, checkpoint);
  return { book: next, imported, counts };
}

export function projectSummary(book: OpenProject, id: string): ProjectSummary {
  const base = renderOrigin + '/render/' + id;
  return {
    id, folder: basename(book.folder), viewKey: book.viewKey ?? createHash('sha256').update(book.folder).digest('hex'), project: book.project, photoIndex: book.photoIndex,
    photos: Object.fromEntries([...book.photos.keys()].map((photo) => [photo, base + '/thumb/' + photo])),
    photoRevisions: Object.fromEntries([...book.photos].map(([id, photo]) => [id, photo.key])),
    photoDates: Object.fromEntries([...Object.entries(book.unavailablePhotos ?? {}), ...book.photos].flatMap(([id, photo]) => { const date = photoDate(photo); return date ? [[id, date]] : []; })),
    photoSizes: Object.fromEntries([...Object.entries(book.unavailablePhotos ?? {}), ...book.photos].map(([photo, { width, height }]) => [photo, { width, height }])),
    ...(() => {
      const provided = Object.fromEntries([...Object.entries(book.unavailablePhotos ?? {}), ...book.photos].flatMap(([photo, { provided }]) => provided ? [[photo, provided]] : []));
      return Object.keys(provided).length ? { photoProvided: provided } : {};
    })(),
    texts: book.texts, sources: book.sources, ...(book.templateHash ? { templateHash: book.templateHash } : {}),
  };
}

/** The data a render frame loads; its URLs are on `origin`, the frame's own, so it reads them as its own files. */
export function renderData(book: OpenProject, id: string, mode: RenderProject['mode'], network?: readonly string[], origin = renderOrigin): RenderProject {
  const base = origin + '/render/' + id;
  // Template files are named by the template's hash where it has one, not by the render session, so the frames of
  // later revisions load the same module, stylesheet and assets.
  const templateBase = (book.templateHash ? origin + '/render/' + book.templateHash : base) + '/template/';
  return {
    project: book.project,
    mode,
    ...(network ? { network: [...network] } : {}),
    photos: Object.fromEntries([...book.photos].map(([id, photo]) => {
      const { width, height, caption, title, credit, altText, captured, location, camera } = photo;
      return [id, { width, height, caption, title, credit, altText, ...(captured ? { captured } : {}), ...(location ? { location } : {}),
        ...(camera ? { camera } : {}), src: base + '/photo/' + id }];
    })),
    texts: book.texts,
    files: book.files,
    problems: book.problems, sources: book.sources,
    ...(book.fixture ? { fixture: book.fixture } : {}),
    template: {
      script: templateBase + 'template.js',
      css: book.assets.files.has('template.css') ? templateBase + 'template.css' : undefined,
      assets: Object.fromEntries(Object.entries(book.assets.urls).map(([path, name]) => [path, templateBase + name])),
      ...(book.assets.warnings ? { warnings: book.assets.warnings } : {}),
      // What each bundled font can set, for `fonts` and the Book check's font coverage.
      fonts: bundledFontCoverage(book.assets.files),
      ...(book.templateHash ? { hash: book.templateHash } : {}),
      // The scope of the pictures each template file places (picture-scopes.ts).
      pictureScopes: book.assets.pictureScopes,
    },
  };
}
