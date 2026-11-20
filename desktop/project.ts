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
import { parseDocument, photoIndexSchema, projectSchema, unsupportedBookMessage } from '../src/project';
import type { FixtureMarking, PhotoIndex, Project, ProjectFile, ProjectFiles, RenderProject } from '../src/project';
import { renderOrigin } from '../src/desktop';
import type { ImportRequest, ProjectSummary } from '../src/desktop';
import { importPhotoDetails, photoDetails, photoExtensions } from './photos';
import { renditionCacheFor } from './rendition-cache';
import { photoDate } from './capture-time';
import type { ProjectPhoto } from './photos';
import { CommittedProjectSaveError, persistProjectManifests, recoverProjectSave } from './persistence';
import type { SaveCheckpoint } from './persistence';
import { sourceEntries, sourcePath, sourceLinked, storedFileName } from '../src/source-locations';
import type { SourceStatus } from '../src/source-locations';
import { digestBytes, SourceStore } from './source-store';
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
  manifests: Record<ManifestName, Buffer>;
  // Set only on synthetic fixture books rendered by authoring checks.
  fixture?: FixtureMarking;
  // The hash of the template files as loaded (see templateHash); network approvals hold for this hash only (ADR 0006).
  templateHash?: string;
};

// Files for file parameters are read whole into the render data, so preview and export use the same input.
export const maximumFileSize = 20 * 1024 * 1024;
const fileName = (path: string) => basename(path).replace(/^fl-[0-9a-f-]{12}-/, '');

export async function loadProject(path: string, fallback: string, readOnly = false, pinSources = false): Promise<OpenProject> {
  const folder = await realpath(path);
  await recoverProjectSave(folder, { readOnly });
  const [{ document: project, source: projectFile }, { document: photoIndex, source: photoFile }] = await Promise.all([
    readProjectDocument(folder, 'project.json'), readProjectDocument(folder, 'photos.json'),
  ]);
  // Hashed before bundling: if the template changes in between, the watcher loads the book again.
  const hash = await templateHash(join(folder, 'template')).catch(() => undefined);
  const assets = await bundleTemplate(folder);
  const cache = fallback;
  return readContent({ folder, viewKey: createHash('sha256').update(await sourceBookKey(folder)).digest('hex'), assets, cache, readOnly, project, photoIndex, ...(hash ? { templateHash: hash } : {}), manifests: { 'project.json': projectFile, 'photos.json': photoFile } }, pinSources);
}

async function readContent(book: Omit<OpenProject, 'photos' | 'texts' | 'files' | 'problems'>, pinSources = false): Promise<OpenProject> {
  const photos = new Map<string, ProjectPhoto>();
  const texts: Record<string, string> = {};
  const files: Record<string, ProjectFile> = {};
  const sources: Record<string, SourceStatus> = {};
  const problems: string[] = [];
  const entries = sourceEntries(book);
  if (!entries.length) return { ...book, photos, texts, files, sources, problems };
  const store = await SourceStore.forBook(book.folder, book.cache);
  for (let i = 0; i < entries.length; i += 8) {
    await Promise.all(entries.slice(i, i + 8).map(async (source) => {
      const { status, stored } = await store.resolve(book.folder, source, { pin: pinSources, cache: book.cache });
      sources[source.key] = status;
      if (status.problem && source.kind !== 'file') problems.push(source.kind + ' ' + source.id + ' · ' + status.problem);
      if (source.kind === 'photo') {
        if (stored) {
          const { path: _path, linked: _linked, ...metadata } = book.photoIndex[source.id];
          const details = await photoDetails(stored.snapshot, null);
          // Without an EXIF capture time, photo views use the original's modification time, not the snapshot's.
          const estimate = details.captured ? undefined : stored.modified ?? details.estimatedCapture;
          photos.set(source.id, { ...metadata, ...details, estimatedCapture: estimate, observation: stored.direct && status.state === 'available' ? stored.observation : details.observation,
            width: stored.width!, height: stored.height!, original: stored.snapshot,
            key: stored.direct ? status.problem ? digestBytes(Buffer.from(stored.key + ':stale')) : stored.key! : digestBytes(Buffer.from(stored.digest + ':rendition-3')),
            cache: renditionCacheFor(book.cache), ...(status.problem ? { problem: status.problem } : {}) });
        }
      } else if (source.kind === 'markdown') {
        if (stored) texts[source.id] = await readFile(stored.snapshot, 'utf8');
      } else {
        files[source.id] = { name: fileName(source.path), extension: extname(source.path).toLowerCase(),
          ...(stored ? { text: await readFile(stored.snapshot, 'utf8') } : {}), ...(status.problem ? { problem: status.problem } : {}) };
      }
    }));
  }
  await store.settled();
  return { ...book, photos, texts, files, sources, problems: problems.sort() };
}

