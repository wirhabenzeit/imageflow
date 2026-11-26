import type { AuthoringDiagnostic } from './authoring';
import type { Issue } from './desktop';
import type { SourceAway, SourceKind, SourceStatus } from './source-locations';
import { isUnlocatedPath } from './source-locator';
import { isUnavailableSource } from './source-diagnostics';
import type { SyncedCommit } from './sync-snapshot';

/**
 * Originals that are elsewhere (#308): a book that syncs is laid out from previews on a Mac without its originals, and
 * that is how it is meant to be, not a failure of each photo. What differs is how it is reported: every render still
 * says which boxes print without their original (`source-unavailable` errors with `away`), so exports mark and confirm
 * them as before; the editor and `check_book` sum them up into one finding per reason, below.
 */

/**
 * Why a photo that is drawn from a preview has no original here, when nothing is wrong with it. Decided from what this
 * Mac already knows, never by looking at the original's location, so an unapproved path stays untouched (ADR 0005):
 * - a linked photo at the placeholder a pull gives one it cannot locate here (`unlocatedPath`), which names no file. A
 *   path of any other kind that is not approved may well be a file here, so it keeps asking for its approval, whatever
 *   the manifest says and whether or not a preview is at hand;
 * - a Lightroom photo whose catalog cannot be reached now;
 * - a photo of Apple Photos that this Mac's Photos library does not have (another Mac's library), that ImageFlow may
 *   not read here, or that cannot be downloaded from iCloud now (ADR 0013);
 * - a photo of the book that this Mac's own sync record names and that this Mac never had in the version it names. One
 *   it had, and that is gone, went missing here.
 * Without a preview the photo is missing from the page, whatever the reason, and stays a finding of its own.
 */
export function awayOriginal(status: SourceStatus, synced?: Pick<SyncedCommit, 'photoDigests' | 'localDigests'>): SourceAway | undefined {
  if (status.kind !== 'photo' || !status.cached) return undefined;
  const { id, locator, state, digest } = status;
  if (locator.provider === 'linked') return state === 'unapproved' && isUnlocatedPath((locator as { path?: string }).path ?? '') ? 'other-mac' : undefined;
  if (locator.provider === 'lightroom') return state === 'offline' ? 'catalog' : undefined;
  if (locator.provider === 'photos') return state === 'offline' || state === 'missing' || state === 'denied' ? 'photos' : undefined;
  if (locator.provider !== 'package' || state !== 'missing') return undefined;
  const named = synced?.photoDigests[id];
  return named !== undefined && synced?.localDigests && synced.localDigests[id] === undefined && digest !== named ? 'not-downloaded' : undefined;
}
/** What an asset with its original elsewhere says, in place of the problem reading it ran into. */
export const awayProblem = (away: SourceAway, problem: string | undefined) =>
  away === 'other-mac' ? 'Original on another Mac' : away === 'not-downloaded' ? 'Original not downloaded yet' : problem;
/** The same in a word or two, for an asset's badge. */
export const awayBadge: Record<SourceAway, string> = { 'other-mac': 'On another Mac', catalog: 'Offline', photos: 'Not in Photos here', 'not-downloaded': 'Not downloaded', uploading: 'Uploading' };

/** The originals that are elsewhere for one reason: the photos, placed or not, and the boxes print needs them for. */
export type AwayNote = { away: SourceAway; sources: string[]; placed: Issue[] };
const order: SourceAway[] = ['other-mac', 'catalog', 'photos', 'not-downloaded', 'uploading'];
type Findings = { errors: readonly Issue[]; warnings: readonly Issue[] };

/** Findings without those of originals that are elsewhere, which become one note per reason. */
export function takeAway({ errors, warnings }: Findings): { errors: Issue[]; warnings: Issue[]; notes: AwayNote[] } {
  const away = [...errors, ...warnings].filter((issue) => issue.away);
  return {
    errors: errors.filter((issue) => !issue.away), warnings: warnings.filter((issue) => !issue.away),
    notes: order.flatMap((reason) => {
      const own = away.filter((issue) => issue.away === reason);
      return own.length ? [{ away: reason, sources: [...new Set(own.flatMap(({ source }) => source ?? []))],
        placed: own.filter((issue) => issue.spread || issue.cover) }] : [];
    }),
  };
}

