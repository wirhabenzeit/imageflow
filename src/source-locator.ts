import { sourceFileName } from './source-locations';

/**
 * Where a photo comes from, as its `photos.json` entry records it (ADR 0011, Source providers). A locator never becomes
 * a photo ID (ADR 0005). This is the pure half of the provider contract: the book-state revision, sync snapshots and
 * the renderer read locators through a `LocatorKind` and never touch a provider's own fields. Reading pixels, facts
 * and changes is the other half, `SourceProvider` in desktop/source-provider.ts, which runs in the main process only.
 */
export type Locator = { provider: string };

/** The fields of a `photos.json` entry. Each provider owns the keys it names in `fields`; the rest are the host's. */
export type LocatorFields = Readonly<Record<string, unknown>>;

export interface LocatorKind<L extends Locator> {
  provider: L['provider'];
  /** The entry keys this provider owns. Changing a photo's provider removes them (Copy into Book). */
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
  /** Whether the book package holds the original's bytes, so they sync as originals and the source can be renamed. */
  owned(locator: L): boolean;
}

/** A file: inside the package's `photos/` (owned, a relative path) or anywhere else on this Mac (linked, absolute). */
export type LocalLocator = { provider: 'local'; path: string; linked: boolean };

const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? '';
// Where a linked photo from another Mac points until it is located here (see unlocatedPath in sync-snapshot.ts).
const unlocated = (name: string) => '/imageflow-unlocated/' + (baseName(name).replace(/[\x00-\x1f]/g, '-') || 'original');

export const localLocator: LocatorKind<LocalLocator> = {
  provider: 'local',
  fields: ['path', 'linked'],
  read: (entry) => typeof entry.path === 'string' ? { provider: 'local', path: entry.path, linked: entry.linked === true } : undefined,
  write: ({ path, linked }) => linked ? { path, linked: true } : { path },
  portable: ({ path, linked }) => linked ? { linked: true } : { path },
  shared: (locator) => locator.linked ? { ...locator, path: baseName(locator.path) } : locator,
  adopt: (shared, here) => !shared.linked ? shared : here?.linked ? here : { ...shared, path: unlocated(shared.path) },
  key: ({ path }) => path,
  name: (locator) => sourceFileName(locator),
  owned: ({ linked }) => !linked,
};
