import { resolve } from 'node:path';
import type { PhotosLocator } from '../src/source-locator';
import { isPhotosIdentifier } from '../src/source-locator';
import { photosLibraryOf } from './photos-library';
import type { DraggedPhoto, PhotosAccess, PhotosLibrary } from './photos-library';

/**
 * Photos dragged from Apple Photos (ADR 0013). A drop from Photos hands a web view a small JPEG that Photos writes for
 * each photo inside its library (1024 px for a 12 MP photo), never the photo: imported as a file, it would print at a
 * fraction of its resolution, and linked, it would point into a library Photos rewrites. The photo itself is named on
 * the system drag pasteboard, which keeps the last drag until the next one, so the main process reads it there and
 * links each dropped photo through the Apple Photos provider. Files from inside a Photos library that no drag names
 * are refused rather than imported.
 */

export type PhotosDrop = { locators: PhotosLocator[]; rest: string[] };
type Access = 'granted' | 'denied';

const same = (a: string, b: string) => resolve(a).normalize('NFC') === resolve(b).normalize('NFC');

/**
 * The dragged photo each path from inside a Photos library is the picture of, in order, or undefined for one no
 * dragged photo names. Only the last drag counts, and only a drag of exactly these pictures: a drag that held others
 * as well, or fewer, is another drag.
 */
export function matchDragged(paths: readonly string[], dragged: readonly DraggedPhoto[]): (DraggedPhoto | undefined)[] {
  return paths.map((path) => dragged.find(({ file }) => !!file && same(file, path)));
}

export class PhotosDropError extends Error {
  constructor(message: string) { super(message); this.name = 'PhotosDropError'; }
}
const exportHint = ' To use them anyway, export them from Photos (File → Export) and import the files.';

/**
 * Splits dropped paths into photos to link from the Photos library and the files that are left. `allow` asks the user
 * to give ImageFlow access in System Settings, where it was refused before; it answers whether access is given now.
 */
export async function photosDrop(paths: readonly string[], library: PhotosLibrary | undefined, allow: (access: PhotosAccess) => Promise<Access>): Promise<PhotosDrop> {
  const fromPhotos = paths.filter((path) => photosLibraryOf(path));
  const rest = paths.filter((path) => !photosLibraryOf(path));
  if (!fromPhotos.length) return { locators: [], rest };
  const noun = fromPhotos.length === 1 ? 'This photo comes' : 'These photos come';
  const status = library?.status();
  if (!library || status === 'unsupported-build') throw new PhotosDropError(noun + ' from the Photos library, which this build of ImageFlow cannot read.' + exportHint);
  if (status === 'unsupported-system') throw new PhotosDropError(noun + ' from the Photos library. Linking photos from Photos needs macOS 15 or later.' + exportHint);
  const matched = matchDragged(fromPhotos, library.dragged().items);
  if (matched.some((item) => !item)) {
    throw new PhotosDropError(noun + ' from inside the Photos library, as small copies Photos keeps for itself. Drag ' + (fromPhotos.length === 1 ? 'it' : 'them') + ' from the Photos app instead.');
  }
  await requireAccess(library, allow, fromPhotos.length === 1 ? 'this photo' : 'these photos');
  const locators = await photosLocators(library, matched.map((item) => item!.localIdentifier));
  if (!locators.length) throw new PhotosDropError((fromPhotos.length === 1 ? 'This item' : 'These items') + ' from Photos cannot be linked: only still photos can.');
  return { locators, rest };
}

/** Asks for access where it was never asked, else has the user give it in System Settings; throws without it. */
export async function requireAccess(library: PhotosLibrary, allow: (access: PhotosAccess) => Promise<Access>, what: string) {
  const status = library.status();
  const access: PhotosAccess = status === 'notDetermined' ? await library.requestAccess() : status;
  if (access !== 'authorized' && await allow(access) !== 'granted') {
    throw new PhotosDropError('ImageFlow may not read the Photos library, so it cannot link ' + what + '. Allow it in System Settings → Privacy & Security → Photos.');
  }
}

/** Locators of still photos of the library by their local identifiers, in order; videos and photos gone are left out. */
export async function photosLocators(library: PhotosLibrary, localIds: readonly string[]): Promise<PhotosLocator[]> {
  const locals = [...new Set(localIds)];
  const [clouds, facts] = await Promise.all([library.cloudIdentifiers(locals), library.facts(locals)]);
  return locals.flatMap((local, index): PhotosLocator[] => {
    const cloud = clouds[index];
    if (!facts[index] || !cloud || !isPhotosIdentifier(cloud)) return [];
    const name = facts[index]!.filename;
    return [{ provider: 'photos', cloud, ...(isPhotosIdentifier(local) ? { local } : {}), ...(name ? { name } : {}) }];
  });
}
