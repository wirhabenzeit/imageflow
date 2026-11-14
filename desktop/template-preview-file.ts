import { lstat, realpath } from 'node:fs/promises';
import { join, relative, isAbsolute, sep } from 'node:path';
import sharp from 'sharp';
import { previewMaxBytes, previewPath, previewTypes } from '../src/template-preview';
import type { PreviewFileReport } from '../src/template-preview';

const formats: Record<string, string> = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };
const maximumPixels = 40_000_000;

/** Whether an image's pixels decode completely, not only its header; bounded by maximumPixels. */
export async function decodes(file: string) {
  try {
    await sharp(file, { limitInputPixels: maximumPixels, failOn: 'error' }).resize(32, 32, { fit: 'inside' }).raw().toBuffer();
    return true;
  } catch { return false; }
}

/**
 * Reads a template's own preview image (`preview` in defineTemplate) the way the library uses it: a regular file inside
 * the template folder, not reached through a symbolic link, a PNG, JPEG or WebP that decodes, and at most
 * previewMaxBytes. Never throws: a file the library would not show reports why.
 */
export async function readTemplatePreview(folder: string, declared: string): Promise<PreviewFileReport & { file?: string }> {
  const path = previewPath(declared);
  if (!path) return { problem: 'The preview ' + declared + ' is not a PNG, JPEG or WebP file inside the template folder.' };
  const shown = './' + path;
  try {
    // Templates refuse symbolic links (templateFiles), so the preview may not be reached through one either.
    let current = folder;
    for (const part of path.split('/')) {
      current = join(current, part);
      const entry = await lstat(current);
      if (entry.isSymbolicLink()) return { problem: 'The preview ' + shown + ' is a symbolic link. Templates must contain their files.' };
    }
    const [root, file] = await Promise.all([realpath(folder), realpath(current)]);
    const inside = relative(root, file);
    if (!inside || inside.startsWith('..' + sep) || inside === '..' || isAbsolute(inside)) return { problem: 'The preview ' + shown + ' is outside the template folder.' };
    const stats = await lstat(file);
    if (!stats.isFile()) return { problem: 'The preview ' + shown + ' is not a file.' };
    if (stats.size > previewMaxBytes) {
      return { problem: 'The preview ' + shown + ' is ' + (stats.size / 1024 / 1024).toFixed(1) + ' MB. Use an image of at most ' +
        previewMaxBytes / 1024 / 1024 + ' MB; about 1200 pixels on the long edge is plenty.' };
    }
    const metadata = await sharp(file, { limitInputPixels: maximumPixels }).metadata();
    const type = metadata.format ? formats[metadata.format] : undefined;
    if (!type || !metadata.width || !metadata.height) return { problem: 'The preview ' + shown + ' is not a PNG, JPEG or WebP image.' };
    const declaredType = previewTypes[path.slice(path.lastIndexOf('.')).toLowerCase()];
    if (type !== declaredType) return { problem: 'The preview ' + shown + ' contains a ' + type.slice('image/'.length).toUpperCase() + ' image. Give it a matching file extension.' };
    // Headers can be intact while the pixels are not; Chromium would then show nothing.
    if (!await decodes(file)) return { problem: 'The preview ' + shown + ' is damaged: its pixels cannot be decoded.' };
    // EXIF orientations 5–8 turn the picture a quarter turn when it is shown.
    const turned = (metadata.orientation ?? 1) >= 5;
    return { width: turned ? metadata.height : metadata.width, height: turned ? metadata.width : metadata.height, type, bytes: stats.size, file };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { problem: 'The preview ' + shown + ' does not exist in the template folder.' };
    return { problem: 'The preview ' + shown + ' could not be read: ' + (error instanceof Error ? error.message : String(error)) };
  }
}
