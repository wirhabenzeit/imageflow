import { Icon } from './Icon';
import { useSourceIcon } from './source-icons';
import { sourceFile } from './source-locations';
import type { SourceEntry } from './source-locations';

/** Where an asset comes from, for the badge on its tile and the Source row of the Inspector. */
export type SourceOrigin = 'package' | 'linked' | 'lightroom' | 'photos' | 'other';

export function sourceOrigin(entry: SourceEntry | undefined): SourceOrigin | undefined {
  if (!entry) return undefined;
  if (entry.kind !== 'photo') return sourceFile(entry)?.linked ? 'linked' : 'package';
  const provider = entry.locator.provider;
  return provider === 'package' || provider === 'linked' || provider === 'lightroom' || provider === 'photos' ? provider : 'other';
}

export const sourceOriginLabels: Record<SourceOrigin, string> = {
  package: 'In book', linked: 'Linked file', lightroom: 'Lightroom Classic', photos: 'Apple Photos', other: 'External source',
};

/**
 * A small mark for an asset's origin: a book for a file copied into the book, a chain for a linked file, and for a
 * photo of Lightroom Classic or Photos that app's icon, or "Lr" and a flower where the app is not on this Mac. `labelled` writes the origin beside the mark, as the Inspector does.
 */
export function SourceBadge({ origin, labelled = false, className = '' }: { origin: SourceOrigin; labelled?: boolean; className?: string }) {
  const label = sourceOriginLabels[origin];
  // A photo of an app on this Mac shows that app's own icon; the drawn mark stands in where there is none.
  const lightroomIcon = useSourceIcon('lightroom'), photosIcon = useSourceIcon('photos');
  const app = origin === 'lightroom' ? lightroomIcon : origin === 'photos' ? photosIcon : undefined;
  return <span className={('source-origin source-origin-' + origin + ' ' + className).trim()} role={labelled ? undefined : 'img'}
    aria-label={labelled ? undefined : label} title={labelled ? undefined : label}>
    {app ? <img className="source-origin-app" src={app} alt="" aria-hidden="true" draggable={false} /> : <span className="source-origin-mark" aria-hidden="true">
      {origin === 'lightroom' ? 'Lr' : origin === 'photos' ? <PhotosMark /> : <Icon name={origin === 'linked' ? 'link' : origin === 'package' ? 'book' : 'sources'} size={11} />}
    </span>}
    {labelled && <span>{label}</span>}
  </span>;
}

/** A flower of six petals, outlined, for Photos where its icon cannot be shown. */
function PhotosMark() {
  return <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
    {[0, 60, 120, 180, 240, 300].map((angle) => <ellipse key={angle} cx="8" cy="4.6" rx="2" ry="3" transform={'rotate(' + angle + ' 8 8)'} />)}
  </svg>;
}