/** What a note says in one line: "216 originals are on another Mac. Needed for printing." */
export function awayText({ away, sources }: Pick<AwayNote, 'away' | 'sources'>) {
  const one = sources.length === 1;
  const subject = sources.length + (one ? ' original is ' : ' originals are ');
  return subject + { 'other-mac': 'on another Mac', catalog: 'in a Lightroom catalog that can’t be reached now', photos: 'in Photos, but can’t be read on this Mac now', 'not-downloaded': 'not downloaded yet',
    uploading: 'still uploading from another Mac' }[away] + '. Needed for printing.';
}
const suggestions: Record<SourceAway, string> = {
  'other-mac': 'Nothing needs to be done to edit the book. Print it on the Mac that has the originals, or have the user choose Locate Folder… in Book check if they are here too.',
  catalog: 'Nothing needs to be done to edit the book. To print it, have the user open the photos’ catalog in Lightroom Classic with the ImageFlow plugin connected.',
  photos: 'Nothing needs to be done to edit the book. To print it, use a Mac whose Photos library has the photos (the same iCloud Photos library), with ImageFlow allowed to read it in Settings → Sources and iCloud reachable.',
  'not-downloaded': 'Nothing needs to be done to edit the book. To print it, have the user choose File → Sync → Download Originals.',
  uploading: 'Nothing needs to be done to edit the book. Print it once the other Mac has uploaded the originals.',
};
export const awaySuggestion = (away: SourceAway) => suggestions[away];

/**
 * An authoring check's finding for each reason: one, instead of one per photo and per box, with every place. A warning: it
 * is how a book is edited away from its originals, and what it says of printing stays. Exports mark and ask about those
 * pages by the render's own findings.
 */
export function awayDiagnostics(notes: readonly AwayNote[]): AuthoringDiagnostic[] {
  return notes.map((note): AuthoringDiagnostic => {
    const occurrences = note.placed.map(({ spread, cover, page, box, source, where }) => ({ ...(spread ? { spread } : {}), ...(cover ? { cover } : {}), ...(page ? { page } : {}),
      ...(box ? { box } : {}), ...(source ? { source } : {}), ...(where ? { where } : {}) }));
    const placed = new Set(note.placed.map(({ source }) => source)).size;
    return {
      code: occurrences.length ? 'source-unavailable' : 'project-input', stage: 'render', severity: 'warning',
      message: awayText(note) + (occurrences.length ? ' Pages with ' + (placed === 1 ? '1 of these photos' : placed + ' of these photos') + ' are drawn from previews and can only be exported as marked proofs.'
        : ' None of them is in a photo box of the checked pages.'),
      details: { reason: note.away, originals: note.sources.length, placed },
      ...(occurrences.length ? { occurrences } : {}),
      suggestion: suggestions[note.away],
    };
  });
}

/**
 * Asset warnings without those of sources another finding already reports where they are placed: a photo is one
 * problem, not one per box and another as an asset. A source nothing reports on a page keeps its warning.
 */
export function withoutReported(warnings: readonly Issue[], errors: readonly Issue[]): Issue[] {
  const reported = new Set<string | undefined>(errors.filter(isUnavailableSource).flatMap(({ source, sourceKind }) => source && sourceKind ? [sourceKind + ':' + source] : []));
  return warnings.filter(({ code, source, sourceKind }) => code !== 'project-input' || !source || !reported.has(sourceKind + ':' + source));
}

/** The unavailable sources of a book as asset warnings. A file has no warning of its own: the parameter it is assigned to reports it. Nor has a preview that is still loading. */
export function sourceWarnings(sources: Record<string, SourceStatus> | undefined): Issue[] {
  return Object.values(sources ?? {}).filter(({ problem, kind, pending }) => problem && !pending && kind !== 'file').map((status): Issue => ({
    message: kindNames[status.kind] + ' ' + status.name + ' · ' + status.problem, code: 'project-input', source: status.id, sourceKind: status.kind,
    state: status.state, problem: status.problem, ...(status.away ? { away: status.away } : {}),
  })).sort((a, b) => a.message.localeCompare(b.message));
}
const kindNames: Record<SourceKind, string> = { photo: 'Photo', markdown: 'Text', file: 'File' };
