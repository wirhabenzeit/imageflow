import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { open, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ProjectRevision, RevisionDiagnosticCode } from '../src/authoring';
import { photoIndexSchema, projectSchema } from '../src/project';

const manifests = ['project.json', 'photos.json'] as const;
const contentFolders = ['template', 'texts', 'photos', 'files'] as const;
type ContentFolder = typeof contentFolders[number];
type Input = { path: string; folder?: ContentFolder };
type ExistingInput = { kind: 'file' | 'directory'; actual: string; info: BigIntStats };
type InputState = { kind: 'missing' } | ExistingInput;
type Entry = { input: Input; state: InputState; digest?: string; children?: string[] };
type CaptureOptions = { signal?: AbortSignal; attempts?: 1 | 2 | 3 };
export type ProjectInputCapture = { revision: ProjectRevision; observation: string };

const ignoredName = (name: string) => name === '.DS_Store' || name === '.imageflow' ||
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

async function inspect(root: string, { path, folder }: Input): Promise<InputState> {
  const base = folder ? join(root, folder) : root;
  const candidate = resolve(root, path);
  const isTemplateRoot = path === 'template' && folder === 'template';
  if (isAbsolute(path) || (!isTemplateRoot && !isInside(base, candidate))) {
    throw new ProjectRevisionError('source-outside-project', path);
  }
  try {
    const actual = await realpath(candidate);
    if (isTemplateRoot ? actual !== base : !isInside(base, actual)) {
      throw new ProjectRevisionError('source-outside-project', path);
    }
    const info = await stat(actual, { bigint: true });
    if (info.isFile()) return { kind: 'file', actual, info };
    if (info.isDirectory()) return { kind: 'directory', actual, info };
  } catch (error) {
    if (error instanceof ProjectRevisionError) throw error;
    if (isMissing(error)) return { kind: 'missing' };
    throw new ProjectRevisionError('source-unreadable', path, { cause: error });
  }
  throw new ProjectRevisionError('source-unreadable', path);
}

function sameFile(a: BigIntStats, b: BigIntStats) {
  return b.isFile() && a.dev === b.dev && a.ino === b.ino && a.size === b.size &&
    a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

function sameState(a: InputState, b: InputState) {
  if (a.kind === 'missing' || b.kind === 'missing') return a.kind === b.kind;
  return a.kind === b.kind && a.actual === b.actual && (a.kind === 'file'
    ? sameFile(a.info, b.info)
    : a.info.dev === b.info.dev && a.info.ino === b.info.ino);
}

async function readInput(root: string, input: Input, state: ExistingInput,
  signal: AbortSignal | undefined, keepBytes: boolean) {
  const changed = () => new ProjectRevisionError('source-changed', input.path);
  try {
    const handle = await open(state.actual, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!sameFile(state.info, await handle.stat({ bigint: true })) ||
          !sameState(state, await inspect(root, input))) throw changed();
      const hash = createHash('sha256');
      const bytes = keepBytes ? await handle.readFile({ signal }) : undefined;
      if (bytes) hash.update(bytes);
      else {
        for await (const chunk of handle.createReadStream({ autoClose: false, signal })) hash.update(chunk);
      }
      if (!sameFile(state.info, await handle.stat({ bigint: true }))) throw changed();
      return { digest: hash.digest('hex'), bytes };
    } finally {
      await handle.close();
    }
  } catch (error) {
    signal?.throwIfAborted();
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

async function capture(folder: string, signal?: AbortSignal): Promise<ProjectInputCapture> {
  signal?.throwIfAborted();
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
    const result = state.kind === 'file' ? await readInput(root, input, state, signal, keepBytes) : undefined;
    const entry: Entry = { input, state, digest: result?.digest };
    entries.set(input.path, entry);
    return { entry, bytes: result?.bytes };
  }

  const project = projectSchema.safeParse(readManifest((await record({ path: manifests[0] }, true)).bytes!));
  const photos = photoIndexSchema.safeParse(readManifest((await record({ path: manifests[1] }, true)).bytes!));
  const sources: (Input & { folder: ContentFolder })[] = [];
  if (project.success) {
    for (const path of Object.values(project.data.texts)) sources.push({ path, folder: 'texts' });
    for (const path of Object.values(project.data.files)) sources.push({ path, folder: 'files' });
  }
  if (photos.success) {
    for (const { path } of Object.values(photos.data)) sources.push({ path, folder: 'photos' });
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
    const actual = state.kind === 'missing' ? null : portable(relative(root, state.actual));
    hash.update(JSON.stringify([portable(path), state.kind, actual, digest ?? null]) + '\n');
    if (current.kind !== 'missing') {
      const { dev, ino, size, mtimeNs, ctimeNs } = current.info;
      observation.update(JSON.stringify([portable(path), [dev, ino, size, mtimeNs, ctimeNs].join(':')]) + '\n');
    }
  }
  if (await realpath(folder).catch(() => undefined) !== root) throw new ProjectRevisionError('source-changed');
  signal?.throwIfAborted();
  return { revision: hash.digest('hex'), observation: observation.digest('hex') };
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
