import type { BookMenuState, ContextMenuItem, ProjectSummary } from './desktop';
import { emptyMenuState } from './commands';
import { sourceEntries, sourceFile, sourceProvider, sourceReach } from './source-locations';
import type { SourceEntry, SourceRepair } from './source-locations';
import { assetPageLabels, assetUsage, shownAssetUsage, usageLabel } from './asset-usage';
import type { SourceUsage } from './editing';

/** Whether Lightroom Classic can show this source now: one of its photos that is neither offline nor gone from the catalog. */
export function showsInLightroom(summary: ProjectSummary, entry: SourceEntry) {
  const state = summary.sources?.[entry.key]?.state;
  return sourceProvider(entry) === 'lightroom' && !!state && state !== 'offline' && state !== 'missing';
}

export function assetMenu(summary: ProjectSummary, keys: string[], place = false, knownUsage?: SourceUsage): ContextMenuItem[] {
  const chosen = sourceEntries(summary).filter(({ key }) => keys.includes(key));
  // What Copy into Book takes into the package: a linked file, or a photo of another provider, which is materialized
  // on the way (ADR 0011, §4.5).
  const linked = chosen.filter((entry) => sourceReach(entry) !== 'book').length;
  const missing = chosen.some(({ key }) => summary.sources?.[key]?.state !== 'available');
  // What each unavailable asset's provider offers (`SourceProvider.repairs`): a file is located, a photo of an app or a
  // server that is not reachable is not. Statuses from before repairs were reported offer what a file does.
  const offers = (repair: SourceRepair) => chosen.some(({ key }) => { const status = summary.sources?.[key];
    return !!status && status.state !== 'available' && (status.repairs ?? ['locate', 'locate-folder']).includes(repair); });
  const usage = { ...(summary.layoutBoxes ? shownAssetUsage(summary) : assetUsage(summary, assetPageLabels(summary), summary.coverBoxIds ?? null)), ...knownUsage };
  const placements = chosen.length === 1 ? usage[chosen[0].kind === 'markdown' ? 'text' : chosen[0].kind][chosen[0].id] ?? [] : [];
  // Pages that store the asset without showing it can be gone to as well, such as to place it again (UI-016).
  const aside = chosen.length === 1 && chosen[0].kind !== 'file' ? usage.aside?.[chosen[0].kind === 'markdown' ? 'text' : 'photo'][chosen[0].id] ?? [] : [];
  const jumps = [...placements.map((place) => ({ ...place, label: usageLabel(place.pages) })), ...aside.map((place) => ({ ...place, label: usageLabel(place.pages) + ' (Set Aside)' }))]
    .filter(({ spread }) => spread);
  return [
    { command: 'asset-preview', enabled: chosen.length === 1 && !missing },
    // A file, such as a GPX, is chosen in a layout's file setting, not placed in a box: the menu says so.
    chosen.some(({ kind }) => kind === 'file') ? { command: 'asset-place-file', enabled: false }
      : { command: 'asset-place', enabled: place && summary.project.spreads.length > 0, label: chosen.length > 1 ? 'Place ' + chosen.length + ' Assets on Current Spread' : undefined },
    ...(jumps.length ? [{ command: 'asset-placements' as const, items: jumps.map(({ spread, label }) => ({ command: 'asset-jump' as const, label, value: spread })) }] : []),
    // Texts and files stored in the book can be renamed; a photo has its title, a linked original keeps its name.
    ...(chosen.length === 1 && chosen[0].kind !== 'photo' ? [{ command: 'asset-rename' as const, enabled: !missing && !chosen[0].linked,
      label: chosen[0].linked ? 'Rename… (Copy into Book First)' : undefined }] : []),
    // Show in Finder needs a file: a photo of another provider has none.
    { type: 'separator' }, { command: 'asset-reveal', enabled: !missing && chosen.every((entry) => !!sourceFile(entry)) },
    // A photo of Lightroom Classic is shown there instead, while its catalog can be reached and still holds it.
    ...(chosen.some((entry) => sourceProvider(entry) === 'lightroom') ? [{ command: 'asset-show-lightroom' as const,
      enabled: chosen.some((entry) => showsInLightroom(summary, entry)) }] : []),
    ...(chosen.length === 1 && chosen[0].kind === 'markdown' ? [{ command: 'asset-open' as const, enabled: !missing }] : []),
    // Locate Folder… finds every missing asset in the folder chosen, whatever is selected (F-045).
    // Retry reads them again; it is the one repair for a photo whose app or server is not reachable now.
    // A Lightroom photo's preview is the one Lightroom keeps: this renders it anew, for one out of date or not quite right.
    ...(chosen.some((entry) => sourceProvider(entry) === 'lightroom' && summary.sources?.[entry.key]?.state === 'available') ? [{ command: 'asset-refresh' as const }] : []),
    // An app that is not running is opened; its photos come back once it connects (Lightroom Classic, ADR 0011).
    ...(offers('launch') ? [{ command: 'asset-launch' as const }] : []),
    ...(missing && !offers('locate') && !offers('locate-folder') ? [{ command: 'asset-retry' as const }] : []),
    ...(chosen.length === 1 && offers('locate') ? [{ command: 'asset-locate' as const }] : []),
    ...(offers('locate-folder') ? [{ command: 'asset-locate-folder' as const }] : []),
    ...(linked ? [{ command: 'asset-copy' as const, label: linked > 1 ? 'Copy ' + linked + ' into Book…' : undefined, enabled: !missing }] : []),
    { type: 'separator' }, { command: 'asset-remove', label: chosen.length > 1 ? 'Remove ' + chosen.length + ' Assets from Book' : undefined },
  ];
}
export function assetMenuState(busy: boolean): BookMenuState {
  return { ...emptyMenuState, document: true, writable: true, busy };
}
export const assetActions = { 'asset-reveal': 'reveal', 'asset-copy': 'copy', 'asset-remove': 'remove', 'asset-locate': 'locate',
  'asset-locate-folder': 'locate-folder', 'asset-open': 'open', 'asset-place': 'place', 'asset-retry': 'retry', 'asset-refresh': 'refresh', 'asset-show-lightroom': 'show-lightroom', 'asset-launch': 'launch' } as const;
