import { canonicalJson } from './canonical-json';
import type { ProjectSummary } from './desktop';

/**
 * Curation marks a source provider's library keeps for a photo (ADR 0014): stars, pick and reject flags and colour
 * labels of Lightroom Classic, favourites of Apple Photos. A provider records them as keys of `AssetFact.extra`, and
 * declares here which keys they are and what they mean, in a small vocabulary the host owns. The host draws, lists and
 * filters by them the same way for every provider. They are read-only, never reach a template and are no part of the
 * book-state revision. Pure module: no host APIs.
 *
 * The keys a spec reads (`rating`, `flag`, `color`, `colorLabel`, `favorite`) are reserved for that meaning; every
 * other key of `extra` stays the provider's own, which the host does not read.
 */
export const sourceColors = ['red', 'yellow', 'green', 'blue', 'purple'] as const;
export type SourceColor = typeof sourceColors[number];

export type SourceBadgeMark =
  | { kind: 'stars'; value: 1 | 2 | 3 | 4 | 5 }
  | { kind: 'heart' }
  | { kind: 'flag'; value: 'pick' | 'reject' }
  /** `label` is the library's own name for the colour where it differs from the colour's (a custom label set). */
  | { kind: 'color'; value: SourceColor; label?: string };

export type SourcePropertySpec = {
  /** Stable key used in PhotoView persistence, commands and filters, e.g. 'lightroom:rating'. */
  id: string;
  /** The mark this property reads. It decides the overlay, the Inspector row and the filter control. */
  kind: SourceBadgeMark['kind'];
  /** Label inside View → <Provider> → … */
  viewLabel: string;
  /** Overlay visibility while the user has not toggled this property. */
  defaultVisible: boolean;
  /** Label in the photo Inspector's facts list. */
  inspectorLabel: string;
  /** The mark in `AssetFact.extra`; undefined when unset or not a value of the vocabulary. */
  read(extra: Record<string, unknown> | undefined): SourceBadgeMark | undefined;
};

/** One provider's properties: its label heads the View submenu and the Filter section. */
export type SourceProviderProperties = { provider: string; label: string; properties: readonly SourcePropertySpec[] };

const isColor = (value: unknown): value is SourceColor => (sourceColors as readonly unknown[]).includes(value);

export const sourceProperties: readonly SourceProviderProperties[] = [
  { provider: 'lightroom', label: 'Lightroom Classic', properties: [
    { id: 'lightroom:rating', kind: 'stars', viewLabel: 'Show Stars', defaultVisible: true, inspectorLabel: 'Rating',
      read: (extra) => { const value = extra?.rating; return value === 1 || value === 2 || value === 3 || value === 4 || value === 5 ? { kind: 'stars', value } : undefined; } },
    { id: 'lightroom:flag', kind: 'flag', viewLabel: 'Show Flags', defaultVisible: true, inspectorLabel: 'Flag',
      read: (extra) => { const value = extra?.flag; return value === 'pick' || value === 'reject' ? { kind: 'flag', value } : undefined; } },
    { id: 'lightroom:color', kind: 'color', viewLabel: 'Show Color Labels', defaultVisible: false, inspectorLabel: 'Color label',
      read: (extra) => {
        const value = extra?.color, label = extra?.colorLabel;
        if (!isColor(value)) return undefined;
        return { kind: 'color', value, ...(typeof label === 'string' && label.trim() && label.trim().toLowerCase() !== value ? { label: label.trim() } : {}) };
      } },
  ] },
  { provider: 'photos', label: 'Apple Photos', properties: [
    { id: 'photos:favorite', kind: 'heart', viewLabel: 'Show Favorites', defaultVisible: true, inspectorLabel: 'Favorite',
      read: (extra) => extra?.favorite === true ? { kind: 'heart' } : undefined },
  ] },
];

