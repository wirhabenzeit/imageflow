import { execFile } from 'node:child_process';
import { access, constants } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { isHeic } from '../src/import-feedback';

/*
 * HEIC photos (UI-013), the iPhone's default format. Neither Chromium nor the app's image library (sharp, whose
 * prebuilt libheif has no HEVC decoder) can draw them, but macOS can: an import converts each to a JPEG with
 * `sips`, which goes through ImageIO and keeps the capture time, its offset, GPS, the colour profile (often Display P3)
 * and the orientation tag. The book stores that JPEG, as a copy even where the book links its files: a link would
 * name a file nothing can draw.
 */

export const heicExtensions = ['.heic', '.heif'];
const sips = '/usr/bin/sips';
// High enough that the copy is not visibly worse than the HEIC in print, which is printed from it.
const jpegQuality = 92;

let available: Promise<boolean> | undefined;
/** Whether this Mac can convert HEIC photos: only macOS has `sips`. */
export function canConvertHeic(): Promise<boolean> {
  if (process.platform !== 'darwin') return Promise.resolve(false);
  return available ??= new Promise((resolve) => access(sips, constants.X_OK, (error) => resolve(!error)));
}

/** The photo extensions an import accepts: JPEG, PNG and WebP, and HEIC where it can be converted. */
export async function importablePhotoExtensions(photoExtensions: ReadonlySet<string>): Promise<Set<string>> {
  return new Set([...photoExtensions, ...(await canConvertHeic() ? heicExtensions : [])]);
}

/** A converted HEIC: the JPEG to import in its place, the name to store it under, and a way to remove it afterwards. */
export type ConvertedHeic = { file: string; name: string; dispose: () => Promise<void> };

/**
 * Converts a HEIC photo to a JPEG in a folder of its own, removed by `dispose`. Fails, with a message that names the
 * file, where the file is no HEIC that macOS can read.
 */
export async function convertHeic(source: string, run: typeof execFile = execFile): Promise<ConvertedHeic> {
  if (!isHeic(source)) throw new Error(basename(source) + ' is not a HEIC photo.');
  const folder = await mkdtemp(join(tmpdir(), 'imageflow-heic-'));
  const name = basename(source, extname(source)) + '.jpg';
  const file = join(folder, name);
  const dispose = () => rm(folder, { recursive: true, force: true });
  try {
    await new Promise<void>((resolve, reject) => run(sips, ['-s', 'format', 'jpeg', '-s', 'formatOptions', String(jpegQuality), source, '--out', file],
      { timeout: 60_000 }, (error) => error ? reject(new Error(basename(source) + ' could not be converted from HEIC.')) : resolve()));
    if (!(await stat(file)).isFile()) throw new Error(basename(source) + ' could not be converted from HEIC.');
    return { file, name, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
