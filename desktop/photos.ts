import { captureTime } from './capture-time';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, realpath, rename, rm, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import sharp from 'sharp';
import type { Photo } from '../src/project';

export const photoExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp']);
type Rendition = 'thumb' | 'preview' | 'export';
export type ProjectPhoto = Photo & { original: string; cache: string; key: string; alpha: boolean; passthrough: boolean; problem?: string; observation?: string };
const observation = (info: import('node:fs').BigIntStats) => [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');

export async function photoDetails(original: string, maximumBytes: number | null = 50 * 1024 * 1024) {
  if (!photoExtensions.has(extname(original).toLowerCase())) throw new Error('Use JPEG, PNG, or WebP images.');
  const info = await stat(original, { bigint: true });
  if (!info.isFile() || (maximumBytes !== null && info.size > BigInt(maximumBytes))) throw new Error('Photos must be files up to 50 MB.');
  const metadata = await sharp(original).metadata();
  if (!['jpeg', 'png', 'webp'].includes(metadata.format ?? '') || !metadata.width || !metadata.height || (metadata.pages ?? 1) > 1) throw new Error('Expected a still JPEG, PNG or WebP image.');
  const turned = (metadata.orientation ?? 1) >= 5;
  return {
    ...captureTime(metadata.exif, Number(info.mtimeMs)),
    width: turned ? metadata.height : metadata.width,
    height: turned ? metadata.width : metadata.height,
    alpha: !!metadata.hasAlpha,
    passthrough: metadata.format === 'jpeg' && !metadata.icc && metadata.space === 'srgb' && (metadata.orientation ?? 1) === 1,
    observation: observation(info),
    key: createHash('sha256').update([original, info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs, 'rendition-2'].join(':')).digest('hex'),
  };
}

export async function importPhotoDetails(original: string) {
  const details = await photoDetails(original);
  // Metadata alone can succeed on a truncated image. Validate its pixels before adding it to the book.
  await sharp(original, { failOn: 'warning' }).resize({ width: 1, height: 1 }).toBuffer();
  return details;
}

const pending = new Map<string, Promise<string>>();

// Export renditions are resampled to `width` pixels when the placement needs fewer pixels than the original has.
export async function photoFile(photo: ProjectPhoto, rendition: Rendition, width?: number) {
  const resample = rendition === 'export' && width !== undefined && width < photo.width ? width : undefined;
  const unchanged = async () => {
    if (await realpath(photo.original) !== photo.original || (photo.observation && observation(await stat(photo.original, { bigint: true })) !== photo.observation)) {
      throw new Error('The original photo changed. Reload the book.');
    }
  };
  if (rendition === 'export' && !resample && photo.passthrough) { await unchanged(); return photo.original; }
  const extension = photo.alpha ? '.png' : '.jpg';
  const path = join(photo.cache, photo.key + '-' + rendition + (resample ? '-' + resample : '') + extension);
  if (pending.has(path)) return pending.get(path)!;
  const work = (async () => {
    try {
      await access(path);
      return path;
    } catch {
      await unchanged();
      await mkdir(photo.cache, { recursive: true });
      const staging = await mkdtemp(join(photo.cache, '.render-'));
      try {
        const image = sharp(photo.original).autoOrient().withIccProfile('srgb');
        if (rendition !== 'export') {
          const size = rendition === 'thumb' ? 240 : 1400;
          image.resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true });
        } else if (resample) {
          image.resize({ width: resample, kernel: 'lanczos3' });
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
  })();
  pending.set(path, work);
  try {
    return await work;
  } finally {
    pending.delete(path);
  }
}
