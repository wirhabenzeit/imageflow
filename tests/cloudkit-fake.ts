import { readFile, writeFile } from 'node:fs/promises';
import type { CloudKitNative, CloudKitRecord, CloudKitStatus } from '../desktop/sync-store-cloudkit';

type Stored = { name: string; data: Uint8Array; sha256?: string; lastModified: number; seq: number };
type Zone = { epoch: number; records: Map<string, Stored>; deletions: Map<string, number> };
type Failure = { op: string; code: string; retryAfter?: number; times: number; zone?: string };

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const failure = (code: string, retryAfter?: number) => Object.assign(new Error('CloudKit says ' + code), { code, ...(retryAfter === undefined ? {} : { retryAfter }) });

/**
 * The addon of desktop/native/cloudkit.mm in memory, behaving as the spike (#286) saw CloudKit behave: zones that must
 * exist before records are saved in them, a conditional create, change tokens per zone, cancellation by operation ID,
 * and errors by CKError name. Operations take a few turns of the event loop, so they can be cancelled while running.
 */
export class FakeCloudKit implements CloudKitNative {
  statusValue: CloudKitStatus = { entitled: true, container: 'iCloud.test', environment: 'Development', accountStatus: 'available' };
  user = '_user-one';
  readonly zones = new Map<string, Zone>();
  /** Every call by name, for tests that check what was (not) asked of CloudKit. */
  readonly calls: string[] = [];
  private readonly failures: Failure[] = [];
  private readonly cancelled = new Set<number>();
  private readonly accountListeners: (() => void)[] = [];
  private seq = 0;
  private epochs = 0;
  /** Tokens from before this sequence number are expired. */
  expiredBefore = 0;

  /** The next `times` calls of `op` (in `zone`, when given) fail with `code`. */
  fail(op: string, code: string, { times = 1, retryAfter, zone }: { times?: number; retryAfter?: number; zone?: string } = {}) {
    this.failures.push({ op, code, times, retryAfter, zone });
  }
  /** Deletes a zone as the user does in System Settings: later calls in it fail with `userDeletedZone`. */
  userDeletes(zone: string) { this.zones.delete(zone); this.userDeleted.add(zone); }
  private readonly userDeleted = new Set<string>();
  changeAccount() { for (const listener of this.accountListeners) listener(); }

  private async begin(op: string, zone?: string) {
    this.calls.push(op);
    if (!this.statusValue.entitled) throw failure('notInitialized');
    await tick();
    const index = this.failures.findIndex((entry) => entry.op === op && (entry.zone === undefined || entry.zone === zone));
    if (index >= 0) {
      const entry = this.failures[index];
      if (--entry.times <= 0) this.failures.splice(index, 1);
      throw failure(entry.code, entry.retryAfter);
    }
  }
  private zone(name: string) {
    const zone = this.zones.get(name);
    if (zone) return zone;
    throw failure(this.userDeleted.has(name) ? 'userDeletedZone' : 'zoneNotFound');
  }
  private checkCancelled(id?: number) {
    if (id !== undefined && this.cancelled.delete(id)) throw failure('operationCancelled');
  }
  private describe(record: Stored): CloudKitRecord {
    return { name: record.name, size: record.data.length, lastModified: record.lastModified, ...(record.sha256 ? { sha256: record.sha256 } : {}) };
  }

  async status() { this.calls.push('status'); return structuredClone(this.statusValue); }
  async userRecordId() { await this.begin('userRecordId'); return this.user; }
  async saveZone(name: string) {
    await this.begin('saveZone', name);
    this.userDeleted.delete(name);
    if (!this.zones.has(name)) this.zones.set(name, { epoch: ++this.epochs, records: new Map(), deletions: new Map() });
  }
  async deleteZones(names: string[]) {
    await this.begin('deleteZones');
    for (const name of names) { this.zone(name); this.zones.delete(name); }
  }
  async listZones() { await this.begin('listZones'); return [...this.zones.keys()]; }

  async putIfAbsent(zoneName: string, name: string, value: { data?: Uint8Array; file?: string; sha256?: string }, { id, onProgress }: { id?: number; onProgress?: (fraction: number) => void } = {}) {
    await this.begin('putIfAbsent', zoneName);
    // CloudKit reads an asset while it uploads it.
    const data = value.data ? new Uint8Array(value.data) : new Uint8Array(await readFile(value.file!));
    if (value.data && data.length > 1024 * 1024) throw failure('limitExceeded');
    this.checkCancelled(id);
    onProgress?.(0.5);
    await tick();
    this.checkCancelled(id);
    const zone = this.zone(zoneName);
    if (zone.records.has(name)) return { created: false };
    zone.records.set(name, { name, data, sha256: value.sha256, lastModified: Date.now(), seq: ++this.seq });
    zone.deletions.delete(name);
    onProgress?.(1);
    return { created: true };
  }

  async fetch(zoneName: string, name: string, { mode, file, id }: { mode: 'head' | 'bytes' | 'file'; file?: string; id?: number }) {
    await this.begin('fetch', zoneName);
    await tick();
    this.checkCancelled(id);
    const record = this.zones.get(zoneName)?.records.get(name);
    if (!record) return undefined;
    if (mode === 'file') await writeFile(file!, record.data, { flag: 'wx' });
    return { ...this.describe(record), ...(mode === 'bytes' ? { bytes: Buffer.from(record.data) } : {}) };
  }

  async changes(zoneName: string, token?: string, { limit }: { limit?: number } = {}) {
    await this.begin('changes', zoneName);
    const zone = this.zone(zoneName);
    let since = 0;
    if (token !== undefined) {
      const parsed = JSON.parse(Buffer.from(token, 'base64').toString('utf8')) as { epoch: number; seq: number };
      if (parsed.epoch !== zone.epoch || parsed.seq < this.expiredBefore) throw failure('changeTokenExpired');
      since = parsed.seq;
    }
    let changed = [...zone.records.values()].filter((record) => record.seq > since).sort((a, b) => a.seq - b.seq);
    const more = limit !== undefined && changed.length > limit;
    if (limit !== undefined) changed = changed.slice(0, limit);
    const deleted = token === undefined ? [] : [...zone.deletions].filter(([, seq]) => seq > since).map(([name]) => name);
    return { changed: changed.map((record) => this.describe(record)), deleted, more,
      token: Buffer.from(JSON.stringify({ epoch: zone.epoch, seq: this.seq })).toString('base64') };
  }

  async deleteRecords(zoneName: string, names: string[]) {
    await this.begin('deleteRecords', zoneName);
    if (names.length > 400) throw failure('limitExceeded');
    const zone = this.zone(zoneName);
    for (const name of names) if (zone.records.delete(name)) zone.deletions.set(name, ++this.seq);
  }

  cancel(id: number) { this.cancelled.add(id); return true; }
  onAccountChange(listener: () => void) { this.accountListeners.splice(0, Infinity, listener); }
}
