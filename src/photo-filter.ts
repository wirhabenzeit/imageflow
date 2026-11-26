import { photoFilterPredicate, propertySpec, sourceColorNames, sourceProperties } from './source-properties';
import type { PhotoFilter, PropertyFilterValue, SourceColor, SourcePropertySpec, SourceProviderProperties } from './source-properties';
import { sourceLinked } from './source-locations';
import { readLocator } from './source-locator';
import { sourceList } from './source-items';
import type { SourceKind, SourceRef } from './source-items';
import type { PhotoView } from './photo-view';
import type { ProjectSummary } from './desktop';
import type { SourceUsage } from './editing';

/**
 * The Filter popover's state and its chips (ADR 0014, section 5), without React: what is in effect, what a click
 * changes, which chips show and what they say, and what goes when a source leaves the book. The Sources strip and
 * Manage Assets each keep a `PhotoFilter` of their own and change it only through these, so both read the same.
 * Pure module: no host APIs.
 */

/** The sources a Source pill can name, in the order the pills show them. */
export const filterSourceOrder = ['package', 'linked', 'lightroom', 'photos'] as const;
const sourceLabels: Record<string, string> = { package: 'In Book', linked: 'Linked', lightroom: 'Lightroom Classic', photos: 'Apple Photos' };
export const filterSourceLabel = (source: string) => sourceLabels[source] ?? 'Other';
/** The distinct sources among `sources`, in pill order; one this build does not name comes last. */
export function orderedSources(sources: Iterable<string | undefined>): string[] {
  const present = new Set([...sources].filter((source): source is string => !!source));
  const rank = (source: string) => { const at = (filterSourceOrder as readonly string[]).indexOf(source); return at < 0 ? filterSourceOrder.length : at; };
  return [...present].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/** Whether a property filter's value narrows anything: no minimum, `Any`, or no colour is the same as none. */
export function inEffect(spec: SourcePropertySpec | undefined, value: PropertyFilterValue | undefined): boolean {
  if (!spec || value === undefined) return false;
  if (spec.kind === 'stars') return typeof value === 'number' && value >= 1 && value <= 5;
  if (spec.kind === 'heart') return value === true;
  if (spec.kind === 'flag') return value === 'pick' || value === 'reject' || value === 'not-reject';
  return Array.isArray(value) && value.length > 0;
}

/** The filter without values that narrow nothing, so a filter set back by hand reads as no filter. */
export function cleanFilter(filter: PhotoFilter): PhotoFilter {
  const properties = Object.fromEntries(Object.entries(filter.properties ?? {}).filter(([id, value]) => inEffect(propertySpec(id), value)));
  return {
    ...(filter.placement && filter.placement !== 'all' ? { placement: filter.placement } : {}),
    ...(filter.sources?.length ? { sources: [...filter.sources] } : {}),
    ...(Object.keys(properties).length ? { properties } : {}),
  };
}

/**
 * Whether anything is set: what highlights the Filter button and enables Clear Filters. A provider's filters resting
 * while its Source pill is off count, since Clear Filters clears them too.
 */
export function filterActive(filter: PhotoFilter): boolean {
  const clean = cleanFilter(filter);
  return !!(clean.placement || clean.sources || clean.properties);
}

/**
 * The providers whose sections the popover shows: those among `present` (the providers of the photos shown on this
 * tab) that declare properties and are not left out by the Source pills. Their filters are the ones in effect.
 */
export function shownProviders(filter: PhotoFilter, present: Iterable<string | undefined>): SourceProviderProperties[] {
  const selected = filter.sources?.length ? new Set(filter.sources) : undefined;
  const here = new Set(present);
  return sourceProperties.filter(({ provider }) => here.has(provider) && (!selected || selected.has(provider)));
}

/**
 * The filter for the sources the book now holds: a Source pill of a source that left the book goes, and so does a
 * provider's every property filter once none of its photos is left. With fewer than two sources there are no pills,
 * so the Source filter goes too. Returns the same object when nothing changes, so a state update can be skipped.
 */
export function fitFilter(filter: PhotoFilter, present: Iterable<string | undefined>): PhotoFilter {
  const here = new Set([...present].filter(Boolean));
  const sources = here.size < 2 ? [] : (filter.sources ?? []).filter((source) => here.has(source));
  const properties = Object.entries(filter.properties ?? {}).filter(([id]) => { const provider = filterProvider(id); return !!provider && here.has(provider); });
  if (sources.length === (filter.sources?.length ?? 0) && properties.length === Object.keys(filter.properties ?? {}).length) return filter;
  return cleanFilter({ ...filter, sources, properties: Object.fromEntries(properties) });
}

export const setPlacement = (filter: PhotoFilter, placement: PhotoFilter['placement']) => cleanFilter({ ...filter, placement });
export function toggleSource(filter: PhotoFilter, source: string): PhotoFilter {
  const sources = filter.sources ?? [];
  return cleanFilter({ ...filter, sources: sources.includes(source) ? sources.filter((entry) => entry !== source) : [...sources, source] });
}
/** One property's value; undefined clears it. The other properties' values stay, also those of a resting provider. */
export function setProperty(filter: PhotoFilter, id: string, value: PropertyFilterValue | undefined): PhotoFilter {
  const { [id]: _, ...rest } = filter.properties ?? {};
  return cleanFilter({ ...filter, properties: value === undefined ? rest : { ...rest, [id]: value } });
}
/** A click on a star of the rating row: that minimum, or none when it is the minimum already. */
export const clickStar = (filter: PhotoFilter, id: string, stars: number) => setProperty(filter, id, filter.properties?.[id] === stars ? undefined : stars);
export function toggleColor(filter: PhotoFilter, id: string, color: SourceColor): PhotoFilter {
  const value = filter.properties?.[id];
  const colors = Array.isArray(value) ? value as readonly SourceColor[] : [];
  return setProperty(filter, id, colors.includes(color) ? colors.filter((entry) => entry !== color) : [...colors, color]);
}

/** The provider a property filter belongs to. */
export const filterProvider = (id: string) => sourceProperties.find(({ properties }) => properties.some((spec) => spec.id === id))?.provider;

const joinOr = (names: string[]) => names.length < 2 ? names.join('') : names.slice(0, -1).join(', ') + ' or ' + names[names.length - 1];
/**
 * How a property filter reads: `label` short, on its chip after the provider's icon, and `scope` with the provider's
 * photos named, for the chip's tooltip and accessible name (`Lightroom Classic photos: 3 stars or more`).
 */
export function propertyFilterText(spec: SourcePropertySpec, value: PropertyFilterValue, providerLabel: string): { label: string; scope: string } {
  const scoped = (text: string) => providerLabel + ' photos: ' + text;
  if (spec.kind === 'stars') {
    const stars = value as number;
    return { label: '★'.repeat(stars) + (stars < 5 ? '+' : ''), scope: scoped(stars + (stars === 1 ? ' star' : ' stars') + (stars < 5 ? ' or more' : '')) };
  }
  if (spec.kind === 'heart') return { label: '♥ Favorites', scope: scoped('favorites only') };
  if (spec.kind === 'flag') {
    const label = value === 'pick' ? 'Picked' : value === 'reject' ? 'Rejected' : 'Not Rejected';
    return { label, scope: scoped(value === 'pick' ? 'picked only' : value === 'reject' ? 'rejected only' : 'not rejected') };
  }
  const names = (value as readonly SourceColor[]).map((color) => sourceColorNames[color]);
  return { label: names.join(', '), scope: scoped(joinOr(names.map((name) => name.toLowerCase())) + ' label') };
}

/** One chip: its text, the tooltip and accessible name, the source's icon it starts with, and the filter without it. */
export type FilterChip = { key: string; label: string; title: string; origins?: string[]; remove: (filter: PhotoFilter) => PhotoFilter };

/**
 * The chips of a filter, in the popover's order: placement, sources, then each shown provider's properties. A
 * provider's chips show only while its section does (`providers`, from `shownProviders`): a resting filter has none.
 * `noun` names what the list holds (`photos`, `texts`, `assets`).
 */
export function filterChips(filter: PhotoFilter, providers: readonly SourceProviderProperties[], noun = 'photos'): FilterChip[] {
  const clean = cleanFilter(filter);
  const chips: FilterChip[] = [];
  if (clean.placement) chips.push({ key: 'placement', label: clean.placement === 'unused' ? 'Unused' : 'Used',
    title: clean.placement === 'unused' ? 'Only ' + noun + ' not placed in the book' : 'Only ' + noun + ' placed in the book',
    remove: (current) => setPlacement(current, 'all') });
  if (clean.sources) {
    const sources = orderedSources(clean.sources);
    chips.push({ key: 'sources', label: sources.map(filterSourceLabel).join(', '), origins: sources,
      title: 'Only ' + noun + ' from ' + joinOr(sources.map(filterSourceLabel)), remove: (current) => cleanFilter({ ...current, sources: [] }) });
  }
  for (const { provider, label: providerLabel, properties } of providers) for (const spec of properties) {
    const value = clean.properties?.[spec.id];
    if (value === undefined) continue;
    const { label, scope } = propertyFilterText(spec, value, providerLabel);
    chips.push({ key: spec.id, label, title: scope, origins: [provider], remove: (current) => setProperty(current, spec.id, undefined) });
  }
  return chips;
}

/** What the Sources strip filters a photo or text by: where it comes from, its marks, and whether it is placed. */
export function stripSource(summary: Pick<ProjectSummary, 'photoIndex' | 'project'>, kind: SourceKind, id: string): string | undefined {
  if (kind === 'text') { const ref = summary.project.texts[id]; return ref === undefined ? undefined : sourceLinked(ref) ? 'linked' : 'package'; }
  const entry = summary.photoIndex[id];
  return entry ? readLocator(entry)?.provider : undefined;
}
/** The distinct sources of a tab's photos or texts, in pill order. */
export function stripSources(summary: Pick<ProjectSummary, 'photoIndex' | 'project'>, kind: SourceKind): string[] {
  return orderedSources(Object.keys(kind === 'photo' ? summary.photoIndex : summary.project.texts).map((id) => stripSource(summary, kind, id)));
}

/**
 * The strip's list of a tab under its filter, in the strip's order: what its tiles show, what its tab counts and what
 * Quick Look steps through. Placed means placed on a page; content set aside is not (UI-016).
 */
export function filteredSourceList(summary: ProjectSummary, kind: SourceKind, view: PhotoView | undefined, filter: PhotoFilter, usage: SourceUsage) {
  const items = sourceList(summary, kind, view);
  if (!filterActive(filter)) return items;
  const shown = photoFilterPredicate(filter);
  return items.filter(({ id }) => shown({ provider: stripSource(summary, kind, id), extra: kind === 'photo' ? summary.photoExtra?.[id] : undefined, used: !!usage[kind][id]?.length }));
}

/** The strip's filter of each tab: Photos and Texts filter apart, since their sources and properties differ. */
export type StripFilters = Record<SourceKind, PhotoFilter>;
export const noStripFilters: StripFilters = { photo: {}, text: {} };
/** The strip's filters for the sources the book now holds (`fitFilter`); the same object when nothing changes. */
export function fitStripFilters(summary: Pick<ProjectSummary, 'photoIndex' | 'project'>, filters: StripFilters): StripFilters {
  const photo = fitFilter(filters.photo, stripSources(summary, 'photo')), text = fitFilter(filters.text, stripSources(summary, 'text'));
  return photo === filters.photo && text === filters.text ? filters : { photo, text };
}

/** The list Quick Look steps through: `list` while it holds the source, else every photo or text in the strip's order. */
export function quickLookList(summary: ProjectSummary, source: SourceRef, view: PhotoView | undefined, list?: ReturnType<typeof sourceList>) {
  return list?.some(({ id }) => id === source.id) ? list : sourceList(summary, source.kind, view);
}
