import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { S3Credentials } from './sync-s3-signer';
import type { S3SyncBackend } from '../src/settings';

/**
 * The credentials of the sync backend (#281, ADR 0012 section 2), kept in the main process only and never in
 * `settings.json`. A `CredentialStore` is the seam: the app uses `FileCredentialStore` with Electron's `safeStorage`
 * (keychain-backed) as its cipher; tests and unsigned development builds (`IMAGEFLOW_SYNC_CREDENTIALS=memory`) use
 * `MemoryCredentialStore`, so they never wait on a Keychain prompt.
 *
 * Credentials are stored for one endpoint and bucket (`credentialScope`), so changing the server in Settings never sends
 * the old server's key to the new one.
 */
export interface CredentialStore {
  read(scope: string): Promise<S3Credentials | undefined>;
  write(scope: string, credentials: S3Credentials): Promise<void>;
  /** Forgets the credentials of one scope, or all. */
  remove(scope?: string): Promise<void>;
}

/** The scope credentials are stored under: the endpoint's origin and the bucket. */
export const credentialScope = ({ endpoint, bucket }: Pick<S3SyncBackend, 'endpoint' | 'bucket'>) => {
  let origin = endpoint;
  try { origin = new URL(endpoint).origin; } catch { /* Kept as typed; such a backend does not validate anyway. */ }
  return origin + '/' + bucket;
};

/** Checks credentials as typed in Settings; the messages never repeat them. */
export function credentialsError(credentials: unknown): string | undefined {
  const value = credentials as Partial<S3Credentials> | undefined;
  if (!value || typeof value !== 'object' || typeof value.accessKeyId !== 'string' || typeof value.secretAccessKey !== 'string') return 'Enter the access key ID and the secret access key.';
  if (!/^[\x21-\x7e]{1,256}$/.test(value.accessKeyId)) return 'The access key ID is not valid.';
  if (!/^[\x21-\x7e]{1,512}$/.test(value.secretAccessKey)) return 'The secret access key is not valid.';
  return undefined;
}

/** What Settings may know of stored credentials: that they are there, and the end of the access key ID. */
export const credentialHint = (credentials: S3Credentials | undefined) => credentials && { stored: true as const, accessKeyEnd: credentials.accessKeyId.slice(-4) };

export class MemoryCredentialStore implements CredentialStore {
  readonly #entries = new Map<string, S3Credentials>();
  async read(scope: string) { const found = this.#entries.get(scope); return found && { ...found }; }
  async write(scope: string, credentials: S3Credentials) { this.#entries.set(scope, { accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.secretAccessKey }); }
  async remove(scope?: string) { if (scope === undefined) this.#entries.clear(); else this.#entries.delete(scope); }
}

/** Encrypts and decrypts short strings: Electron's `safeStorage` in the app. */
export type CredentialCipher = {
  available(): boolean;
  encrypt(text: string): Buffer;
  decrypt(data: Buffer): string;
};

type CredentialFile = { version: 1; credentials: Record<string, { accessKeyId: string; secretAccessKey: string }> };

/**
 * Credentials in a file of their own (`0600`), each value encrypted by `cipher` and stored as base64. Without
 * encryption the store refuses to write rather than keep a secret in the clear.
 */
export class FileCredentialStore implements CredentialStore {
  private writes = Promise.resolve();
  constructor(readonly file: string, private readonly cipher: CredentialCipher) {}

  private async load(): Promise<CredentialFile> {
    try {
      const value = JSON.parse(await readFile(this.file, 'utf8'));
      if (value?.version === 1 && value.credentials && typeof value.credentials === 'object') return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('ImageFlow could not read its sync credentials; they are entered again in Settings → Sync.');
    }
    return { version: 1, credentials: {} };
  }

  private async save(value: CredentialFile) {
    await mkdir(dirname(this.file), { recursive: true });
    const staging = join(dirname(this.file), '.credentials-' + randomUUID() + '.tmp');
    try {
      const handle = await open(staging, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync(); } finally { await handle.close(); }
      await rename(staging, this.file);
      await chmod(this.file, 0o600);
    } finally { await rm(staging, { force: true }); }
  }

  private change(edit: (value: CredentialFile) => void) {
    const run = this.writes.then(async () => { const value = await this.load(); edit(value); await this.save(value); });
    this.writes = run.then(() => {}, () => {});
    return run;
  }

  async read(scope: string) {
    await this.writes;
    const entry = (await this.load()).credentials[scope];
    if (!entry || !this.cipher.available()) return undefined;
    try {
      return { accessKeyId: this.cipher.decrypt(Buffer.from(entry.accessKeyId, 'base64')), secretAccessKey: this.cipher.decrypt(Buffer.from(entry.secretAccessKey, 'base64')) };
    } catch {
      // Encrypted on another Mac or by another signature of the app: entered again.
      return undefined;
    }
  }

  async write(scope: string, credentials: S3Credentials) {
    if (!this.cipher.available()) throw new Error('This Mac cannot encrypt the access key, so it is not stored. Unlock the login keychain and try again.');
    const entry = { accessKeyId: this.cipher.encrypt(credentials.accessKeyId).toString('base64'), secretAccessKey: this.cipher.encrypt(credentials.secretAccessKey).toString('base64') };
    await this.change((value) => { value.credentials[scope] = entry; });
  }

  async remove(scope?: string) {
    await this.change((value) => { if (scope === undefined) value.credentials = {}; else delete value.credentials[scope]; });
  }
}
