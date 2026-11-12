import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { BuildFailure, Loader } from 'esbuild';
import type { AuthoringDiagnostic } from '../src/authoring';
import { parseDocument, photoIndexSchema, projectSchema } from '../src/project';
import type { FixtureMarking, PhotoIndex, Project, ProjectFile, ProjectFiles, RenderProject } from '../src/project';
import { renderOrigin } from '../src/desktop';
import type { ImportRequest, ProjectSummary } from '../src/desktop';
import { photoDetails, photoExtensions } from './photos';
import { renditionCacheFor } from './rendition-cache';
import type { ProjectPhoto } from './photos';
import { CommittedProjectSaveError, persistProjectManifests, recoverProjectSave } from './persistence';
import { sourceEntries, sourcePath, sourceLinked, sourceFolder } from '../src/source-locations';
import type { SourceStatus } from '../src/source-locations';
import { digestBytes, SourceStore } from './source-store';
import { runtimeExports } from '../src/runtime-exports';

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
  const document = name === 'project.json' ? parseDocument(projectSchema, value, name) : parseDocument(photoIndexSchema, value, name);
  return { document, source };
}

const hostModules = new Map([
  ['imageflow', 'export const { ' + runtimeExports.join(', ') + ' } = globalThis.ImageFlowRuntime;'],
  ['react', 'export default globalThis.ImageFlowReact; export const { createElement, Fragment, Children } = globalThis.ImageFlowReact;'],
  ['react/jsx-runtime', 'export const { jsx, jsxs, Fragment } = globalThis.ImageFlowJSX;'],
]);

export class TemplateCompileError extends Error {
  constructor(message: string, readonly diagnostics: AuthoringDiagnostic[]) {
    super(message);
    this.name = 'TemplateCompileError';
  }
}

async function bundleTemplate(folder: string) {
  const entry = await containedPath(folder, 'template/index.tsx', 'template');
  const root = resolve(folder, 'template');
  const loader: Record<string, Loader> = Object.fromEntries(
    Object.keys(assetTypes).filter((ext) => ext !== '.js' && ext !== '.css').map((ext) => [ext, 'file']),
  );
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
            if (hostModules.has(args.path)) return { path: args.path, namespace: 'imageflow-host' };
            if (!args.path.startsWith('./') && !args.path.startsWith('../')) {
              return { errors: [{ text: 'Use a relative template import instead of ' + args.path + '.' }] };
            }
            const result = await builder.resolve(args.path, {
              kind: args.kind, importer: args.importer, resolveDir: args.resolveDir, pluginData: true,
            });
            if (result.errors.length) return { errors: result.errors };
            const path = await realpath(result.path);
            if (!isInside(root, path)) return { errors: [{ text: args.path + ' points outside template/.' }] };
            return { path };
          });
          builder.onLoad({ filter: /.*/, namespace: 'imageflow-host' }, (args) => ({
            contents: hostModules.get(args.path),
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
    return { files, urls };
  } catch (error) {
    const message = 'Template could not be bundled. ' + (error instanceof Error ? error.message : String(error));
    const errors = (error as Partial<BuildFailure> | null)?.errors;
    // An import of a helper this app's `imageflow` module lacks usually means the template needs a newer app.
    const missingHelper = (text: string) => /No matching export in "imageflow-host:imageflow" for import "([^"]+)"/.exec(text)?.[1];
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
  folder: string; cache: string; assets: TemplateAssets; photos: Map<string, ProjectPhoto>;
  texts: Record<string, string>; files: Record<string, ProjectFile>; problems: string[]; readOnly: boolean;
  sources?: Record<string, SourceStatus>;
  manifests: Record<ManifestName, Buffer>;
  // Set only on synthetic fixture books rendered by authoring checks.
  fixture?: FixtureMarking;
};

// Files for file parameters are read whole into the render data, so preview and export use the same input.
export const maximumFileSize = 20 * 1024 * 1024;
const fileName = (path: string) => basename(path).replace(/^fl-[0-9a-f-]{12}-/, '');

export async function loadProject(path: string, fallback: string, readOnly = false): Promise<OpenProject> {
  const folder = await realpath(path);
  await recoverProjectSave(folder, { readOnly });
  const [{ document: project, source: projectFile }, { document: photoIndex, source: photoFile }] = await Promise.all([
    readProjectDocument(folder, 'project.json'), readProjectDocument(folder, 'photos.json'),
  ]);
  const assets = await bundleTemplate(folder);
  const cache = fallback;
  return readContent({ folder, assets, cache, readOnly, project, photoIndex, manifests: { 'project.json': projectFile, 'photos.json': photoFile } });
}

