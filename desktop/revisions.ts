import { sourcePath, sourceLinked } from '../src/source-locations';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { access, open, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ProjectRevision, RevisionDiagnosticCode } from '../src/authoring';
import { photoIndexSchema, projectSchema } from '../src/project';
import { approvedSource } from './source-access';

const manifests = ['project.json', 'photos.json'] as const;
const contentFolders = ['template', 'texts', 'photos', 'files'] as const;
type ContentFolder = typeof contentFolders[number];
type Input = { path: string; external?: string; folder?: ContentFolder };
type ExistingInput = { kind: 'file' | 'directory'; actual: string; info: BigIntStats };
type InputState = { kind: 'missing' } | { kind: 'unavailable' } | ExistingInput;
type Entry = { input: Input; state: InputState; digest?: string; children?: string[] };
type CaptureOptions = { signal?: AbortSignal; attempts?: 1 | 2 | 3 };
export type ProjectInputCapture = { revision: ProjectRevision; observation: string; metadataObservation: string };
export type InputIndexMetrics = { captures: number; filesHashed: number; bytesHashed: number; cacheHits: number;
  photoFilesHashed: number; photoBytesHashed: number };
type IndexedDigest = { state: ExistingInput; digest: string };
type IndexState = { entries: Map<string, IndexedDigest>; generation: number; closed: boolean; metrics: InputIndexMetrics };
const maximumIndexedFiles = 8192;

const ignoredName = (name: string) => name === '.DS_Store' || name === '.imageflow' ||
  name === '.imageflow-sdk' ||
  // Installed packages only feed Rebuild Dependencies; books use the saved bundle in template/vendor (ADR 0006).
  name === 'node_modules' ||
  name.startsWith('.imageflow-write-') || /(?:\.sw[opx]|\.tmp|~)$/.test(name);
const portable = (path: string) => path.split(sep).join('/');

export function isProjectInputPath(path: string) {
  if (path === 'project.json' || path === 'photos.json') return true;
  const [folder, ...parts] = path.split(sep);
  return contentFolders.some((name) => name === folder) && parts.every((name) => name &&
    name !== '.' && name !== '..' && !ignoredName(name));
}

export class ProjectRevisionError extends Error {
  constructor(readonly code: RevisionDiagnosticCode, readonly path?: string, options?: ErrorOptions) {
    const messages: Record<RevisionDiagnosticCode, string> = {
      'source-changed': 'Project inputs changed during revision capture.',
      'source-missing': 'A required project input is missing.',
      'source-outside-project': 'A project input points outside its folder.',
      'source-unreadable': 'A project input could not be read.',
    };
    super(path ? messages[code] + ' ' + path : messages[code], options);
    this.name = 'ProjectRevisionError';
  }
}

