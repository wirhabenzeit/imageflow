import { Icon } from './Icon';
import { sourceFile } from './source-locations';
import type { SourceEntry } from './source-locations';

/** Where an asset comes from, for the badge on its tile and the Source row of the Inspector. */
export type SourceOrigin = 'package' | 'linked' | 'lightroom' | 'other';

export function sourceOrigin(entry: SourceEntry | undefined): SourceOrigin | undefined {
  if (!entry) return undefined;
  if (entry.kind !== 'photo') return sourceFile(entry)?.linked ? 'linked' : 'package';
  const provider = entry.locator.provider;
  return provider === 'package' || provider === 'linked' || provider === 'lightroom' ? provider : 'other';
}

export const sourceOriginLabels: Record<SourceOrigin, string> = {
  package: 'In book', linked: 'Linked file', lightroom: 'Lightroom Classic', other: 'External source',
};

/**
 * A small mark for an asset's origin: a book for a file copied into the book, a chain for a linked file, "Lr" for a
 * Lightroom Classic photo. `labelled` writes the origin beside the mark, as the Inspector does.
 */
export function SourceBadge({ origin, labelled = false, className = '' }: { origin: SourceOrigin; labelled?: boolean; className?: string }) {
  const label = sourceOriginLabels[origin];
  return <span className={('source-origin source-origin-' + origin + ' ' + className).trim()} role={labelled ? undefined : 'img'}
    aria-label={labelled ? undefined : label} title={labelled ? undefined : label}>
    <span className="source-origin-mark" aria-hidden="true">
      {origin === 'lightroom' ? 'Lr' : <Icon name={origin === 'linked' ? 'link' : origin === 'package' ? 'book' : 'sources'} size={11} />}
    </span>
    {labelled && <span>{label}</span>}
  </span>;
}
