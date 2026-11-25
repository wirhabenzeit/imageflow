import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';

// A stand-in for ImageFlow.lrplugin in Lightroom Classic: it reads the bridge file, says hello, long-polls for jobs and
// answers them from an in-memory catalog, over real HTTP, as the Lua plugin does. Nothing here touches Lightroom.

export type FakePhoto = {
  lastEditTime: number; editCount: number; width: number; height: number; develop: Record<string, unknown>;
  color: string; fileName: string; title?: string; caption?: string; copyright?: string; captured?: string;
};
type Job = { id: string; type: string; [key: string]: unknown };

export const catalogId = 'C0FFEE00-0000-4000-8000-000000000001';
export const otherCatalogId = 'C0FFEE00-0000-4000-8000-000000000002';
export const uuid = (n: number) => '6A0D2D52-0D4E-4B1E-9B9B-' + String(n).padStart(12, '0');

export class FakeLightroom {
  catalog: { id: string; name: string } = { id: catalogId, name: 'Photos.lrcat' };
  readonly photos = new Map<string, FakePhoto>();
  selection: string[] = [];
  /** Photos a filter or a collapsed stack hides: they cannot be selected. */
  readonly hidden = new Set<string>();
  watched: string[] = [];
  jobs: Job[] = [];
  /** Called for each photo after it is rendered and before its revision is read again. */
  duringRender?: (uuid: string) => void;
  /** Writes a render to this path instead of into the folder ImageFlow named. */
  renderOutside?: string;
  /** Holds every render job until this resolves. */
  renderGate?: Promise<void>;
  /** Photos Lightroom has no preview of now: thumbnails of them are refused, as of one being edited in Develop. */
  readonly refused = new Set<string>();
  /** The colour a thumbnail shows instead of the photo's own: one from before an edit. */
  readonly keptColor = new Map<string, string>();
  /** The long edge of a thumbnail, where it is not 1440 px. */
  readonly keptEdge = new Map<string, number>();
  /** Fails every thumbnails job. */
  thumbnailsFail = false;
  /** Holds every thumbnails job until this resolves. */
  thumbnailGate?: Promise<void>;
  session?: string;
  private running = false;
  private poll?: AbortController;
  private loop?: Promise<void>;
  private bridge?: { port: number; token: string };

  /** `version` is the installed plugin's: 1.1.0 is the first to answer `thumbnails`. */
  constructor(private readonly file: string, private readonly version = '1.0.0') {}

  add(n: number, photo: Partial<FakePhoto> = {}) {
    this.photos.set(uuid(n), { lastEditTime: 785_000_000 + n, editCount: 1, width: 6000, height: 4000, develop: { Exposure2012: 0 },
      color: '#808080', fileName: 'DSC_' + String(n).padStart(4, '0') + '.ARW', captured: '2026-06-01T09:30:00+02:00', ...photo });
    return uuid(n);
  }
  revision(id: string) { const photo = this.photos.get(id)!; return [id, photo.lastEditTime.toFixed(6), photo.editCount, photo.width + 'x' + photo.height].join(':'); }
  developHash(id: string) { return createHash('md5').update(JSON.stringify(this.photos.get(id)!.develop)).digest('hex'); }
  /** A visual edit moves the revision and the develop hash; a metadata edit only the revision. */
  edit(id: string, change: { develop?: Record<string, unknown>; title?: string; crop?: { width: number; height: number }; color?: string }) {
    const photo = this.photos.get(id)!;
    photo.lastEditTime += 1;
    if (change.title !== undefined) { photo.title = change.title; photo.editCount += 1; }
    if (change.develop) photo.develop = { ...photo.develop, ...change.develop };
    if (change.color) photo.color = change.color;
    if (change.crop) Object.assign(photo, change.crop);
  }