/** The properties a provider declares, or undefined for one that declares none (`package`, `linked`). */
export const propertiesOf = (provider: string | undefined) => sourceProperties.find((entry) => entry.provider === provider);
export const propertySpec = (id: string) => sourceProperties.flatMap(({ properties }) => properties).find((spec) => spec.id === id);

export type PhotoMark = { spec: SourcePropertySpec; mark: SourceBadgeMark };
/** The marks a photo of `provider` has, in the order its provider declares them. */
export function readPhotoMarks(provider: string | undefined, extra: Record<string, unknown> | undefined): PhotoMark[] {
  return (propertiesOf(provider)?.properties ?? []).flatMap((spec) => { const mark = spec.read(extra); return mark ? [{ spec, mark }] : []; });
}

/**
 * A photo's declared properties as one string: equal for equal marks, whatever else `extra` holds, and '' for a photo
 * without any. Change detection (desktop/provided-photos.ts) and sync (`SyncedCommit.localProps`) compare it.
 */
export function declaredProperties(provider: string | undefined, extra: Record<string, unknown> | undefined): string {
  const marks = readPhotoMarks(provider, extra);
  return marks.length ? canonicalJson(Object.fromEntries(marks.map(({ spec, mark }) => [spec.id, mark]))) : '';
}

/**
 * The keys of `extra` that hold `provider`'s declared properties, with their values as they are in `extra`, left out
 * where `read` gives no mark. Sync carries these, and nothing else of a fact, from a Mac whose content did not change.
 */
const reservedKeys = ['rating', 'flag', 'color', 'colorLabel', 'favorite'] as const;
export function declaredExtra(provider: string | undefined, extra: Record<string, unknown> | undefined): Record<string, unknown> {
  const marks = readPhotoMarks(provider, extra);
  const result: Record<string, unknown> = {};
  for (const { mark } of marks) {
    if (mark.kind === 'stars') result.rating = mark.value;
    else if (mark.kind === 'flag') result.flag = mark.value;
    else if (mark.kind === 'heart') result.favorite = true;
    else { result.color = mark.value; if (mark.label) result.colorLabel = mark.label; }
  }
  return result;
}
/** `extra` with every reserved key replaced by `declared` (one provider's, from `declaredExtra`); undefined when nothing is left. */
export function withDeclaredExtra(extra: Record<string, unknown> | undefined, declared: Record<string, unknown>): Record<string, unknown> | undefined {
  const rest = Object.fromEntries(Object.entries(extra ?? {}).filter(([key]) => !(reservedKeys as readonly string[]).includes(key)));
  const merged = { ...rest, ...declared };
  return Object.keys(merged).length ? merged : undefined;
}

/** The providers among `providers` that declare properties, in the order of `sourceProperties`. */
export function activeProvidersOf(providers: Iterable<string | undefined>): SourceProviderProperties[] {
  const present = new Set(providers);
  return sourceProperties.filter(({ provider }) => present.has(provider));
}

/** The provider of a book's photo (`package`, `linked`, `lightroom`, `photos`), as its source entry names it. */
export function photoProvider(summary: Pick<ProjectSummary, 'sources'>, id: string): string | undefined {
  const entry = summary.sources?.['photo:' + id];
  return entry?.kind === 'photo' ? entry.locator.provider : undefined;
}
/** The marks of a book's photo, read through its own provider's specs from what the summary hands over. */
export const bookPhotoMarks = (summary: Pick<ProjectSummary, 'sources' | 'photoExtra'>, id: string) =>
  readPhotoMarks(photoProvider(summary, id), summary.photoExtra?.[id]);
/** The providers of a book's photos, sorted: what the View menus offer a submenu for (`BookMenuState.photoProviders`). */
export function bookPhotoProviders(summary: Pick<ProjectSummary, 'sources' | 'photoIndex'>): string[] {
  return [...new Set(Object.keys(summary.photoIndex).flatMap((id) => photoProvider(summary, id) ?? []))].sort();
}