function projectJson(value: unknown) {
  return JSON.stringify(value, null, 2) + '\n';
}

export async function updateProject(book: OpenProject, files: ProjectFiles, reloadContent = false,
  checkpoint: SaveCheckpoint = { origin: 'app', label: 'Project edit' }) {
  if (book.readOnly) throw new Error('Use New Project to make an editable copy of the sample.');
  const project = parseDocument(projectSchema, files.project, 'project.json');
  const photoIndex = parseDocument(photoIndexSchema, files.photoIndex, 'photos.json');
  const projectSource = projectJson(project);
  const indexSource = projectJson(photoIndex);
  const projectChanged = projectJson(book.project) !== projectSource;
  const indexChanged = projectJson(book.photoIndex) !== indexSource;
  if (!projectChanged && !indexChanged) return book;
  const [projectFile, photoFile] = await Promise.all([readProjectManifest(book.folder, 'project.json'), readProjectManifest(book.folder, 'photos.json')]);
  const currentProject = parseDocument(projectSchema, parseJson(projectFile, 'project.json'), 'project.json');
  const currentIndex = parseDocument(photoIndexSchema, parseJson(photoFile, 'photos.json'), 'photos.json');
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
  const project = parseDocument(projectSchema, files.project, 'project.json');
  const photoIndex = parseDocument(photoIndexSchema, files.photoIndex, 'photos.json');
  const photos = new Map([...book.photos].flatMap(([id, photo]) => {
    if (!photoIndex[id]) return [];
    const { title, caption, credit, altText } = photoIndex[id];
    return [[id, { ...photo, title, caption, credit, altText }] as const];
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
  const counts = { photos: 0, texts: 0, files: 0, skipped: 0, failed: 0 };
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
  try {
    for (const entry of checked) {
      if (entry === 'skipped' || entry === 'failed') { counts[entry]++; continue; }
      const { file, kind, info } = entry;
      const folder = kind === 'photo' ? 'photos' : kind === 'file' ? 'files' : 'texts';
      const registry = kind === 'file' ? project.files : project.texts;
      const previous = kind === 'photo'
        ? Object.entries(photoIndex).find(([, photo]) => (!!photo.linked === (mode === 'link') || isInside(book.folder, file)) && (photo.linked ? photo.path : join(book.folder, photo.path)) === file)?.[0]
        : Object.entries(registry).find(([, ref]) => (sourceLinked(ref) === (mode === 'link') || isInside(book.folder, file)) && (sourceLinked(ref) ? sourcePath(ref) : join(book.folder, sourcePath(ref))) === file)?.[0];
      if (previous) {
        if (kind === 'photo') counts.photos++; else if (kind === 'markdown') counts.texts++; else counts.files++;
        imported.push(previous);
        continue;
      }
      const id = { photo: 'ph-', markdown: 'tx-', file: 'fl-' }[kind] + randomUUID().slice(0, 12);
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
    }
    // Links are approved before the book refers to them, all in one write.
    await approveSources(book.folder, approvals, request.accept);
    if (!imported.length) return { book, imported, copied, createdDirectories, counts };
    if (request.target && request.kind && request.kind !== 'file') {
      const spread = scopeSpread(project.spreads.find(({ id }) => id === request.target?.spread), request.target.page);
      if (!spread) throw new Error('The selected spread no longer exists.');
      const id = request.target.box;
      spread.boxes[id] = {
        params: spread.boxes[id]?.params ?? {},
        ...(request.kind === 'photo' ? { photo: imported[0] } : { text: imported[0] }),
      };
    }
    progress?.({ done: imported.length, total: imported.length, saving: true });
    if (checkpoint.mcp) checkpoint.mcp.sources = [...imported];
    const next = await updateProject(book, { project, photoIndex }, true, checkpoint);
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

export function projectSummary(book: OpenProject, id: string): ProjectSummary {
  const base = renderOrigin + '/render/' + id;
  return {
    id, folder: basename(book.folder), viewKey: book.viewKey ?? createHash('sha256').update(book.folder).digest('hex'), project: book.project, photoIndex: book.photoIndex,
    photos: Object.fromEntries([...book.photos.keys()].map((photo) => [photo, base + '/thumb/' + photo])),
    photoRevisions: Object.fromEntries([...book.photos].map(([id, photo]) => [id, photo.key])),
    photoDates: Object.fromEntries([...book.photos].flatMap(([id, photo]) => { const date = photoDate(photo); return date ? [[id, date]] : []; })),
    photoSizes: Object.fromEntries([...book.photos].map(([photo, { width, height }]) => [photo, { width, height }])),
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
