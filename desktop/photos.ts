import { fileStamp } from './file-stamp';
import { estimatedCapture } from './capture-time';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, realpath, rename, rm, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import sharp from 'sharp';
import type { Photo } from '../src/project';
import type { ProvidedMetadata } from '../src/asset-facts';
import { captureMetadata } from '../src/photo-metadata';
import { decodedNatively, decodeNatively, nativeImageInfo } from './photo-decode';

// The photo files sharp decodes. HEIC and HEIF photos, which macOS decodes, come along where it can (photo-decode.ts).
// AVIF is a HEIF file too, coded with AV1, which sharp decodes.
export const photoExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif']);
const formats = 'JPEG, PNG, WebP, AVIF or HEIC';
type Rendition = 'thumb' | 'preview' | 'export';
// `provided`: the title, caption, credit and alt text of a photo's provider (ADR 0011), which the book's own values in
// photos.json override field by field. `extra`: what its provider keeps with the fact, of which the editor shows only the
// curation marks the provider declares (ADR 0014). Neither reaches a template (`renderData` in desktop/project.ts).
export type ProjectPhoto = Photo & { estimatedCapture?: string; original: string; cache: string; key: string; alpha: boolean; passthrough: boolean; problem?: string; observation?: string;
  provided?: ProvidedMetadata; extra?: Record<string, unknown> };
// The same stamp as the source store's, because a photo's observation may come from either (src/file-stamp).
const observation = fileStamp;

export async function photoDetails(original: string, maximumBytes: number | null = 50 * 1024 * 1024) {
  const native = decodedNatively(original);
  if (!native && !photoExtensions.has(extname(original).toLowerCase())) throw new Error('Use ' + formats + ' images.');
  const info = await stat(original, { bigint: true });
  if (!info.isFile() || (maximumBytes !== null && info.size > BigInt(maximumBytes))) throw new Error('Photos must be files up to 50 MB.');
  // sharp reads a HEIC's EXIF without decoding it; its size and alpha come from ImageIO, which decodes it.
  const metadata = await sharp(original).metadata();
  const size = native ? nativeImageInfo(original) : undefined;
  // A HEIC is placed by its primary picture, also where the file holds others (a burst, say); macOS decodes HEVC and AV1.
  const still = native ? metadata.format === 'heif' && ['hevc', 'av1'].includes(metadata.compression ?? '')
    : (['jpeg', 'png', 'webp'].includes(metadata.format ?? '') || (metadata.format === 'heif' && metadata.compression === 'av1')) && (metadata.pages ?? 1) === 1;
  if (!still || !metadata.width || !metadata.height) throw new Error('Expected a still ' + formats + ' image.');
  const turned = (metadata.orientation ?? 1) >= 5;
  const capture = captureMetadata(metadata.exif);
  return {
    width: size?.width ?? (turned ? metadata.height : metadata.width),
    height: size?.height ?? (turned ? metadata.width : metadata.height),
    alpha: size?.alpha ?? !!metadata.hasAlpha,
    // Read from the original on every load, never stored in photos.json: existing books get it without re-importing,
    // and a replaced or edited source refreshes it.
    ...capture,
    // Editor-only: photo views sort undated photos by file time. For a snapshot, the caller supplies the original's.
    estimatedCapture: estimatedCapture(capture.captured, Number(info.mtimeMs)),
    passthrough: metadata.format === 'jpeg' && !metadata.icc && metadata.space === 'srgb' && (metadata.orientation ?? 1) === 1,
    observation: observation(info),
    // Renditions are kept across restarts, so the key leaves out the device number, which a restart may change (F-012).
    key: createHash('sha256').update([original, fileStamp(info), 'rendition-3'].join(':')).digest('hex'),
  };
}

export async function importPhotoDetails(original: string) {
  const details = await photoDetails(original);
  await checkPixels(original);
  return details;
}

/** Metadata alone can succeed on a truncated image: this decodes all of it, and fails where it can't. */
export async function checkPixels(original: string) {
  // Scaled down, a HEIC still decodes from all of its file, without holding a full-size copy: imports check several at once.
  if (decodedNatively(original)) await decodeNatively(original, { size: 512 });
  else await sharp(original, { failOn: 'warning' }).resize({ width: 1, height: 1 }).toBuffer();
}

