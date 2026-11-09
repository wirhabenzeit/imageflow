import { uploadLimit } from './spread';
import type { Dimensions } from './spread';

export const photoDragType = 'application/x-senja-photo';
export const jpegAccept = 'image/jpeg,.jpg,.jpeg';

export type Photo = Dimensions & { original: File; previewUrl: string; thumbnailUrl: string };

export async function preparePhoto(original: File): Promise<Photo> {
  if (original.size > uploadLimit) {
    throw new Error('Choose a JPEG smaller than 50 MB.');
  }
  const signature = new Uint8Array(await original.slice(0, 3).arrayBuffer());
  if (signature[0] !== 255 || signature[1] !== 216 || signature[2] !== 255) {
    throw new Error('Choose a JPEG image.');
  }

  const bitmap = await createImageBitmap(original, { imageOrientation: 'from-image' });
  try {
    const { width, height } = bitmap;
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) throw new Error('The browser could not create a preview.');

    const resize = async (maxEdge: number, quality: number) => {
      const scale = Math.min(1, maxEdge / Math.max(width, height));
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const result = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
      if (!result) throw new Error('The browser could not create a preview.');
      return result;
    };

    const preview = await resize(2048, 0.9);
    const thumbnail = await resize(256, 0.82);
    return { original, previewUrl: URL.createObjectURL(preview), thumbnailUrl: URL.createObjectURL(thumbnail), width, height };
  } finally {
    bitmap.close();
  }
}