async function readContent(book: Omit<OpenProject, 'photos' | 'texts' | 'files' | 'problems'>): Promise<OpenProject> {
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
      const { status, stored } = await store.resolve(book.folder, source);
      sources[source.key] = status;
      if (status.problem && source.kind !== 'file') problems.push(source.kind + ' ' + source.id + ' · ' + status.problem);
      if (source.kind === 'photo') {
        if (stored) {
          const { path: _path, linked: _linked, ...metadata } = book.photoIndex[source.id];
          photos.set(source.id, { ...metadata, ...await photoDetails(stored.snapshot), original: stored.snapshot, key: digestBytes(Buffer.from(stored.digest + ':rendition-3')),
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

export async function updateProject(book: OpenProject, files: ProjectFiles, reloadContent = false) {
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
  await persistProjectManifests(book.folder, { 'project.json': projectFile, 'photos.json': photoFile }, manifests);
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

export async function importIntoProject(book: OpenProject, request: ImportRequest, paths: string[]) {
  const project = structuredClone(book.project);
  const photoIndex: PhotoIndex = structuredClone(book.photoIndex);
  const mode = request.mode ?? book.project.importMode ?? 'copy';
  if (mode !== 'copy' && mode !== 'link') throw new Error('Unknown import mode.');
  const imported: string[] = [];
  const copied: string[] = [];
  const folder = request.kind === 'photo' ? 'photos' : request.kind === 'file' ? 'files' : 'texts';
  const extensions = request.kind === 'photo' ? photoExtensions : request.kind === 'file' ? new Set(request.accept) : new Set(['.md']);
  const registry = request.kind === 'file' ? project.files : project.texts;
  const targetFolder = join(book.folder, folder);
  await mkdir(targetFolder, { recursive: true });
  if (await realpath(targetFolder) !== targetFolder) throw new Error(folder + '/ must be a folder inside the project.');
  try {
    for (const file of paths) {
      const info = await stat(file);
      if (!info.isFile() || !extensions.has(extname(file).toLowerCase())) continue;
      if (request.kind === 'photo') await photoDetails(file);
      if (request.kind === 'markdown' && info.size > 5 * 1024 * 1024) throw new Error('Markdown files must be smaller than 5 MB.');
      if (request.kind === 'file' && info.size > maximumFileSize) throw new Error(basename(file) + ' is larger than 20 MB.');
      const previous = request.kind === 'photo'
        ? Object.entries(photoIndex).find(([, photo]) => (!!photo.linked === (mode === 'link') || isInside(book.folder, file)) && (photo.linked ? photo.path : join(book.folder, photo.path)) === file)?.[0]
        : Object.entries(registry).find(([, ref]) => (sourceLinked(ref) === (mode === 'link') || isInside(book.folder, file)) && (sourceLinked(ref) ? sourcePath(ref) : join(book.folder, sourcePath(ref))) === file)?.[0];
      if (previous) {
        imported.push(previous);
        continue;
      }
      const id = { photo: 'ph-', markdown: 'tx-', file: 'fl-' }[request.kind] + randomUUID().slice(0, 12);
      const name = basename(file).replace(/[^\p{L}\p{N} ._-]/gu, '-');
      const relativePath = folder + '/' + id + '-' + name;
      const path = join(book.folder, relativePath);
      const original = await realpath(file);
      const linked = mode === 'link' && !isInside(book.folder, original);
      if (!linked) { await copyFile(original, path, constants.COPYFILE_EXCL); copied.push(path); }
      if (request.kind === 'photo') photoIndex[id] = { path: linked ? original : relativePath, ...(linked ? { linked: true } : {}), title: basename(file, extname(file)) };
      else registry[id] = linked ? { path: original, linked: true } : relativePath;
      imported.push(id);
    }
    if (!imported.length) throw new Error('No supported files were selected.');
    if (request.target && request.kind !== 'file') {
      const spread = project.spreads.find(({ id }) => id === request.target?.spread);
      if (!spread) throw new Error('The selected spread no longer exists.');
      const id = request.target.box;
      spread.boxes[id] = {
        params: spread.boxes[id]?.params ?? {},
        ...(request.kind === 'photo' ? { photo: imported[0] } : { text: imported[0] }),
      };
    }
    const next = await updateProject(book, { project, photoIndex }, true);
    return { book: next, imported, copied };
  } catch (error) {
    // A durable save intent may already refer to these assets, including when it needs recovery on next open.
    if (!(error instanceof CommittedProjectSaveError)) await Promise.all(copied.map((path) => rm(path, { force: true })));
    throw error;
  }
}

export function projectSummary(book: OpenProject, id: string): ProjectSummary {
  const base = renderOrigin + '/render/' + id;
  return {
    id, folder: basename(book.folder), readOnly: book.readOnly, project: book.project, photoIndex: book.photoIndex,
    photos: Object.fromEntries([...book.photos.keys()].map((photo) => [photo, base + '/thumb/' + photo])),
    photoSizes: Object.fromEntries([...book.photos].map(([photo, { width, height }]) => [photo, { width, height }])),
    texts: book.texts, sources: book.sources,
  };
}

export function renderData(book: OpenProject, id: string, mode: RenderProject['mode']): RenderProject {
  const base = renderOrigin + '/render/' + id;
  return {
    project: book.project,
    mode,
    photos: Object.fromEntries([...book.photos].map(([id, photo]) => {
      const { width, height, caption, title, credit, altText } = photo;
      return [id, { width, height, caption, title, credit, altText, src: base + '/photo/' + id }];
    })),
    texts: book.texts,
    files: book.files,
    problems: book.problems, sources: book.sources,
    ...(book.fixture ? { fixture: book.fixture } : {}),
    template: {
      script: base + '/template/template.js',
      css: book.assets.files.has('template.css') ? base + '/template/template.css' : undefined,
      assets: Object.fromEntries(Object.entries(book.assets.urls).map(([path, name]) => [path, base + '/template/' + name])),
    },
  };
}
