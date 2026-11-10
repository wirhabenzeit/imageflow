import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Loader } from 'esbuild';
import { parseDocument, photoIndexSchema, projectSchema } from '../src/project';
import type { PhotoIndex, Project, ProjectFiles, RenderProject } from '../src/project';
import { renderOrigin } from '../src/desktop';
import type { ImportRequest, ProjectSummary } from '../src/desktop';
import { photoDetails, photoExtensions } from './photos';
import type { ProjectPhoto } from './photos';

export const assetTypes: Record<string, string> = {
  '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf',
};

function isInside(directory: string, path: string) {
  const rel = relative(directory, path);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
}

async function containedPath(root: string, path: string, folder?: string) {
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

async function readJson(root: string, name: string) {
  const path = await containedPath(root, name);
  const source = await readFile(path, 'utf8');
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw new Error(name + ' contains invalid JSON.');
  }
}

const hostModules = new Map([
  ['imageflow', 'export const { defineTemplate, p, mm, pt, inch, Spread, PhotoBox, MarkdownBox, Element, asset } = globalThis.ImageFlowRuntime;'],
  ['react', 'export default globalThis.ImageFlowReact; export const { createElement, Fragment, Children } = globalThis.ImageFlowReact;'],
  ['react/jsx-runtime', 'export const { jsx, jsxs, Fragment } = globalThis.ImageFlowJSX;'],
]);

