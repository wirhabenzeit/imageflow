import { sourceFileName } from './source-locations';

/**
 * Where a photo comes from, as its `photos.json` entry records it (ADR 0011, Source providers). A locator never becomes
 * a photo ID (ADR 0005). This is the pure half of the provider contract: the book-state revision, sync snapshots and
 * the renderer read locators through a `LocatorKind` and never touch a provider's own fields. Reading pixels, facts
 * and changes is the other half, `SourceProvider` in desktop/source-provider.ts, which runs in the main process only.
 */
export type Locator = { provider: string };

/** The fields of a `photos.json` entry. A provider reads and writes the keys it names in `fields`; the rest are the host's. */
export type LocatorFields = Readonly<Record<string, unknown>>;

export interface LocatorKind<L extends Locator> {
  provider: L['provider'];
  /** The entry keys this provider writes. Changing a photo's provider removes them first (Copy into Book). */
  fields: readonly string[];
  /** The locator of an entry, or undefined when the entry is not this provider's. */
  read(entry: LocatorFields): L | undefined;
  /** The entry fields that record a locator, with exactly the keys of `fields` that apply. */
  write(locator: L): Record<string, unknown>;
  /**
   * The locator as the portable book-state revision counts it (ADR 0010, guardrail 5): equal on every Mac for the same
   * book state, so without anything machine-local.
   */
  portable(locator: L): Record<string, unknown>;
  /** The locator as a sync snapshot carries it to other Macs. */
  shared(locator: L): L;
  /** The locator a pull writes: this Mac's own (`here`) when it has one, so a pull never overwrites a local location. */
  adopt(shared: L, here: L | undefined): L;
  /** Tells two locators of this provider apart: import dedupe, the machine-local source index, approvals. */
  key(locator: L): string;
  /** A readable name for a photo without a title. */
  name(locator: L): string | undefined;
}

/** A file inside the book package's `photos/`, as a path relative to the book. The package is the host's own storage. */
export type PackageLocator = { provider: 'package'; path: string };
/** A file anywhere else on this Mac, as an absolute path. */
export type LinkedLocator = { provider: 'linked'; path: string };

const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? '';
// Where a linked photo from another Mac points until it is located here (see unlocatedPath in sync-snapshot.ts).
const unlocated = (name: string) => '/imageflow-unlocated/' + (baseName(name).replace(/[\x00-\x1f]/g, '-') || 'original');

// Both read the entry's `path`; `linked` decides whose entry it is, as it does in photos.json today.
export const packageLocator: LocatorKind<PackageLocator> = {
  provider: 'package',
  fields: ['path'],
  read: (entry) => typeof entry.path === 'string' && entry.linked !== true ? { provider: 'package', path: entry.path } : undefined,
  write: ({ path }) => ({ path }),
  portable: ({ path }) => ({ path }),
  shared: (locator) => locator,
  adopt: (shared) => shared,
  key: ({ path }) => path,
  name: (locator) => sourceFileName(locator),
};

export const linkedLocator: LocatorKind<LinkedLocator> = {
  provider: 'linked',
  fields: ['path', 'linked'],
  read: (entry) => typeof entry.path === 'string' && entry.linked === true ? { provider: 'linked', path: entry.path } : undefined,
  write: ({ path }) => ({ path, linked: true }),
  // Only that it is linked: the path is this Mac's.
  portable: () => ({ linked: true }),
  shared: (locator) => ({ ...locator, path: baseName(locator.path) }),
  adopt: (shared, here) => here ?? { ...shared, path: unlocated(shared.path) },
  key: ({ path }) => path,
  name: (locator) => sourceFileName(locator),
};
