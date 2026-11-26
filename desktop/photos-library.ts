import { join } from 'node:path';

/**
 * The PhotoKit addon (desktop/native/photos.mm) as the Apple Photos provider and the import of drags from Photos use
 * it (ADR 0013). Errors carry `code`, `<domain>:<code>` of the NSError: `PHPhotosErrorDomain:3169` for a network error,
 * `ImageFlowPhotos:3072` for a cancelled request, `ImageFlowPhotos:3311` without access. `underlying` is the network
 * error an iCloud download failed with, such as `NSURLErrorDomain:-1009` without a connection.
 */
export type PhotosAccess = 'authorized' | 'notDetermined' | 'denied' | 'restricted' | 'limited' | 'unsupported-system' | 'unsupported-build';
/** A photo's facts as PhotoKit reports them; times in ms since 1970. */
export type PhotosFacts = {
  width: number; height: number; created?: number; latitude?: number; longitude?: number;
  /**
   * The UTC offset the photo was taken at, in minutes: its original's own (EXIF) once the addon has read it, or its
   * place's where the original is not on this Mac or records none. Until then, and where neither tells, this Mac's
   * offset at that instant, and `offsetGuessed` is true.
   */
  offsetMinutes?: number; offsetGuessed?: boolean;
  /** The last edit or revert, or null for a photo never edited; absent before macOS 15. */
  adjusted?: number | null;
  base?: 'raw' | 'compressed'; caption?: string; keywords?: string[]; filename?: string; type?: string;
  /** True for a favourite, absent otherwise. */
  favorite?: boolean;
};
/** A photo of the last drag from Photos: `mediaType` is PhotoKit's, 1 for an image and 2 for a video. */
export type DraggedPhoto = { localIdentifier: string; file: string | null; library: string | null; mediaType?: number | null };
export interface PhotosLibrary {
  status(): PhotosAccess;
  requestAccess(): Promise<PhotosAccess>;
  dragged(): { changeCount: number; items: DraggedPhoto[] };
  cloudIdentifiers(locals: readonly string[]): Promise<(string | null)[]>;
  localIdentifiers(clouds: readonly string[]): Promise<(string | null)[]>;
  facts(locals: readonly string[]): Promise<(PhotosFacts | null)[]>;
  image(local: string, options: { file: string; full: boolean; id: number }, progress?: (fraction: number) => void): Promise<{ width: number; height: number }>;
  cancel(id: number): void;
  onChanges(listener: (locals: string[]) => void): void;
  track(locals: readonly string[]): void;
  /** Shows the system photo picker as a sheet on the window of Electron's native view handle; [] on Cancel. */
  pick(window: Buffer): Promise<string[]>;
  /** Closes the picker, which then answers []: for its window closing while it is open. */
  cancelPick(): void;
}

let loaded: PhotosLibrary | null | undefined;
/** The addon, or undefined where it is not built (another platform) or does not load. */
export function photosLibrary(): PhotosLibrary | undefined {
  if (loaded === undefined) {
    try { loaded = process.platform === 'darwin' ? require(join(__dirname, 'native', 'photos.node')) as PhotosLibrary : null; }
    catch (error) { console.warn('ImageFlow could not load its Photos library addon:', error instanceof Error ? error.message : error); loaded = null; }
  }
  return loaded ?? undefined;
}

/** The part of a path that names a Photos library bundle, if the path is inside one. */
export const photosLibraryOf = (path: string) => /^(.*?\.photoslibrary)(?:\/|$)/i.exec(path)?.[1];