async function bundleTemplate(folder: string) {
  const entry = await containedPath(folder, 'template/index.tsx', 'template');
  const root = resolve(folder, 'template');
  const loader: Record<string, Loader> = Object.fromEntries(
    Object.keys(assetTypes).filter((ext) => ext !== '.js' && ext !== '.css').map((ext) => [ext, 'file']),
  );
  try {
    // esbuild reads its executable path when the module is first loaded.
    const { build } = require('esbuild') as typeof import('esbuild');
    const { outputFiles, metafile } = await build({
      entryPoints: [entry],
      outfile: resolve(root, 'template.js'),
      assetNames: 'asset-[name]-[hash]',
      metafile: true,
      absWorkingDir: root,
      bundle: true,
      write: false,
      format: 'esm',
      jsx: 'automatic',
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
    throw new Error('Template could not be bundled. ' + (error instanceof Error ? error.message : String(error)));
  }
}

async function cacheFolder(folder: string, fallback: string) {
  try {
    const candidate = join(folder, '.imageflow');
    await mkdir(candidate, { recursive: true });
    const cache = await realpath(candidate);
    if (!isInside(folder, cache)) throw new Error('Cache is outside the project.');
    const photos = join(cache, 'photos');
    await mkdir(photos, { recursive: true });
    if (await realpath(photos) !== photos) throw new Error('Photo cache is a link.');
    return photos;
  } catch {
    return fallback;
  }
}

type TemplateAssets = Awaited<ReturnType<typeof bundleTemplate>>;
export type OpenProject = ProjectFiles & {
  folder: string; cache: string; assets: TemplateAssets; photos: Map<string, ProjectPhoto>;
  texts: Record<string, string>; problems: string[]; readOnly: boolean;
};

export async function loadProject(path: string, fallback: string, readOnly = false): Promise<OpenProject> {
  const folder = await realpath(path);
  const [projectFile, photoFile] = await Promise.all([readJson(folder, 'project.json'), readJson(folder, 'photos.json')]);
  const project = parseDocument(projectSchema, projectFile, 'project.json');
  const photoIndex = parseDocument(photoIndexSchema, photoFile, 'photos.json');
  const [assets, cache] = await Promise.all([bundleTemplate(folder), readOnly ? fallback : cacheFolder(folder, fallback)]);
  return readContent({ folder, assets, cache, readOnly, project, photoIndex });
}

async function readContent(book: Omit<OpenProject, 'photos' | 'texts' | 'problems'>): Promise<OpenProject> {
  const photos = new Map<string, ProjectPhoto>();
  const texts: Record<string, string> = {};
  const problems: string[] = [];
  const entries = Object.entries(book.photoIndex);
  const readTexts = Promise.all(Object.entries(book.project.texts).map(async ([id, path]) => {
    try {
      if (extname(path).toLowerCase() !== '.md') throw new Error(path + ' must be a Markdown file.');
      texts[id] = await readFile(await containedPath(book.folder, path, 'texts'), 'utf8');
    } catch (error) {
      problems.push('Text ' + id + ' · ' + (error instanceof Error ? error.message : String(error)));
    }
  }));
  for (let i = 0; i < entries.length; i += 8) {
    await Promise.all(entries.slice(i, i + 8).map(async ([id, { path, ...metadata }]) => {
      try {
        const original = await containedPath(book.folder, path, 'photos');
        photos.set(id, { ...metadata, ...await photoDetails(original), original, cache: book.cache });
      } catch (error) {
        problems.push('Photo ' + id + ' · ' + (error instanceof Error ? error.message : String(error)));
      }
    }));
  }
  await readTexts;
  return { ...book, photos, texts, problems: problems.sort() };
}

function json(value: unknown) {
  return JSON.stringify(value, null, 2) + '\n';
}

export async function updateProject(book: OpenProject, files: ProjectFiles, reloadContent = false) {
  if (book.readOnly) throw new Error('Use New Project to make an editable copy of the sample.');
  const project = parseDocument(projectSchema, files.project, 'project.json');
  const photoIndex = parseDocument(photoIndexSchema, files.photoIndex, 'photos.json');
  const projectChanged = json(book.project) !== json(project);
  const indexChanged = json(book.photoIndex) !== json(photoIndex);
  if (!projectChanged && !indexChanged) return book;
  const currentProject = parseDocument(projectSchema, await readJson(book.folder, 'project.json'), 'project.json');
  const currentIndex = parseDocument(photoIndexSchema, await readJson(book.folder, 'photos.json'), 'photos.json');
  if (json(currentProject) !== json(book.project) || json(currentIndex) !== json(book.photoIndex)) {
    throw new Error('The project changed on disk. Reload before making more edits.');
  }
  const staging = await mkdtemp(join(book.folder, '.imageflow-write-'));
  try {
    const projectPath = join(staging, 'project.json');
    const indexPath = join(staging, 'photos.json');
    if (projectChanged) await writeFile(projectPath, json(project));
    if (indexChanged) await writeFile(indexPath, json(photoIndex));
    if (indexChanged) await rename(indexPath, join(book.folder, 'photos.json'));
    try {
      if (projectChanged) await rename(projectPath, join(book.folder, 'project.json'));
    } catch (error) {
      if (indexChanged) {
        await writeFile(indexPath, json(book.photoIndex));
        await rename(indexPath, join(book.folder, 'photos.json'));
      }
      throw error;
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  if (reloadContent) return readContent({ ...book, project, photoIndex });
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
  const imported: string[] = [];
  const copied: string[] = [];
  const folder = request.kind === 'photo' ? 'photos' : 'texts';
  const extensions = request.kind === 'photo' ? photoExtensions : new Set(['.md']);
  const targetFolder = join(book.folder, folder);
  await mkdir(targetFolder, { recursive: true });
  if (await realpath(targetFolder) !== targetFolder) throw new Error(folder + '/ must be a folder inside the project.');
  try {
    for (const file of paths) {
      const info = await stat(file);
      if (!info.isFile() || !extensions.has(extname(file).toLowerCase())) continue;
      if (request.kind === 'photo') await photoDetails(file);
      if (request.kind === 'markdown' && info.size > 5 * 1024 * 1024) throw new Error('Markdown files must be smaller than 5 MB.');
      const previous = request.kind === 'photo'
        ? Object.entries(photoIndex).find(([, photo]) => join(book.folder, photo.path) === file)?.[0]
        : Object.entries(project.texts).find(([, path]) => join(book.folder, path) === file)?.[0];
      if (previous) {
        imported.push(previous);
        continue;
      }
      const id = (request.kind === 'photo' ? 'ph-' : 'tx-') + randomUUID().slice(0, 12);
      const name = basename(file).replace(/[^\p{L}\p{N} ._-]/gu, '-');
      const relativePath = folder + '/' + id + '-' + name;
      const path = join(book.folder, relativePath);
      await copyFile(file, path, constants.COPYFILE_EXCL);
      copied.push(path);
      if (request.kind === 'photo') photoIndex[id] = { path: relativePath, title: basename(file, extname(file)) };
      else project.texts[id] = relativePath;
      imported.push(id);
    }
    if (!imported.length) throw new Error('No supported files were selected.');
    if (request.target) {
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
    await Promise.all(copied.map((path) => rm(path, { force: true })));
    throw error;
  }
}

export function projectSummary(book: OpenProject, id: string): ProjectSummary {
  const base = renderOrigin + '/render/' + id;
  return {
    id, folder: basename(book.folder), readOnly: book.readOnly, project: book.project, photoIndex: book.photoIndex,
    photos: Object.fromEntries([...book.photos.keys()].map((photo) => [photo, base + '/thumb/' + photo])),
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
    problems: book.problems,
    template: {
      script: base + '/template/template.js',
      css: book.assets.files.has('template.css') ? base + '/template/template.css' : undefined,
      assets: Object.fromEntries(Object.entries(book.assets.urls).map(([path, name]) => [path, base + '/template/' + name])),
    },
  };
}
