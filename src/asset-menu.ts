import type { BookMenuState, ContextMenuItem, ProjectSummary } from './desktop';
import { emptyMenuState } from './commands';
import { sourceEntries } from './source-locations';
import { assetPageLabels, assetUsage, usageLabel } from './asset-usage';
import type { SourceUsage } from './editing';

export function assetMenu(summary: ProjectSummary, keys: string[], place = false, knownUsage?: SourceUsage): ContextMenuItem[] {
  const chosen = sourceEntries(summary).filter(({ key }) => keys.includes(key));
  const linked = chosen.filter(({ linked }) => linked).length;
  const missing = chosen.some(({ key }) => summary.sources?.[key]?.state !== 'available');
  const usage = { ...assetUsage(summary, assetPageLabels(summary), summary.coverBoxIds ?? null), ...knownUsage };
  const placements = chosen.length === 1 ? usage[chosen[0].kind === 'markdown' ? 'text' : chosen[0].kind][chosen[0].id] ?? [] : [];
  return [
    { command: 'asset-preview', enabled: chosen.length === 1 && !missing },
    // A file, such as a GPX, is chosen in a layout's file setting, not placed in a box: the menu says so.
    chosen.some(({ kind }) => kind === 'file') ? { command: 'asset-place-file', enabled: false }
      : { command: 'asset-place', enabled: place && summary.project.spreads.length > 0, label: chosen.length > 1 ? 'Place ' + chosen.length + ' Assets on Current Spread' : undefined },
    ...(placements.some(({ spread }) => spread) ? [{ command: 'asset-placements' as const, items: placements.filter(({ spread }) => spread).map(({ spread, pages }) => ({ command: 'asset-jump' as const,
      label: usageLabel(pages), value: spread })) }] : []),
    // Texts and files stored in the book can be renamed; a photo has its title, a linked original keeps its name.
    ...(chosen.length === 1 && chosen[0].kind !== 'photo' ? [{ command: 'asset-rename' as const, enabled: !missing && !chosen[0].linked,
      label: chosen[0].linked ? 'Rename… (Copy into Book First)' : undefined }] : []),
    { type: 'separator' }, { command: 'asset-reveal', enabled: !missing },
    ...(chosen.length === 1 && chosen[0].kind === 'markdown' ? [{ command: 'asset-open' as const, enabled: !missing }] : []),
    ...(missing ? [{ command: chosen.length === 1 ? 'asset-locate' as const : 'asset-locate-folder' as const }] : []),
    ...(linked ? [{ command: 'asset-copy' as const, label: linked > 1 ? 'Copy ' + linked + ' into Book' : undefined, enabled: !missing }] : []),
    { type: 'separator' }, { command: 'asset-remove', label: chosen.length > 1 ? 'Remove ' + chosen.length + ' Assets from Book' : undefined },
  ];
}
export function assetMenuState(busy: boolean): BookMenuState {
  return { ...emptyMenuState, document: true, writable: true, busy };
}
export const assetActions = { 'asset-reveal': 'reveal', 'asset-copy': 'copy', 'asset-remove': 'remove', 'asset-locate': 'locate',
  'asset-locate-folder': 'locate-folder', 'asset-open': 'open', 'asset-place': 'place' } as const;
