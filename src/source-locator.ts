
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

// Imported and created files are stored as "<id>-<name>"; the readable name leaves the storage ID out.
export const readableFileName = (path: string) => (path.split('/').pop() ?? path).replace(/^(?:ph|tx|fl)-[a-f0-9-]{12}-/, '');
/** The file name of a path, with either separator. */
export const fileNameOf = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? '';
/**
 * Where a linked source that arrived from another Mac points until it is located here: an absolute path that does not
 * exist and is never approved, keeping the original's file name so Assets shows it and Locate Folder… can match it.
 */
export const unlocatedRoot = '/imageflow-unlocated/';
export const unlocatedPath = (name: string) => unlocatedRoot + (fileNameOf(name).replace(/[\x00-\x1f]/g, '-') || 'original');
export const isUnlocatedPath = (path: string) => path.startsWith(unlocatedRoot);

// Both read the entry's `path`; `linked` decides whose entry it is, as it does in photos.json today.
export const packageLocator: LocatorKind<PackageLocator> = {
  provider: 'package',
  // `linked: false` is a package entry too, so the key goes with the entry when its provider changes.
  fields: ['path', 'linked'],
  read: (entry) => typeof entry.path === 'string' && entry.linked !== true ? { provider: 'package', path: entry.path } : undefined,
  write: ({ path }) => ({ path }),
  portable: ({ path }) => ({ path }),
  shared: (locator) => locator,
  adopt: (shared) => shared,
  key: ({ path }) => path,
  name: ({ path }) => readableFileName(path),
};

export const linkedLocator: LocatorKind<LinkedLocator> = {
  provider: 'linked',
  fields: ['path', 'linked'],
  read: (entry) => typeof entry.path === 'string' && entry.linked === true ? { provider: 'linked', path: entry.path } : undefined,
  write: ({ path }) => ({ path, linked: true }),
  // Only that it is linked: the path is this Mac's.
  portable: () => ({ linked: true }),
  shared: (locator) => ({ ...locator, path: fileNameOf(locator.path) }),
  adopt: (shared, here) => here ?? { ...shared, path: unlocatedPath(shared.path) },
  key: ({ path }) => path,
  name: ({ path }) => readableFileName(path),
};

/** A photo that is a file on this Mac: the two locators the host reads in place. */
export type FileLocator = PackageLocator | LinkedLocator;
export const isFileLocator = (locator: Locator): locator is FileLocator => locator.provider === 'package' || locator.provider === 'linked';
/**
 * Any locator a photos.json entry can hold. The file locators are the only ones whose fields the host reads itself;
 * every other one is opaque to it and read only by its own kind and provider.
 */
export type PhotoLocator = Locator;

// The kinds this build reads, in the order they are asked. Method parameters are bivariant, so each kind stands in
// this list for every locator; each function below hands a kind only the locator that kind itself read or that names it.
const locatorKinds: LocatorKind<Locator>[] = [packageLocator, linkedLocator] as LocatorKind<Locator>[];
/**
 * Adds a kind of locator this build reads, and returns a function that removes it again. Every provider without a file
 * (ADR 0011) registers its kind here; until one ships, only tests do, with a provider that exists in memory only.
 */
export function registerLocatorKind<L extends Locator>(kind: LocatorKind<L>): () => void {
  if (locatorKinds.some(({ provider }) => provider === kind.provider)) throw new Error('The locator kind ' + kind.provider + ' is registered already.');
  locatorKinds.push(kind as unknown as LocatorKind<Locator>);
  return () => { const index = locatorKinds.indexOf(kind as unknown as LocatorKind<Locator>); if (index >= 0) locatorKinds.splice(index, 1); };
}
const kindOf = (locator: Locator) => {
  const kind = locatorKinds.find(({ provider }) => provider === locator.provider);
  if (!kind) throw new Error('This photo names no source this version of ImageFlow can read.');
  return kind;
};
/** The kind that reads a locator. */
export const locatorKindOf = (locator: Locator): LocatorKind<Locator> => kindOf(locator);

/** The locator of an entry, or undefined for an entry no provider of this version reads. */
export function readLocator(entry: LocatorFields): PhotoLocator | undefined {
  for (const kind of locatorKinds) { const locator = kind.read(entry); if (locator) return locator; }
}
/** The locator of an entry that passed `photoIndexSchema`. */
export function locatorOf(entry: LocatorFields): PhotoLocator {
  const locator = readLocator(entry);
  if (!locator) throw new Error('This photo names no source this version of ImageFlow can read.');
  return locator;
}
/** The file locator of an entry, or undefined for a photo that is not a file the host reads in place. */
export const fileLocatorOf = (entry: LocatorFields): FileLocator | undefined => { const locator = readLocator(entry); return locator && isFileLocator(locator) ? locator : undefined; };
/** Whether an entry names a file: a book whose photo index holds any other entry needs book format 4. */
export const namesFile = (entry: LocatorFields) => typeof entry.path === 'string';
/** A readable name of a photo without a title, from its locator; its ID when the locator offers none. */
export const locatorName = (id: string, locator: Locator) => kindOf(locator).name(locator) || id;
/** The path of a photo the book package holds, relative to the book; undefined for any other photo. */
export const packagePath = (entry: LocatorFields) => { const locator = fileLocatorOf(entry); return locator?.provider === 'package' ? locator.path : undefined; };

const without = (entry: LocatorFields, keys: readonly string[]) => Object.fromEntries(Object.entries(entry).filter(([key]) => !keys.includes(key)));
// An entry with its locator's fields replaced by others. Only the keys the locator occupies go, so whatever else the
// entry holds stays as it is.
function rewritten(entry: LocatorFields, fields: (kind: LocatorKind<Locator>, locator: Locator) => Record<string, unknown>) {
  const locator = readLocator(entry);
  if (!locator) return entry;
  const kind = kindOf(locator);
  return { ...without(entry, Object.keys(kind.write(locator))), ...fields(kind, locator) };
}
/** An entry as the portable book-state revision counts it. */
export const portableEntry = (entry: LocatorFields) => rewritten(entry, (kind, locator) => kind.portable(locator));
/** An entry as a sync snapshot carries it. */
export const sharedEntry = (entry: LocatorFields) => rewritten(entry, (kind, locator) => kind.write(kind.shared(locator)));
/** A snapshot's entry as a pull writes it, given the entry this Mac has for the photo. */
export const adoptedEntry = (shared: LocatorFields, here: LocatorFields | undefined) => rewritten(shared, (kind, locator) => {
  const mine = here && readLocator(here);
  return kind.write(kind.adopt(locator, mine?.provider === locator.provider ? mine : undefined));
});
/** An entry with another locator, of any provider, in place of its own. */
export function relocatedEntry<E extends LocatorFields>(entry: E, locator: PhotoLocator): E {
  const own = readLocator(entry);
  return { ...without(entry, own ? kindOf(own).fields : []), ...kindOf(locator).write(locator) } as unknown as E;
}
