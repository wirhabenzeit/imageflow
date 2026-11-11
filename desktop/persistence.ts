import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import fs, { link, lstat, mkdir, mkdtemp, open, realpath, rm, unlink } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { z } from 'zod';
import { photoIndexSchema, projectSchema } from '../src/project';
import { createLockOwner, isLockOwnerAlive } from './lock-owner';

const names = ['project.json', 'photos.json'] as const;
type ManifestName = typeof names[number];
export type ProjectManifests = Record<ManifestName, Buffer>;
export type ProjectLock = (() => Promise<void>) & { tryRelocate(newFolder: string): Promise<boolean> };
export const maximumManifestBytes = 16 * 1024 * 1024;
const maximumJournalBytes = maximumManifestBytes * 6;
const entrySchema = z.object({
  before: z.string().max(Math.ceil(maximumManifestBytes / 3) * 4),
  after: z.string().max(Math.ceil(maximumManifestBytes / 3) * 4),
}).strict();
const guardedEntrySchema = z.union([entrySchema, z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()]);
const journalSchema = z.discriminatedUnion('version', [
  z.object({ version: z.literal(1), transaction: z.string().uuid(),
    manifests: z.object({ 'project.json': entrySchema, 'photos.json': entrySchema }).strict() }).strict(),
  z.object({ version: z.literal(2), transaction: z.string().uuid(),
    manifests: z.object({ 'project.json': guardedEntrySchema, 'photos.json': guardedEntrySchema }).strict() }).strict(),
]);
const ownerFields = { pid: z.number().int().positive().max(2147483647), token: z.string().uuid() };
const ownerSchema = z.discriminatedUnion('version', [
  z.object({ version: z.literal(1), ...ownerFields }).strict(),
  z.object({ version: z.literal(2), ...ownerFields, endpoint: z.string().min(1).max(256) }).strict(),
]);
type ManifestEdit = { before: Buffer; after: Buffer } | { sha256: string };
type Journal = { transaction: string; manifests: Record<ManifestName, ManifestEdit> };
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

export class CommittedProjectSaveError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CommittedProjectSaveError';
  }
}

function code(error: unknown) {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

async function syncDirectory(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
  try { await handle.sync(); }
  finally { await handle.close(); }
}

async function directory(path: string, parent: string, create: boolean) {
  let info = await lstat(path).catch((error: unknown) => {
    if (code(error) !== 'ENOENT') throw error;
    return undefined;
  });
  if (!info && create) {
    await mkdir(path, { mode: 0o700 }).catch((error: unknown) => { if (code(error) !== 'EEXIST') throw error; });
    await syncDirectory(parent);
    info = await lstat(path);
  }
  if (!info) return undefined;
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) {
    throw new Error(path + ' must be a real directory inside the project.');
  }
  return path;
}

async function internalFolder(folder: string, create: boolean) {
  const root = await realpath(folder);
  return directory(join(root, '.imageflow'), root, create);
}

async function persistenceFolder(folder: string, create: boolean) {
  const internal = await internalFolder(folder, create);
  return internal && directory(join(internal, 'persistence'), internal, create);
}

async function boundedFile(path: string, maximum: number) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maximum) throw new Error(path + ' is not a bounded regular file.');
    // Read at most the allowed bytes even if another process grows the file after stat().
    const bytes = Buffer.alloc(info.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const result = await handle.read(bytes, count, bytes.length - count, count);
      if (!result.bytesRead) break;
      count += result.bytesRead;
    }
    const after = await handle.stat();
    if (count !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) {
      throw new Error(path + ' changed while it was being read.');
    }
    return { bytes: bytes.subarray(0, count), info };
  } finally { await handle.close(); }
}

async function manifest(folder: string, name: typeof names[number]) {
  const root = await realpath(folder);
  const actual = await realpath(join(root, name));
  const path = relative(root, actual);
  if (!path || path === '..' || path.startsWith('..' + sep) || isAbsolute(path)) {
    throw new Error(name + ' points outside the project folder.');
  }
  return (await boundedFile(actual, maximumManifestBytes)).bytes;
}