// Making a rendition decodes the whole original, about 100–300 ms for a large photo, and requests arrive by the
// hundred: opening a book asks for every thumbnail, the photos on screen, and a cover in the background. They run a
// few at a time, most urgent first, so the photos on screen do not wait behind the rest. sharp runs on libuv's four
// worker threads and parallelises each image itself, so more at once only lengthens every one of them.
//   0  photos on screen in the editor
//   1  other work someone waits for: thumbnails, exports and checks
//   2  background work, such as a recent book's cover
export type PhotoPriority = 0 | 1 | 2;
type Job = { priority: PhotoPriority; start?: () => void };
const slots = 4;
const waiting: Job[] = [];
let active = 0;
function startNext() {
  while (active < slots && waiting.length) {
    // The first of the most urgent, so equally urgent requests keep their order.
    const index = waiting.reduce((best, job, i) => job.priority < waiting[best].priority ? i : best, 0);
    const [job] = waiting.splice(index, 1);
    active++;
    job.start!();
  }
}
async function scheduled<T>(job: Job, run: () => Promise<T>) {
  await new Promise<void>((start) => { job.start = start; waiting.push(job); startNext(); });
  try { return await run(); } finally { active--; startNext(); }
}

const pending = new Map<string, { job: Job; work: Promise<string> }>();

// Export renditions are resampled to `width` pixels when the placement needs fewer pixels than the original has.
export async function photoFile(photo: ProjectPhoto, rendition: Rendition, width?: number, priority: PhotoPriority = 1) {
  const resample = rendition === 'export' && width !== undefined && width < photo.width ? width : undefined;
  const unchanged = async () => {
    if (await realpath(photo.original) !== photo.original || (photo.observation && observation(await stat(photo.original, { bigint: true })) !== photo.observation)) {
      throw new Error('The original photo changed. Reload the book.');
    }
  };
  if (rendition === 'export' && !resample && photo.passthrough) { await unchanged(); return photo.original; }
  const extension = photo.alpha ? '.png' : '.jpg';
  const path = join(photo.cache, photo.key + '-' + rendition + (resample ? '-' + resample : '') + extension);
  const queued = pending.get(path);
  if (queued) {
    // A rendition queued for the background moves up when the editor shows it.
    if (priority < queued.job.priority) queued.job.priority = priority;
    return queued.work;
  }
  const job: Job = { priority };
  const work = (async () => {
    try {
      await access(path);
      return path;
    } catch {
      return scheduled(job, make);
    }
  })();
  async function make() {
    await unchanged();
    await mkdir(photo.cache, { recursive: true });
    const staging = await mkdtemp(join(photo.cache, '.render-'));
    try {
      const size = rendition === 'thumb' ? 240 : rendition === 'preview' ? 1400 : undefined;
      // A HEIC is decoded by macOS first, upright, and only as large as a thumbnail or preview needs (photo-decode.ts).
      let input = photo.original;
      if (decodedNatively(photo.original)) {
        input = join(staging, 'decoded.tiff');
        // Twice the size needed, so the last step down is sharp's, as for any photo: of a thumbnail or preview, or of a
        // print rendition for a placement that needs fewer pixels than the photo has. Otherwise at full size.
        const needed = size ?? (resample ? Math.ceil(resample * Math.max(photo.width, photo.height) / photo.width) : undefined);
        await decodeNatively(photo.original, { file: input, ...(needed ? { size: needed * 2 } : {}) });
      }
      const image = sharp(input).autoOrient().withIccProfile('srgb');
      if (size) {
        image.resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true });
      } else if (resample) {
        // Never enlarged: a sync proxy that stands in for a missing original is smaller than the original it reports.
        image.resize({ width: resample, kernel: 'lanczos3', withoutEnlargement: true });
      }
      if (photo.alpha) image.png(); else image.jpeg({ quality: rendition === 'export' ? 95 : 86, chromaSubsampling: rendition === 'export' ? '4:4:4' : '4:2:0' });
      const candidate = join(staging, 'photo' + extension);
      await image.toFile(candidate);
      await unchanged();
      await rename(candidate, path);
      return path;
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  pending.set(path, { job, work });
  try {
    return await work;
  } finally {
    pending.delete(path);
  }
}
