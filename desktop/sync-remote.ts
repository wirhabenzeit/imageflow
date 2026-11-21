import { constants } from 'node:fs';
import { copyFile, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { blobKeyPattern, commitHeaderSchema, deriveTips, readCommitHeader } from '../src/sync-snapshot';
import type { CommitHeader } from '../src/sync-snapshot';

/**
 * The storage a book syncs through (ADR 0010, Milestone 1): immutable commit headers and immutable content-addressed
 * blobs, nothing mutable. Heads are derived from the headers (`remoteTips`), so two Macs pushing at once produce two
 * tips instead of a torn head file. Transports implement this (a synced folder in #251, object storage later); the
 * sync engine never trusts what they return and verifies every digest itself.
 */
export interface SyncRemote {
  /** Stores a commit header. Headers are immutable: storing one whose ID exists is an error unless it is identical. */
  putCommit(header: CommitHeader): Promise<void>;
  /** A commit header as stored (parsed JSON), or undefined. The engine validates it (`readCommitHeader`). */
  getCommit(bookId: string, commitId: string): Promise<unknown>;
  /** Every commit header of a book as stored (parsed JSON). Files that are not whole JSON yet are left out; anything
   * else is returned, so the engine can tell a header a newer version wrote from one still arriving. */
  listCommits(bookId: string): Promise<unknown[]>;
  hasBlob(key: string): Promise<boolean>;
  /** Stores a blob under a key of `blobKeyPattern`, from bytes or a local file. An existing blob is kept. */
  putBlob(key: string, source: Uint8Array | { file: string }): Promise<void>;
  /** A whole blob, or undefined when the remote does not have it (yet). For small blobs. */
  getBlob(key: string): Promise<Uint8Array | undefined>;
  /** Writes a blob to a new local file at `destination`; false when the remote does not have it (yet). For large blobs. */
  downloadBlob(key: string, destination: string): Promise<boolean>;
}

/** A book's commits on a remote. Throws `NewerSyncFormatError` for one a newer version wrote. */
export async function remoteCommits(remote: SyncRemote, bookId: string) {
  return (await remote.listCommits(bookId)).map(readCommitHeader).filter((header) => header !== undefined && header.bookId === bookId) as CommitHeader[];
}

/** The tips of a book on a remote: commits that no other commit names as a parent. */
export async function remoteTips(remote: SyncRemote, bookId: string) {
  return deriveTips(await remoteCommits(remote, bookId));
}

export function requireBlobKey(key: string) {
  if (!blobKeyPattern.test(key)) throw new Error('Not a sync blob key: ' + key);
}

/** A remote held in memory: tests, and the reference for what a transport has to do. */
export class MemoryRemote implements SyncRemote {
  // Values as stored; tests put other ones here to stand for what another version wrote.
  readonly commits = new Map<string, unknown>();
  readonly blobs = new Map<string, Uint8Array>();
  async putCommit(header: CommitHeader) {
    const parsed = commitHeaderSchema.parse(header);
    const key = parsed.bookId + '/' + parsed.commitId;
    const existing = this.commits.get(key);
    if (existing && JSON.stringify(existing) !== JSON.stringify(parsed)) throw new Error('A different commit with this ID exists.');
    this.commits.set(key, structuredClone(parsed));
  }
  async getCommit(bookId: string, commitId: string) {
    const header = this.commits.get(bookId + '/' + commitId);
    return header && structuredClone(header);
  }
  async listCommits(bookId: string) {
    return [...this.commits.entries()].filter(([key]) => key.startsWith(bookId + '/')).map(([, header]) => structuredClone(header));
  }
  async hasBlob(key: string) { requireBlobKey(key); return this.blobs.has(key); }
  async putBlob(key: string, source: Uint8Array | { file: string }) {
    requireBlobKey(key);
    if (this.blobs.has(key)) return;
    this.blobs.set(key, source instanceof Uint8Array ? new Uint8Array(source) : new Uint8Array(await readFile(source.file)));
  }
  async getBlob(key: string) {
    requireBlobKey(key);
    const bytes = this.blobs.get(key);
    return bytes && new Uint8Array(bytes);
  }
  async downloadBlob(key: string, destination: string) {
    const bytes = await this.getBlob(key);
    if (!bytes) return false;
    await writeAtomically(destination, bytes);
    return true;
  }
}

/** Writes a new file by a rename from a staging file beside it. */
export async function writeAtomically(destination: string, source: Uint8Array | { file: string }) {
  const staging = join(dirname(destination), '.sync-' + randomUUID() + '.tmp');
  try {
    if (source instanceof Uint8Array) await writeFile(staging, source, { flag: 'wx', mode: 0o644 });
    else await copyFile(source.file, staging, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL);
    await rename(staging, destination);
  } finally { await rm(staging, { force: true }); }
}