function validateManifest(name: typeof names[number], bytes: Buffer) {
  if (bytes.length > maximumManifestBytes) throw new Error(name + ' exceeds the 16 MB save limit.');
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error(name + ' contains invalid JSON in the pending save.'); }
  if (!(name === 'project.json' ? projectSchema : photoIndexSchema).safeParse(value).success) {
    throw new Error(name + ' contains invalid project data in the pending save.');
  }
}

function decodeSource(name: typeof names[number], text: string) {
  const bytes = Buffer.from(text, 'base64');
  if (bytes.toString('base64') !== text) throw new Error('The pending save contains invalid base64 manifest data.');
  validateManifest(name, bytes);
  return bytes;
}

function decodeJournal(bytes: Buffer): Journal {
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error('The pending save journal contains invalid JSON. Preserve it and restore a valid journal before opening this project.'); }
  const parsed = journalSchema.safeParse(value);
  if (!parsed.success) throw new Error('The pending save journal has an unsupported version or invalid manifest entries. Preserve it before repairing this project.');
  const { transaction, manifests } = parsed.data;
  return {
    transaction,
    manifests: Object.fromEntries(names.map((name) => {
      const entry = manifests[name];
      return [name, 'sha256' in entry ? entry : { before: decodeSource(name, entry.before), after: decodeSource(name, entry.after) }];
    })) as Journal['manifests'],
  };
}

async function writeDurably(path: string, bytes: Buffer | string) {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
}

function conflict(name: string) {
  return new Error(name + ' changed outside ImageFlow during an interrupted save. Preserve .imageflow/persistence/pending-save.json and restore this manifest to its recorded original or saved bytes before reopening.');
}

async function recoveryManifest(folder: string, name: typeof names[number]) {
  try { return await manifest(folder, name); }
  catch (error) {
    if (code(error) === 'ENOENT') throw conflict(name);
    throw error;
  }
}

async function pendingJournal(folder: string) {
  const internal = await persistenceFolder(folder, false);
  if (!internal) return undefined;
  const path = join(internal, 'pending-save.json');
  const pending = await boundedFile(path, maximumJournalBytes).catch((error: unknown) => {
    if (code(error) !== 'ENOENT') throw error;
    return undefined;
  });
  return pending && { internal, path, ...pending };
}

async function finishSave(folder: string, pending: NonNullable<Awaited<ReturnType<typeof pendingJournal>>>, journal: Journal, staging: string) {
  // Validate every manifest before publishing any of them. Recheck each immediately before its rename as well.
  for (const name of names) {
    const bytes = await recoveryManifest(folder, name);
    const entry = journal.manifests[name];
    if ('sha256' in entry) {
      if (digest(bytes) !== entry.sha256) throw conflict(name);
      validateManifest(name, bytes);
    } else {
      if (!bytes.equals(entry.before) && !bytes.equals(entry.after)) throw conflict(name);
      if (!bytes.equals(entry.after)) await writeDurably(join(staging, name), entry.after);
    }
  }
  await syncDirectory(staging);
  for (const name of names) {
    const bytes = await recoveryManifest(folder, name);
    const entry = journal.manifests[name];
    if ('sha256' in entry) {
      if (digest(bytes) !== entry.sha256) throw conflict(name);
      continue;
    }
    if (bytes.equals(entry.after)) continue;
    if (!bytes.equals(entry.before)) throw conflict(name);
    // Both destinations are fixed names in the project root. rename() replaces a link rather than following it.
    await fs.rename(join(staging, name), join(folder, name));
    await syncDirectory(folder);
  }
  const current = await boundedFile(pending.path, maximumJournalBytes);
  if (current.info.ino !== pending.info.ino || current.info.dev !== pending.info.dev || !current.bytes.equals(pending.bytes)) {
    throw new Error('The pending save journal changed during recovery. Preserve it and reopen the project after resolving the conflict.');
  }
  await unlink(pending.path);
  await syncDirectory(pending.internal);
}

