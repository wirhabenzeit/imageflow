import { resolveFormat } from './format';
import type { PrintFormat } from './format';

// A template's own preview image (`preview` in defineTemplate): a picture inside the template folder that the New Book
// picker shows instead of a render of the template's opening spread. Shared by the template schema, the render
// frame's Book check, and the template library.

/** The image types a template preview may use, by lowercase file extension. */
export const previewTypes: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
/** The largest preview file the library shows. Tiles are at most a few hundred pixels wide. */
export const previewMaxBytes = 2 * 1024 * 1024;
/** How far a preview's width-to-height ratio may differ from the default format's, relative to it, before a warning. */
export const previewAspectTolerance = 0.05;

/**
 * The preview path relative to the template folder with forward slashes (`./preview.jpg` → `preview.jpg`), or
 * undefined when it could point outside the folder, into a dotfile or folder the template leaves out of its copies,
 * or at a file of another type.
 */
export function previewPath(value: string) {
  if (value.length > 200 || value.includes('\\') || value.includes('\0') || value.startsWith('/')) return undefined;
  const parts = value.replace(/^\.\//, '').split('/');
  if (parts.some((part) => !part || part.startsWith('.') || part === 'node_modules')) return undefined;
  const path = parts.join('/');
  const dot = path.lastIndexOf('.');
  return dot > 0 && previewTypes[path.slice(dot).toLowerCase()] ? path : undefined;
}

/** The width-to-height ratio of a format's trimmed page, the shape of a template's tile in New Book. */
export function trimAspect(format: PrintFormat) {
  const { trim } = resolveFormat(format);
  return trim.width / trim.height;
}

/** Whether an image of this size would be cropped noticeably to fill a tile with the given aspect ratio. */
export function previewAspectMismatch(width: number, height: number, aspect: number) {
  return Math.abs(width / height - aspect) / aspect > previewAspectTolerance;
}

/** What the render frame learns about a declared preview from the app: the decoded image, or why it cannot be used. */
export type PreviewFileReport = { width: number; height: number; type: string; bytes: number } | { problem: string };
