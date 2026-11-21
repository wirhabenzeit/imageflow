import { keptOutside, shownLayoutStates } from './layouts';
import type { KeptContent, Layouts } from './layouts';
import { boxBase, scopeSpread, scopeState, storedBoxes } from './project';
import type { BoxState, PageSide, SpreadState, StateLocation } from './project';

export const layoutMime = 'application/x-imageflow-layout';
export type KeptItem = KeptContent & { displaced?: number };
export type ContentTarget = { box: string; page?: PageSide };
export const locationLabel = (location: StateLocation) => location === 'spread' ? 'on the spread' : 'on the ' + location + ' page';

// Keep the replaced item's index as well as its source and location: two displaced boxes may have the same ID.
export function keptItems(sheet: SpreadState, layouts: Layouts): KeptItem[] {
  const kept = keptOutside(sheet, layouts);
  const memory = kept.filter((item) => !item.replaced);
  return [...memory, ...storedBoxes(sheet).flatMap(({ location, box: id, state, displaced }) => {
    if (displaced === undefined || (!state.photo && !state.text)) return [];
    return [{ id, location, kind: state.photo ? 'photo' as const : 'text' as const,
      source: (state.photo ?? state.text)!, replaced: true as const, displaced }];
  })];
}

export function shownContentTargets(sheet: SpreadState, layouts: Layouts, kind: KeptItem['kind']) {
  return shownLayoutStates(sheet).flatMap(({ page, state }) => Object.entries(layouts[state.definition]?.boxes ?? {})
    .filter(([, box]) => (box.type === 'photo') === (kind === 'photo'))
    .map(([box, declaration]) => ({ box, ...(page ? { page } : {}), label: declaration.label,
      source: kind === 'photo' ? state.boxes[box]?.photo : state.boxes[box]?.text })));
}

function sourceState(sheet: SpreadState, item: KeptItem): BoxState | undefined {
  const displaced = item.displaced === undefined ? undefined : sheet.displaced?.[item.displaced];
  if (item.displaced !== undefined && (!displaced || displaced.from !== item.location || displaced.box !== item.id)) return;
  const state = displaced?.state ?? scopeState(sheet, item.location === 'spread' ? undefined : item.location)?.boxes[item.id];
  return state && (item.kind === 'photo' ? state.photo : state.text) === item.source ? state : undefined;
}
const assignment = (state: BoxState) => state.photo ? { photo: state.photo, ...(state.focus ? { focus: structuredClone(state.focus) } : {}) }
  : state.text ? { text: state.text } : {};

// Place in... swaps assignments, as dragging content does. Box settings stay with their IDs; crops are reset for
// the destination's frame. A replaced item remains replaced only when it receives an occupied destination back.
export function placeKeptContent(sheet: SpreadState, from: KeptItem, to: ContentTarget): string | undefined {
  const source = sourceState(sheet, from);
  const destination = scopeState(sheet, to.page);
  if (!source || !destination || (from.displaced === undefined && from.location === (to.page ?? 'spread') && from.id === to.box)) return;
  const occupant = destination.boxes[to.box] ?? { params: {} };
  const outgoing = occupant.photo ?? occupant.text;
  destination.boxes[to.box] = { ...boxBase(occupant), ...assignment(source) };
  if (from.displaced !== undefined) {
    if (outgoing) sheet.displaced![from.displaced] = { from: to.page ?? 'spread', box: to.box, state: { ...boxBase(occupant), ...assignment(occupant) } };
    else {
      sheet.displaced!.splice(from.displaced, 1);
      if (!sheet.displaced!.length) delete sheet.displaced;
    }
  } else {
    const origin = scopeState(sheet, from.location === 'spread' ? undefined : from.location)!;
    origin.boxes[from.id] = { ...boxBase(source), ...assignment(occupant) };
  }
  return outgoing;
}

export function discardKeptContent(sheet: SpreadState, item: KeptItem): boolean {
  const source = sourceState(sheet, item);
  if (!source) return false;
  if (item.displaced !== undefined) {
    sheet.displaced!.splice(item.displaced, 1);
    if (!sheet.displaced!.length) delete sheet.displaced;
  } else scopeState(sheet, item.location === 'spread' ? undefined : item.location)!.boxes[item.id] = boxBase(source);
  return true;
}

export function canSwapPages(sheet: SpreadState, layouts: Layouts): boolean {
  if (!sheet.split) return false;
  return (['left', 'right'] as const).every((side) => {
    const definition = sheet.pages?.[side]?.definition;
    if (!definition) return true;
    const layout = Object.hasOwn(layouts, definition) ? layouts[definition] : undefined;
    const opposite = side === 'left' ? 'right' : 'left';
    return !!layout && layout.span === 'page' && (!layout.sides || layout.sides.includes(opposite));
  });
}

/** Canvas edits only apply to a state that is still shown when a queued save runs. */
export function editableSpread(sheet: SpreadState | undefined, page?: PageSide): SpreadState | undefined {
  if (!sheet || !!sheet.split !== !!page) return undefined;
  return scopeSpread(sheet, page);
}
