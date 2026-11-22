import { canonicalJson } from './canonical-json';
import type { PhotoIndex, Project } from './project';
import { portableEntry } from './source-locator';

/**
 * The portable book-state revision (ADR 0010, Guardrail 5): a hash of what the user authored, identical on every Mac
 * and in the browser for the same book state. It is not the local render-input revision of `desktop/revisions.ts`.
 *
 * It covers the canonical JSON of `project.json` and `photos.json` and the SHA-256 digests of the book's `texts/`,
 * `files/` and `template/` files: for `texts/` and `files/` only the owned files that `project.json` references (bytes an
 * undo may restore but nothing references do not count), and, like linked photo bytes, never the content of linked texts
 * and files. It leaves out what differs per machine or is derived: the absolute paths of linked
 * sources (`{ path, linked: true }`: only the fact that they are linked counts), local availability, the originals'
 * bytes and `assets-meta.json`. Pure and host-agnostic: it uses Web Crypto, in Node 22+ and every browser.
 */
export type BookStateInputs = {
  project: Project;
  photos: PhotoIndex;
  /** SHA-256 hex digests of the referenced owned files of `texts/` and `files/`, and of every file of `template/`, by path relative to the book, with `/`. */
  contentDigests: Record<string, string>;
};

const revisionVersion = 'imageflow-book-state-1';

// A linked reference keeps `linked: true` and loses its machine-local path.
const portableReference = (reference: unknown) => reference !== null && typeof reference === 'object' && (reference as { linked?: unknown }).linked === true
  ? { linked: true } : reference;
const portableReferences = (references: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(references).map(([id, reference]) => [id, portableReference(reference)]));

/** `project.json` as the revision sees it: linked text and file references without their paths. */
export const portableProject = (project: Project) => ({ ...project, texts: portableReferences(project.texts), files: portableReferences(project.files) });

/** `photos.json` as the revision sees it: linked photos without their paths. */
export const portablePhotos = (photos: PhotoIndex) => Object.fromEntries(Object.entries(photos).map(([id, photo]) => [id, portableEntry(photo)]));

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');

export async function computeBookStateRevision({ project, photos, contentDigests }: BookStateInputs): Promise<string> {
  const text = canonicalJson({ version: revisionVersion, project: portableProject(project), photos: portablePhotos(photos), content: contentDigests });
  return hex(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}
