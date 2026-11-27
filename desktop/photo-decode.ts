import { extname } from 'node:path';
import { photosLibrary } from './photos-library';

/*
 * HEIC and HEIF photos (#328), the iPhone's default format. The book links or stores the original as it is; neither
 * Chromium nor sharp (whose prebuilt libheif has no HEVC decoder) can decode it, so macOS does, through ImageIO in the
 * Photos addon (desktop/native/photos.mm). Every rendition, the thumbnail, the preview and the print rendition, is made
 * from what it decodes, and an export never prints the original itself. Its size and capture data come from the file,
 * as for any photo.
 */

export const nativeExtensions = new Set(['.heic', '.heif']);
/** Whether `path` names a photo only macOS decodes. */
export const decodedNatively = (path: string) => nativeExtensions.has(extname(path).toLowerCase());

/** The addon's decoder, or undefined where it is not there (another platform, or the addon does not load). */
function decoder() {
  const library = photosLibrary();
  return library && typeof library.decode === 'function' ? library : undefined;
}

/** Whether this Mac can decode HEIC photos. */
export const canDecodeNatively = () => !!decoder();

/** The photo extensions an import accepts: those sharp decodes, and HEIC and HEIF where macOS decodes them here. */
export function importablePhotoExtensions(photoExtensions: ReadonlySet<string>): Set<string> {
  return new Set([...photoExtensions, ...(canDecodeNatively() ? nativeExtensions : [])]);
}

const unreadable = (path: string) => new Error((path.split('/').pop() ?? path) + ' is a HEIC photo, which this Mac cannot read.');

/** The upright size of a HEIC photo, whether it has alpha, and how many pictures the file holds; read without decoding. */
export function nativeImageInfo(path: string) {
  const library = decoder();
  if (!library) throw unreadable(path);
  const info = library.imageInfo(path);
  if (!info) throw new Error((path.split('/').pop() ?? path) + ' is not a picture macOS can read.');
  return info;
}

/**
 * Decodes a HEIC photo, upright: into `file` as a TIFF with its colour profile, at most `size` pixels on its long edge;
 * without `file`, only checks that all of it decodes.
 */
export async function decodeNatively(path: string, options: { file?: string; size?: number } = {}) {
  const library = decoder();
  if (!library) throw unreadable(path);
  return library.decode(path, options);
}
