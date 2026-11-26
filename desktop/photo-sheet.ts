import sharp from 'sharp';
import { photoSheetLayout } from '../src/authoring-artwork';
import type { PhotoSheetMetadata, PhotoSheetRequest } from '../src/photo-sheet';
import type { OpenProject } from './project';
import { photoFile } from './photos';

type SheetPhoto = { id: string; captured?: string };
const escape = (text: string) => text.replace(/[&<>"]/g, (character) => '&#' + character.charCodeAt(0) + ';')
  // Control characters have no place in XML, however they are written.
  .replace(/[\u0000-\u001f\u007f]/g, ' ');
// About half a letter's height is its width; text that does not fit keeps its start and end, which tell IDs apart.
// Every label is fitted to its cell, so none runs into the next.
export function fitted(text: string, width: number, size: number) {
  const room = Math.max(3, Math.floor(width / (size * 0.58)));
  if (text.length <= room) return text;
  const kept = room - 1, start = Math.ceil(kept / 2);
  return text.slice(0, start) + '…' + text.slice(text.length - (kept - start));
}

/**
 * A contact sheet of photos of the book, whether placed or not, uncropped and labelled with their IDs and capture times
 * (API-015). It is drawn from the photos' renditions, so it needs neither the template nor a render of the book, and a
 * photo without pixels here, such as one whose preview is loading, is an empty cell that says why.
 */
export async function photoSheet(book: Pick<OpenProject, 'photos' | 'sources' | 'unavailablePhotos'>, photos: readonly SheetPhoto[],
  { columns, maxEdge, format }: PhotoSheetRequest, signal: AbortSignal) {
  const loaded = photos.map(({ id }) => book.photos.get(id));
  // The size the photo is shown with, also of one that cannot be drawn now.
  const grid = photoSheetLayout(photos.map(({ id }, index) => loaded[index] ?? book.unavailablePhotos?.[id]), maxEdge, columns);
  const missing = new Map<number, string>();
  const pictures = await Promise.all(grid.cells.map(async ({ x, y, width, height }, index) => {
    const photo = loaded[index];
    try {
      if (!photo) throw new Error(book.sources?.['photo:' + photos[index].id]?.problem ?? 'The photo is not available.');
      // As the editor shows it, from the same kept renditions: thumbnails have up to 240 pixels.
      const file = await photoFile(photo, Math.max(width, height) <= 240 ? 'thumb' : 'preview');
      signal.throwIfAborted();
      return { input: await sharp(file).resize({ width, height, fit: 'fill' }).flatten({ background: '#ffffff' }).toBuffer(), left: x, top: y };
    } catch (error) {
      signal.throwIfAborted();
      missing.set(index, error instanceof Error ? error.message : String(error));
      return undefined;
    }
  }));
  const text = (content: string, x: number, y: number, color: string, size: number, weight = 'normal') =>
    '<text x="' + x + '" y="' + y + '" font-family="Helvetica, Arial, sans-serif" font-size="' + size + '" font-weight="' + weight +
    '" text-anchor="middle" fill="' + color + '">' + escape(content) + '</text>';
  const overlay = grid.cells.map(({ x, y, width, height, label }, index) => {
    const { id, captured } = photos[index], middle = label.x + label.width / 2;
    const reason = missing.get(index);
    return (reason === undefined ? '' : '<rect x="' + x + '" y="' + y + '" width="' + width + '" height="' + height + '" fill="#d0d0d0"/>' +
      text(fitted(fitted(reason, width, label.size) === reason ? reason : 'Not available', width, label.size), x + width / 2, y + height / 2, '#555555', label.size)) +
      text(fitted(id, label.width, label.size), middle, label.y + label.line * 0.85, '#111111', label.size, 'bold') +
      text(fitted(captured?.replace('T', ' ') ?? 'No capture time', label.width, label.size), middle, label.y + label.line * 1.85, '#444444', label.size);
  }).join('');
  const sheet = sharp({ create: { width: grid.width, height: grid.height, channels: 3, background: '#e9e9e9' } }).composite([
    ...pictures.filter((picture) => picture !== undefined),
    { input: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="' + grid.width + '" height="' + grid.height + '">' + overlay + '</svg>'), left: 0, top: 0 },
  ]);
  const bytes = await (format === 'png' ? sheet.png() : sheet.jpeg({ quality: 85 })).toBuffer();
  signal.throwIfAborted();
  const metadata: PhotoSheetMetadata = { kind: 'photo-sheet', width: grid.width, height: grid.height, columns: grid.columns,
    cells: grid.cells.map(({ x, y, width, height }, index) => ({ photo: photos[index].id, x, y, width, height,
      ...(missing.has(index) ? { missing: missing.get(index)! } : {}) })) };
  return { ...metadata, mimeType: format === 'png' ? 'image/png' as const : 'image/jpeg' as const, data: bytes.toString('base64') };
}