export const sourceColorNames: Record<SourceColor, string> = { red: 'Red', yellow: 'Yellow', green: 'Green', blue: 'Blue', purple: 'Purple' };
/**
 * How the host writes a mark (ADR 0014, sections 4 and 6): `glyph` on a thumbnail (filled stars only), `label` as its
 * accessible name, `title` as its tooltip (with a custom colour label's own name), and `value` and `valueLabel` for
 * the Inspector row, where stars show the empty slots too.
 */
export function markText(mark: SourceBadgeMark): { glyph: string; label: string; title: string; value: string; valueLabel: string } {
  if (mark.kind === 'stars') {
    const label = mark.value + ' of 5 stars';
    return { glyph: '★'.repeat(mark.value), label, title: label, value: '★'.repeat(mark.value) + '☆'.repeat(5 - mark.value), valueLabel: label };
  }
  if (mark.kind === 'heart') return { glyph: '♥', label: 'Favorite', title: 'Favorite', value: 'Yes', valueLabel: 'Yes' };
  if (mark.kind === 'flag') {
    const label = mark.value === 'pick' ? 'Picked' : 'Rejected';
    return { glyph: mark.value === 'pick' ? '⚑' : '✕', label, title: label, value: label, valueLabel: label };
  }
  const name = sourceColorNames[mark.value], value = name + (mark.label ? ' (' + mark.label + ')' : '');
  return { glyph: '', label: name + ' label', title: name + ' label' + (mark.label ? ': ' + mark.label : ''), value, valueLabel: value };
}

/** What one property filters by: a minimum rating, favourites only, one flag choice, or any of some colours. */
export type PropertyFilterValue = number | true | 'pick' | 'not-reject' | 'reject' | readonly SourceColor[];
export type PhotoFilter = {
  placement?: 'all' | 'unused' | 'used';
  /** The providers whose photos are shown (`package`, `linked`, `lightroom`, `photos`); none or empty shows all. */
  sources?: readonly string[];
  /** By spec ID. A provider's filters are asked of that provider's photos only. */
  properties?: Readonly<Record<string, PropertyFilterValue>>;
};
export type FilteredPhoto = { provider: string | undefined; extra?: Record<string, unknown>; used: boolean };

function passes(mark: SourceBadgeMark | undefined, kind: SourceBadgeMark['kind'], value: PropertyFilterValue): boolean {
  if (kind === 'stars') return typeof value !== 'number' || !(value >= 1) || (mark?.kind === 'stars' && mark.value >= value);
  if (kind === 'heart') return value !== true || mark?.kind === 'heart';
  if (kind === 'flag') {
    const flag = mark?.kind === 'flag' ? mark.value : undefined;
    return value === 'pick' ? flag === 'pick' : value === 'reject' ? flag === 'reject' : value === 'not-reject' ? flag !== 'reject' : true;
  }
  return !Array.isArray(value) || !value.length || (mark?.kind === 'color' && value.includes(mark.value));
}

/**
 * Whether a photo is shown under a filter (ADR 0014, section 5). It must pass the placement, then the sources, then
 * the property filters of its own provider, all of them. A provider's filters are never asked of another source's
 * photo: with a minimum rating set for Lightroom Classic, every photo of another source is shown as before.
 */
export function photoFilterPredicate(filter: PhotoFilter): (photo: FilteredPhoto) => boolean {
  const sources = filter.sources?.length ? new Set(filter.sources) : undefined;
  const entries = Object.entries(filter.properties ?? {});
  return ({ provider, extra, used }) => {
    if (filter.placement === 'unused' && used) return false;
    if (filter.placement === 'used' && !used) return false;
    if (sources && !sources.has(provider ?? '')) return false;
    const own = propertiesOf(provider)?.properties ?? [];
    return entries.every(([id, value]) => { const spec = own.find((entry) => entry.id === id); return !spec || passes(spec.read(extra), spec.kind, value); });
  };
}