export async function recoverProjectSave(folder: string, { readOnly = false }: { readOnly?: boolean } = {}) {
  const pending = await pendingJournal(folder);
  if (!pending) return;
  if (readOnly) throw new Error('This project has an interrupted save. Open it as a writable project to recover .imageflow/persistence/pending-save.json before checking or previewing it.');
  const journal = decodeJournal(pending.bytes);
  const staging = await mkdtemp(join(pending.internal, 'recover-'));
  let complete = false;
  try {
    await finishSave(await realpath(folder), pending, journal, staging);
    complete = true;
  } finally {
    // Keep failed recovery evidence and unrelated abandoned staging directories intact.
    if (complete) await rm(staging, { recursive: true });
  }
}

export async function persistProjectManifests(folder: string, before: ProjectManifests, after: ProjectManifests) {
  const root = await realpath(folder);
  for (const name of names) {
    validateManifest(name, before[name]);
    if (!before[name].equals(after[name])) validateManifest(name, after[name]);
  }
  const internal = await persistenceFolder(root, true);
  if (!internal) throw new Error('Could not create the project save directory.');
  if (await pendingJournal(root)) throw new Error('A previous project save needs recovery. Reload this project before making another edit.');
  for (const name of names) if (!(await manifest(root, name)).equals(before[name])) throw new Error('The project changed on disk. Reload before making more edits.');
  const transaction = randomUUID();
  const edits = Object.fromEntries(names.map((name) => [name, before[name].equals(after[name])
    ? { sha256: digest(before[name]) } : { before: before[name], after: after[name] }])) as Journal['manifests'];
  const bytes = Buffer.from(JSON.stringify({ version: 2, transaction, manifests: Object.fromEntries(names.map((name) => {
    const entry = edits[name];
    return [name, 'sha256' in entry ? entry : { before: entry.before.toString('base64'), after: entry.after.toString('base64') }];
  })) }) + '\n');
  const staging = await mkdtemp(join(internal, 'save-'));
  let published = false;
  let complete = false;
  try {
    const source = join(staging, 'journal.json');
    await writeDurably(source, bytes);
    await syncDirectory(staging);
    const path = join(internal, 'pending-save.json');
    await link(source, path);
    published = true;
    await syncDirectory(internal);
    const pending = { internal, path, ...await boundedFile(path, maximumJournalBytes) };
    await finishSave(root, pending, { transaction, manifests: edits }, staging);
    complete = true;
  } catch (error) {
    if (published) throw new CommittedProjectSaveError('The save was interrupted after its recovery journal was committed. Reload this project to finish saving before making more edits.', { cause: error });
    throw error;
  } finally {
    if (!published || complete) {
      try { await rm(staging, { recursive: true }); }
      catch (error) {
        if (published) throw new CommittedProjectSaveError('The project was saved, but its internal staging folder could not be removed. Reload the project before making more edits.', { cause: error });
        throw error;
      }
    }
  }
}

function processAlive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (code(error) === 'ESRCH') return false;
    if (code(error) === 'EPERM') return true;
    throw error;
  }
}

async function readOwner(path: string) {
  const file = await boundedFile(path, 2048);
  let value: unknown;
  try { value = JSON.parse(file.bytes.toString('utf8')); }
  catch { throw new Error('The project writer lock is invalid. Preserve ' + path + ' and resolve its ownership before opening the project.'); }
  const result = ownerSchema.safeParse(value);
  if (!result.success) throw new Error('The project writer lock is invalid. Preserve ' + path + ' and resolve its ownership before opening the project.');
  return { ...file, owner: result.data };
}