function isMissing(error: unknown) {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function isInside(base: string, path: string) {
  const rel = relative(base, path);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
}

async function inspect(root: string, { path, folder, external }: Input): Promise<InputState> {
  const base = folder ? join(root, folder) : root;
  const candidate = external ?? resolve(root, path);
  const isTemplateRoot = path === 'template' && folder === 'template';
  if (external && !await approvedSource(root, { key: path.slice(1).replace('/', ':'), kind: folder === 'photos' ? 'photo' : folder === 'texts' ? 'markdown' : 'file', path: external, linked: true })) return { kind: 'unavailable' };
  if (external ? !isAbsolute(external) : isAbsolute(path) || (!isTemplateRoot && !isInside(base, candidate))) {
    throw new ProjectRevisionError('source-outside-project', path);
  }
  try {
    const actual = await realpath(candidate);
    if (external && actual !== external) return { kind: 'unavailable' };
    if (!external && (isTemplateRoot ? actual !== base : !isInside(base, actual))) {
      throw new ProjectRevisionError('source-outside-project', path);
    }
    const info = await stat(actual, { bigint: true });
    if (info.isFile()) {
      if (folder && folder !== 'template') {
        const limit = folder === 'photos' ? external ? 50 : undefined : folder === 'texts' ? 5 : 20;
        if (limit && info.size > BigInt(limit * 1024 * 1024)) return { kind: 'unavailable' };
        try { await access(actual, constants.R_OK); }
        catch { return { kind: 'unavailable' }; }
      }
      return { kind: 'file', actual, info };
    }
    if (info.isDirectory()) return { kind: 'directory', actual, info };
  } catch (error) {
    if (error instanceof ProjectRevisionError) throw error;
    if (isMissing(error)) return { kind: 'missing' };
    if (folder && folder !== 'template' && ['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) return { kind: 'unavailable' };
    throw new ProjectRevisionError('source-unreadable', path, { cause: error });
  }
  throw new ProjectRevisionError('source-unreadable', path);
}

function sameFile(a: BigIntStats, b: BigIntStats) {
  return b.isFile() && a.dev === b.dev && a.ino === b.ino && a.size === b.size &&
    a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

function sameState(a: InputState, b: InputState) {
  if (a.kind === 'missing' || a.kind === 'unavailable' || b.kind === 'missing' || b.kind === 'unavailable') return a.kind === b.kind;
  return a.kind === b.kind && a.actual === b.actual && (a.kind === 'file'
    ? sameFile(a.info, b.info)
    : a.info.dev === b.info.dev && a.info.ino === b.info.ino);
}

async function readInput(root: string, input: Input, state: ExistingInput,
  signal: AbortSignal | undefined, keepBytes: boolean, metrics?: InputIndexMetrics) {
  const changed = () => new ProjectRevisionError('source-changed', input.path);
  try {
    const handle = await open(state.actual, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!sameFile(state.info, await handle.stat({ bigint: true })) ||
          !sameState(state, await inspect(root, input))) throw changed();
      const hash = createHash('sha256');
      if (metrics) {
        metrics.filesHashed++;
        if (input.folder === 'photos') metrics.photoFilesHashed++;
      }
      const hashBytes = (bytes: Buffer | string) => {
        hash.update(bytes);
        if (metrics) {
          const length = typeof bytes === 'string' ? Buffer.byteLength(bytes) : bytes.length;
          metrics.bytesHashed += length;
          if (input.folder === 'photos') metrics.photoBytesHashed += length;
        }
      };
      const bytes = keepBytes ? await handle.readFile({ signal }) : undefined;
      if (bytes) hashBytes(bytes);
      else {
        for await (const chunk of handle.createReadStream({ autoClose: false, signal })) hashBytes(chunk);
      }
      if (!sameFile(state.info, await handle.stat({ bigint: true }))) throw changed();
      return { digest: hash.digest('hex'), bytes };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof ProjectRevisionError) throw error;
    if (isMissing(error) || (error as NodeJS.ErrnoException).code === 'ELOOP') throw changed();
    throw new ProjectRevisionError('source-unreadable', input.path, { cause: error });
  }
}

async function directoryNames(state: ExistingInput, path: string) {
  try {
    return (await readdir(state.actual)).filter((name) => !ignoredName(name)).sort();
  } catch (error) {
    throw new ProjectRevisionError(isMissing(error) ? 'source-changed' : 'source-unreadable', path, { cause: error });
  }
}

function readManifest(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    // The project loader reports the JSON error. The broken document still has a content revision.
    return undefined;
  }
}

async function capture(folder: string, signal?: AbortSignal, index?: IndexState): Promise<ProjectInputCapture> {
  signal?.throwIfAborted();
  const generation = index?.generation;
  if (index) {
    if (index.closed) throw new ProjectRevisionError('source-changed');
    index.metrics.captures++;
  }
  let root: string;
  try {
    root = await realpath(folder);
  } catch (error) {
    throw new ProjectRevisionError(isMissing(error) ? 'source-missing' : 'source-unreadable', undefined, { cause: error });
  }
  const entries = new Map<string, Entry>();
  const visitedDirectories = new Set<string>();

  async function record(input: Input, keepBytes = false) {
    signal?.throwIfAborted();
    const state = await inspect(root, input);
    if (keepBytes && state.kind !== 'file') {
      throw new ProjectRevisionError(state.kind === 'missing' ? 'source-missing' : 'source-unreadable', input.path);
    }
    // Reuse content only after fresh path containment and metadata checks; manifests still supply their bytes.
    const cached = !keepBytes && index?.entries.get(input.path);
    let result: { digest: string; bytes?: Buffer } | undefined;
    if (state.kind === 'file') {
      if (cached && sameState(cached.state, state)) {
        result = { digest: cached.digest };
        index!.metrics.cacheHits++;
        index!.entries.delete(input.path);
        index!.entries.set(input.path, cached);
      } else {
        result = await readInput(root, input, state, signal, keepBytes, index?.metrics);
        if (index && (index.closed || index.generation !== generation)) throw new ProjectRevisionError('source-changed', input.path);
        if (index && !keepBytes) {
          index.entries.set(input.path, { state, digest: result.digest });
          while (index.entries.size > maximumIndexedFiles) index.entries.delete(index.entries.keys().next().value!);
        }
      }
    }
    const entry: Entry = { input, state, digest: result?.digest };
    entries.set(input.path, entry);
    return { entry, bytes: result?.bytes };
  }

  const project = projectSchema.safeParse(readManifest((await record({ path: manifests[0] }, true)).bytes!));
  const photos = photoIndexSchema.safeParse(readManifest((await record({ path: manifests[1] }, true)).bytes!));
  const sources: (Input & { folder: ContentFolder })[] = [];
  if (project.success) {
    for (const [id, ref] of Object.entries(project.data.texts)) sources.push(sourceLinked(ref)
      ? { path: '@markdown/' + id, external: sourcePath(ref), folder: 'texts' } : { path: sourcePath(ref), folder: 'texts' });
    for (const [id, ref] of Object.entries(project.data.files)) sources.push(sourceLinked(ref)
      ? { path: '@file/' + id, external: sourcePath(ref), folder: 'files' } : { path: sourcePath(ref), folder: 'files' });
  }
  if (photos.success) {
    for (const [id, photo] of Object.entries(photos.data)) sources.push(photo.linked
      ? { path: '@photo/' + id, external: photo.path, folder: 'photos' } : { path: photo.path, folder: 'photos' });
  }
  for (const input of sources) {
    // Inspect each registry entry even if another registry has already used the same path.
    if (entries.get(input.path)?.input.folder !== input.folder) await record(input);
  }

  async function walkTemplate(path: string) {
    const { entry } = await record({ path, folder: 'template' });
    const { state } = entry;
    if (state.kind === 'missing' && path !== 'template') throw new ProjectRevisionError('source-changed', path);
    if (state.kind !== 'directory' || visitedDirectories.has(state.actual)) return;
    visitedDirectories.add(state.actual);
    entry.children = await directoryNames(state, path);
    for (const child of entry.children) await walkTemplate(join(path, child));
  }
  await walkTemplate('template');

  const hash = createHash('sha256').update('imageflow-project-revision-1\n');
  const observation = createHash('sha256').update('imageflow-project-observation-1\n');
  for (const { input, state, digest, children } of [...entries.values()].sort((a, b) => a.input.path < b.input.path ? -1 : 1)) {
    signal?.throwIfAborted();
    const { path } = input;
    const current = await inspect(root, input);
    if (!sameState(state, current) || (children && current.kind === 'directory' &&
        JSON.stringify(children) !== JSON.stringify(await directoryNames(current, path)))) {
      throw new ProjectRevisionError('source-changed', path);
    }
    const actual = state.kind === 'missing' || state.kind === 'unavailable' ? null : portable(relative(root, state.actual));
    hash.update(JSON.stringify([portable(path), input.external ?? null, state.kind, actual, digest ?? null]) + '\n');
    if (current.kind !== 'missing' && current.kind !== 'unavailable') {
      const { dev, ino, size, mtimeNs, ctimeNs } = current.info;
      observation.update(JSON.stringify([portable(path), [dev, ino, size, mtimeNs, ctimeNs].join(':')]) + '\n');
    }
  }
  if (await realpath(folder).catch(() => undefined) !== root) throw new ProjectRevisionError('source-changed');
  signal?.throwIfAborted();
  const metadataObservation = observation.copy().digest('hex');
  if (index) {
    if (index.closed || index.generation !== generation) throw new ProjectRevisionError('source-changed');
    // Even a reverted edit observed by the watcher invalidates an in-flight result.
    observation.update('generation:' + generation);
    for (const path of index.entries.keys()) if (!entries.has(path)) index.entries.delete(path);
  }
  return { revision: hash.digest('hex'), observation: observation.digest('hex'), metadataObservation };
}

/** One bounded digest index per open project. Watchers invalidate it immediately, while every capture
 * also reconciles metadata and directory membership so missed events cannot silently reuse changed files. */
export class ProjectInputIndex {
  private readonly state: IndexState = { entries: new Map(), generation: 0, closed: false,
    metrics: { captures: 0, filesHashed: 0, bytesHashed: 0, cacheHits: 0, photoFilesHashed: 0, photoBytesHashed: 0 } };
  private pending: Promise<unknown> = Promise.resolve();
  constructor(readonly folder: string) {}

  get metrics(): InputIndexMetrics { return { ...this.state.metrics }; }

  invalidate(path?: string) {
    if (this.state.closed || (path !== undefined && !isProjectInputPath(path))) return;
    this.state.generation++;
    for (const name of this.state.entries.keys()) {
      if (path === undefined || name === path || name.startsWith(path + sep)) this.state.entries.delete(name);
    }
  }

  capture({ signal, attempts = 2 }: CaptureOptions = {}): Promise<ProjectInputCapture> {
    // Concurrent UI/MCP checks share completed digests instead of each starting a cold multi-GB scan.
    const task = this.pending.then(async () => {
      for (let attempt = 1; ; attempt++) {
        try { return await capture(this.folder, signal, this.state); }
        catch (error) {
          if (this.state.closed || !(error instanceof ProjectRevisionError) || error.code !== 'source-changed' || attempt >= attempts) throw error;
        }
      }
    });
    this.pending = task.catch(() => {});
    return task;
  }

  close() {
    this.invalidate();
    this.state.closed = true;
    this.state.entries.clear();
  }
}

// Compare both values around an operation. The revision identifies content, and the local observation also detects
// edits that were reverted to identical bytes before the second scan.
export async function captureProjectInputs(folder: string, { signal, attempts = 2 }: CaptureOptions = {}): Promise<ProjectInputCapture> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await capture(folder, signal);
    } catch (error) {
      if (!(error instanceof ProjectRevisionError) || error.code !== 'source-changed' || attempt >= attempts) throw error;
    }
  }
}

export async function captureProjectRevision(folder: string, options?: CaptureOptions): Promise<ProjectRevision> {
  return (await captureProjectInputs(folder, options)).revision;
}