  private async call(method: 'GET' | 'POST', path: string, body?: unknown, signal?: AbortSignal) {
    const { port, token } = this.bridge!;
    const response = await fetch('http://127.0.0.1:' + port + path, { method, signal, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }

  /** Reads the bridge file, says hello and starts polling. Resolves with the hello's answer. */
  async connect() {
    this.bridge = JSON.parse(await readFile(this.file, 'utf8'));
    const hello = await this.call('POST', '/lightroom/hello', { catalog: this.catalog, plugin: { version: this.version }, lightroom: '16.0.1' });
    if (hello.status !== 200) throw new Error('hello failed: ' + hello.status);
    this.session = hello.body.session as string;
    this.watched = hello.body.watch as string[];
    this.running = true;
    this.loop = this.pollLoop();
    return hello.body;
  }

  /** Stops polling. `abrupt` breaks the held poll's connection as a crash would; otherwise the plugin says bye. */
  async quit(abrupt = false) {
    this.running = false;
    if (abrupt) this.poll?.abort();
    else await this.call('POST', '/lightroom/bye', { session: this.session }).catch(() => {});
    this.poll?.abort();
    await this.loop?.catch(() => {});
  }

  async changes(uuids: string[]) { return this.call('POST', '/lightroom/changes', { session: this.session, uuids }); }
  async send(uuids: string[], catalog = this.catalog.id) {
    return this.call('POST', '/lightroom/send', { session: this.session, catalog, photos: uuids.map((id) => ({ uuid: id, name: this.photos.get(id)?.fileName })) });
  }

  private async pollLoop() {
    while (this.running) {
      this.poll = new AbortController();
      let answer;
      try { answer = await this.call('GET', '/lightroom/jobs?session=' + this.session, undefined, this.poll.signal); }
      catch { if (!this.running) return; await new Promise((resolve) => setTimeout(resolve, 50)); continue; }
      if (answer.status !== 200) return;
      for (const job of answer.body.jobs as Job[]) void this.run(job);
    }
  }

  private async run(job: Job) {
    this.jobs.push(job);
    try {
      const result = await this.answer(job);
      await this.call('POST', '/lightroom/results', { session: this.session, job: job.id, ok: true, result });
    } catch (error) {
      await this.call('POST', '/lightroom/results', { session: this.session, job: job.id, ok: false, error: (error as Error).message }).catch(() => {});
    }
  }

  private row(id: string, known?: string) {
    const photo = this.photos.get(id)!;
    const revision = this.revision(id);
    return { uuid: id, revision, ...(known === revision ? {} : { developHash: this.developHash(id) }), width: photo.width, height: photo.height, orientation: 'AB',
      captured: photo.captured, cameraMake: 'SONY', cameraModel: 'ILCE-7M3', fileName: photo.fileName,
      ...(photo.title ? { title: photo.title } : {}), ...(photo.caption ? { caption: photo.caption } : {}), ...(photo.copyright ? { copyright: photo.copyright } : {}) };
  }

  private async answer(job: Job): Promise<unknown> {
    if (job.type === 'watch') { this.watched = job.uuids as string[]; return {}; }
    // Like the real plugin, one that does not know a job never answers it.
    if (job.type === 'show' && (this.version === '1.0.0' || this.version === '1.1.0')) return new Promise(() => {});
    if (job.type === 'show') {
      const known = (job.uuids as string[]).filter((id) => this.photos.has(id));
      this.selection = known.filter((id) => !this.hidden.has(id));
      return { shown: this.selection.length, missing: (job.uuids as string[]).filter((id) => !this.photos.has(id)) };
    }
    if (job.type === 'selection') return { catalog: this.catalog.id, photos: this.selection.map((id) => ({ uuid: id, name: this.photos.get(id)?.fileName })) };
    if (job.type === 'metadata') {
      const photos = job.photos as { uuid: string; known?: string }[];
      return { photos: photos.filter(({ uuid: id }) => this.photos.has(id)).map(({ uuid: id, known }) => this.row(id, known)),
        missing: photos.filter(({ uuid: id }) => !this.photos.has(id)).map(({ uuid: id }) => id) };
    }
    if (job.type === 'thumbnails' && this.version !== '1.0.0') {
      await this.thumbnailGate;
      if (this.thumbnailsFail) throw new Error('The thumbnails failed.');
      const thumbnails = [], missing = [], refused = [];
      for (const { uuid: id, known } of job.photos as { uuid: string; known?: string }[]) {
        const photo = this.photos.get(id);
        if (!photo) { missing.push(id); continue; }
        if (this.refused.has(id)) { refused.push({ uuid: id, error: 'error loading thumb' }); continue; }
        const before = { revision: this.revision(id) };
        const scale = (this.keptEdge.get(id) ?? 1440) / Math.max(photo.width, photo.height);
        const file = join(job.folder as string, 'thumbnail-' + id + '.jpg');
        await writeFile(file, await sharp({ create: { width: Math.round(photo.width * scale), height: Math.round(photo.height * scale), channels: 3, background: this.keptColor.get(id) ?? photo.color } }).jpeg().toBuffer());
        this.duringRender?.(id);
        const revision = this.revision(id);
        thumbnails.push({ uuid: id, file, before, after: { revision, ...(known === revision ? {} : { developHash: this.developHash(id) }) } });
      }
      return { thumbnails, missing, refused };
    }
    if (job.type === 'render') {
      await this.renderGate;
      const renders = [];
      const missing = [];
      for (const id of job.uuids as string[]) {
        const photo = this.photos.get(id);
        if (!photo) { missing.push(id); continue; }
        const before = { revision: this.revision(id), developHash: this.developHash(id) };
        const scale = (job.size === 'preview' ? 140 : 300) / Math.max(photo.width, photo.height);
        const file = this.renderOutside ?? join(job.folder as string, photo.fileName.replace(/\.\w+$/, '') + '.jpg');
        await writeFile(file, await sharp({ create: { width: Math.round(photo.width * scale), height: Math.round(photo.height * scale), channels: 3, background: photo.color } })
          .jpeg().withMetadata({ exif: { IFD0: { ImageDescription: 'rendered ' + Math.random() } } }).toBuffer());
        this.duringRender?.(id);
        renders.push({ uuid: id, file, before, after: { revision: this.revision(id), developHash: this.developHash(id) } });
      }
      return { renders, missing };
    }
    throw new Error('Unknown job ' + job.type);
  }
}