// Call before opening a writable project and keep the returned release function for that editor's lifetime.
export async function acquireProjectLock(folder: string): Promise<ProjectLock> {
  let location = await realpath(folder);
  const originalInternal = await internalFolder(location, true);
  if (!originalInternal) throw new Error('Could not create the project lock directory.');
  let internal = originalInternal;
  const gate = join(internal, 'writer-lock-acquire');
  try { await mkdir(gate, { mode: 0o700 }); }
  catch (error) {
    if (code(error) !== 'EEXIST') throw error;
    throw new Error('Project lock acquisition is in progress or was interrupted. Close other ImageFlow instances and inspect ' + gate + ' before retrying.');
  }
  const token = randomUUID();
  let path = join(internal, 'writer.lock');
  let owned: Awaited<ReturnType<typeof readOwner>> | undefined;
  let proof: Awaited<ReturnType<typeof createLockOwner>> | undefined;
  try {
    try {
      const previous = await readOwner(path).catch((error: unknown) => {
        if (code(error) !== 'ENOENT') throw error;
        return undefined;
      });
      if (previous) {
        if (previous.owner.version === 1 && processAlive(previous.owner.pid)) {
          throw new Error('This project has a legacy writer lock for a live or reused process ID. Close other ImageFlow sessions and resolve the recorded ownership before reopening.');
        }
        if (previous.owner.version === 2 && await isLockOwnerAlive(previous.owner.endpoint, previous.owner.token)) {
          throw new Error('This project is already open for editing in another ImageFlow session.');
        }
      }
      proof = await createLockOwner(token);
      const owner = { version: 2 as const, pid: process.pid, token, endpoint: proof.endpoint };
      await writeDurably(join(gate, 'owner.json'), JSON.stringify(owner));
      await syncDirectory(gate);
      await syncDirectory(internal);
      if (previous) {
        // Preserve a proven retired owner's record. The acquisition gate serializes competing stale-lock claims.
        await link(path, join(internal, 'writer-stale-' + previous.owner.token + '.json'));
        await unlink(path);
        await syncDirectory(internal);
      }
      await link(join(gate, 'owner.json'), path);
      await syncDirectory(internal);
      owned = await readOwner(path);
    } finally {
      await rm(gate, { recursive: true });
      await syncDirectory(internal);
    }
  } catch (error) {
    await proof?.close();
    throw error;
  }
  let released = false;
  const matchesOwner = (current: Awaited<ReturnType<typeof readOwner>>) => current.owner.version === 2 && current.owner.token === token &&
    current.owner.endpoint === proof!.endpoint && current.info.ino === owned!.info.ino && current.info.dev === owned!.info.dev;
  const release = async () => {
    if (released) return;
    try {
      if (await internalFolder(location, false) === internal) {
        const current = await readOwner(path).catch((error: unknown) => {
          if (code(error) !== 'ENOENT') throw error;
          return undefined;
        });
        if (current && matchesOwner(current)) {
          await unlink(path);
          await syncDirectory(internal);
        }
      }
    } catch (error) {
      if (code(error) !== 'ENOENT') {
        throw new Error('Project ownership was retired, but its writer record could not be checked or removed. Preserve the remaining .imageflow lock evidence before repairing this project.', { cause: error });
      }
    } finally {
      // Releasing this capability always retires its proof, even when disk metadata needs manual repair.
      released = true;
      await proof!.close();
    }
  };
  return Object.assign(release, {
    async tryRelocate(newFolder: string) {
      if (released) return false;
      try {
        const candidate = await realpath(newFolder);
        const candidateInternal = await internalFolder(candidate, false);
        if (!candidateInternal) return false;
        const candidatePath = join(candidateInternal, 'writer.lock');
        const current = await readOwner(candidatePath);
        if (!matchesOwner(current)) return false;
        const previousExists = await lstat(location).catch((error: unknown) => {
          if (code(error) !== 'ENOENT') throw error;
          return undefined;
        });
        if (previousExists && await realpath(location) !== candidate) return false;
        if (released) return false;
        location = candidate;
        internal = candidateInternal;
        path = candidatePath;
        return true;
      } catch {
        // An unrelated candidate is validated by its own writable-open attempt. Keep our current proof intact.
        return false;
      }
    },
  });
}
