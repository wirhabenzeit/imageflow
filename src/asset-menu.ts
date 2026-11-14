import type { BookMenuState, ContextMenuItem, ProjectSummary } from './desktop';
import { emptyMenuState } from './commands';
import { sourceEntries } from './source-locations';
import { assetPageLabels, assetUsage } from './asset-usage';
import type { SourceUsage } from './editing';

export function assetMenu(summary: ProjectSummary, keys: string[], place = false, knownUsage?: SourceUsage): ContextMenuItem[] {
  const chosen = sourceEntries(summary).filter(({ key }) => keys.includes(key));
  const linked = chosen.filter(({ linked }) => linked).length;
  const missing = chosen.some(({ key }) => summary.sources?.[key]?.state !== 'available');
  const usage = { ...assetUsage(summary, assetPageLabels(summary)), ...knownUsage };
  const placements = chosen.length === 1 ? usage[chosen[0].kind === 'markdown' ? 'text' : chosen[0].kind][chosen[0].id] ?? [] : [];
  const removable = !chosen.some(({ id, kind }) => kind === 'file' && usage.file[id]?.length);
  return [
    { command: 'asset-preview', enabled: chosen.length === 1 && !missing },
    { command: 'asset-place', enabled: place && summary.project.spreads.length > 0 && chosen.every(({ kind }) => kind !== 'file'), label: chosen.length > 1 ? 'Place ' + chosen.length + ' Assets on Current Spread' : undefined },
    ...(placements.some(({ spread }) => spread) ? [{ command: 'asset-placements' as const, items: placements.filter(({ spread }) => spread).map(({ spread, pages }) => ({ command: 'asset-jump' as const,
      label: /^\d/.test(pages) ? (pages.includes('–') ? 'Pages ' : 'Page ') + pages : pages, value: spread })) }] : []),
    { type: 'separator' }, { command: 'asset-reveal', enabled: !missing },
    ...(chosen.length === 1 && chosen[0].kind === 'markdown' ? [{ command: 'asset-open' as const, enabled: !missing }] : []),
    ...(missing ? [{ command: chosen.length === 1 ? 'asset-locate' as const : 'asset-locate-folder' as const }] : []),
    ...(linked ? [{ command: 'asset-copy' as const, label: linked > 1 ? 'Copy ' + linked + ' into Book' : undefined, enabled: !missing }] : []),
    { type: 'separator' }, { command: 'asset-remove', label: chosen.length > 1 ? 'Remove ' + chosen.length + ' Assets from Book' : undefined, enabled: removable },
  ];
}
export function assetMenuState(summary: ProjectSummary, busy: boolean): BookMenuState {
  return { ...emptyMenuState, document: true, writable: !summary.readOnly, busy };
}
export const assetActions = { 'asset-reveal': 'reveal', 'asset-copy': 'copy', 'asset-remove': 'remove', 'asset-locate': 'locate',
  'asset-locate-folder': 'locate-folder', 'asset-open': 'open', 'asset-place': 'place' } as const;
