import type { PhotosLocator } from '../src/source-locator';
import type { PhotosLibrary } from './photos-library';

/** The URL Photos opens a photo of its library at, by the UUID its local identifier starts with. */
export const photosAssetURL = (local: string) => 'photos://asset?identifier=' + encodeURIComponent(local.split('/')[0]);

/**
 * Show in Photos (ADR 0013): opens Photos at the first chosen photo, which it shows by itself. Nothing in the library
 * changes. The photo's local identifier is this Mac's, looked up by its cloud identifier where the locator has none or
 * one from before. Throws why it cannot be shown; returns what to tell the user when several were chosen.
 */
export async function showInPhotos(library: Pick<PhotosLibrary, 'status' | 'facts' | 'localIdentifiers'> | undefined, locators: readonly PhotosLocator[],
  open: (url: string) => Promise<void>): Promise<string | undefined> {
  if (!locators.length) throw new Error('Choose photos from Photos.');
  if (!library || library.status() !== 'authorized') throw new Error('ImageFlow may not read the Photos library. Allow it in Settings → Sources.');
  const [first] = locators;
  let local = first.local && (await library.facts([first.local]))[0] ? first.local : undefined;
  local ??= (await library.localIdentifiers([first.cloud]))[0] ?? undefined;
  if (!local) throw new Error('The photo is not in the Photos library on this Mac.');
  await open(photosAssetURL(local));
  return locators.length > 1 ? 'Photos shows one photo at a time: showing the first of ' + locators.length + '.' : undefined;
}
