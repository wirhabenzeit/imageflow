import { isParameterValue } from './parameters';
import type { Parameter, Parameters } from './parameters';
import { boxBase, pageSides, scopeSpread, scopeState, storedBoxes } from './project';
import type { LayoutState, PageSide, PageState, SpreadState, StateLocation, Values } from './project';
import { hasFacingPages, spanFits, spanRequiredAt } from './format';
import type { PrintFormat, Span } from './format';

// Switching layouts. A spread keeps one state for all its layouts, keyed by the IDs the template declares: a box,
// element or parameter ID means the same thing in every layout that declares it. The layout only decides which of
// them are shown, so switching never deletes content and a later edit is never overridden by an older one.

export type Layout = {
  label: string;
  span: Span;
  sides?: ('left' | 'right')[];
  parameters: Parameters;
  boxes: Record<string, { type: 'photo' | 'markdown'; label: string; parameters: Parameters }>;
  elements: Record<string, { label: string; parameters: Parameters }>;
  // The layout family this layout is a variant of, and the template's own tags for it, which a picker reads.
  family?: string;
  variant?: VariantTags;
};
export type Layouts = Record<string, Layout>;
export type VariantTags = Record<string, string | number | boolean>;
// Layouts that are variants of one design, such as a 2×2 and a 3×3 photo grid. A family may supply a picker, which
// chooses one of its variants; the choice is an ordinary layout switch.
// A built-in picker: one segmented choice between the family's variants by one tag, `options` naming each tag value.
export type VariantChoice = { tag: string; options: Record<string, string> };
export type LayoutFamilies = Record<string, { label: string; picker?: { label?: string; choice?: VariantChoice } }>;

const own = <T,>(record: Record<string, T>, key: string) => Object.hasOwn(record, key) ? record[key] : undefined;
const typeName = (param: Parameter) => param.type === 'enum' ? 'an enum' : param.type === 'integer' ? 'an integer' : 'a ' + param.type;

// Declarations that contradict the rule above: the same box ID with different box types, or the same parameter ID
// in one scope with different parameter types. Labels, defaults and constraints may differ between layouts.
export function declarationConflicts(layouts: Record<string, Pick<Layout, 'label' | 'parameters' | 'boxes' | 'elements'>>) {
  const problems: string[] = [];
  const boxes = new Map<string, { type: string; layout: string }>();
  const params = new Map<string, { param: Parameter; layout: string }>();
  const check = (scope: string, parameters: Parameters, layout: string) => {
    for (const [id, param] of Object.entries(parameters)) {
      const key = scope + '\0' + id;
      const first = params.get(key);
      if (!first) params.set(key, { param, layout });
      else if (first.param.type !== param.type) {
        problems.push('Parameter ' + id + (scope ? ' of ' + scope : '') + ' is ' + typeName(first.param) + ' in ' + first.layout + ' but ' +
          typeName(param) + ' in ' + layout + '. A parameter keeps its type in every layout; use a different ID for a different parameter.');
      }
    }
  };
  for (const { label, parameters, boxes: declared, elements } of Object.values(layouts)) {
    check('', parameters, label);
    for (const [id, box] of Object.entries(declared)) {
      const first = boxes.get(id);
      if (!first) boxes.set(id, { type: box.type, layout: label });
      else if (first.type !== box.type) {
        const name = (type: string) => type === 'photo' ? 'a photo box' : 'a Markdown box';
        problems.push('Box ' + id + ' is ' + name(first.type) + ' in ' + first.layout + ' but ' + name(box.type) + ' in ' + label +
          '. A box keeps its type in every layout; use a different ID for a different box.');
      }
      check('box ' + id, box.parameters, label);
    }
    for (const [id, element] of Object.entries(elements)) check('element ' + id, element.parameters, label);
  }
  return problems;
}

// The layouts a spread can switch to: those with the same page footprint. Changing between a full spread and a
// single page changes the book's pagination and is not a layout switch. A spread whose layout the template no
// longer has may choose any. With the book's format, layouts that do not fit it are left out, and a spread whose
// layout does not fit (the book switched to a format of the other kind) may choose any layout that does: a page
// layout without facing pages, a spread layout with them. With its position in the book as well, a spread whose
// layout is not the one the format requires there (a full spread at the start of a book that must open on a single
// right page) may choose the required span instead. The current layout is always a choice.
export function layoutChoices(layouts: Layouts, current: string, format?: Pick<PrintFormat, 'structure'>, position?: { index: number; count: number }) {
  const span = own(layouts, current)?.span;
  const required = format && position ? spanRequiredAt(position.index, position.count, format) : undefined;
  const fits = (id: string) => !format || spanFits(layouts[id].span, format);
  const isEnd = (value: Span | undefined) => value === 'left' || value === 'right';
  return Object.keys(layouts).filter((id) => {
    if (id === current) return true;
    const next = layouts[id];
    if (!fits(id)) return false;
    if (next.span === 'page' && format && hasFacingPages(format)) {
      const side = isEnd(required) ? required : isEnd(span) ? span : undefined;
      return !!side && (!next.sides || next.sides.includes(side as PageSide));
    }
    if (!span) return true;
    if (span === 'page' && format && hasFacingPages(format) && !isEnd(required)) return next.span === 'spread';
    if (format && !spanFits(span, format)) return next.span === (required ?? (hasFacingPages(format) ? 'spread' : 'page'));
    if (span === 'page' && format && hasFacingPages(format) && isEnd(required)) return next.span === required;
    return next.span === span || (!!required && required !== span && next.span === required);
  });
}

/** The name of what a sheet shows: its layout's label, or both pages' labels when it is shown as pages. A split
 * sheet's own `definition` is hidden state, so it never names the sheet. Undefined for an undeclared spread layout. */
export function sheetLayoutLabel(layouts: Record<string, { label: string }> | undefined, spread: Pick<SpreadState, 'definition' | 'split' | 'pages'>) {
  const label = (id: string | undefined) => id === undefined || !layouts ? undefined : own(layouts, id)?.label;
  return spread.split ? pageSides.map((side) => label(spread.pages?.[side]?.definition) ?? 'Blank page').join(' / ') : label(spread.definition);
}

// Editor choices may change a full sheet between a spread and independently chosen pages. End pages and
// non-facing units remain one state; switching those to a page layout must never split their footprint.
export type LayoutPosition = { index: number; count: number };
export function editorLayoutChoices(layouts: Layouts, sheet: SpreadState, format: Pick<PrintFormat, 'structure'>,
  position: LayoutPosition, side?: PageSide) {
  const required = spanRequiredAt(position.index, position.count, format);
  if (!hasFacingPages(format)) return Object.keys(layouts).filter((id) => layouts[id].span === 'page');
  const page = required === 'left' || required === 'right' ? required : side ?? 'left';
  return Object.keys(layouts).filter((id) => {
    const layout = layouts[id];
    if (layout.span === 'page') return !layout.sides || layout.sides.includes(page);
    return layout.span === required;
  });
}

/** The exact planner request a click, drop or preview of an editor layout applies. */
export function editorLayoutTarget(layouts: Layouts, definition: string | undefined, format: Pick<PrintFormat, 'structure'>,
  position: LayoutPosition, side?: PageSide): LayoutTarget {
  const required = spanRequiredAt(position.index, position.count, format);
  const split = hasFacingPages(format) && required === 'spread' && (definition === undefined || layouts[definition]?.span === 'page');
  return split ? { ...(definition ? { definition } : {}), page: side ?? 'left' }
    : { definition, ...(side ? { side } : {}) };
}

// Layout families. Every variant is an ordinary layout with its own ID and boxes, so switching between variants
// follows the rules above unchanged; the family only groups them and says how the choice is presented.

// The variants of a family, in declaration order.
export function familyLayouts(layouts: Layouts, family: string) {
  return Object.keys(layouts).filter((id) => layouts[id].family === family);
}

// Declarations that break the family rules, with the path they belong to. A family must be declared and have at
// least two variants of one page footprint; within a family, tags are given for every variant or none, and no two
// variants share them, so a picker can tell them apart.
export function familyProblems(layouts: Layouts, families: LayoutFamilies = {}) {
  const problems: { path: (string | number)[]; message: string }[] = [];
  const declared = Object.keys(families);
  for (const [id, layout] of Object.entries(layouts)) {
    if (layout.family !== undefined && !Object.hasOwn(families, layout.family)) {
      problems.push({ path: ['spreads', id, 'family'], message: 'Layout ' + id + ' is in family ' + layout.family + ', which layoutFamilies does not declare. ' +
        (declared.length ? 'Declared families: ' + declared.join(', ') + '.' : 'Declare it in layoutFamilies.') });
    }
    if (layout.variant !== undefined && layout.family === undefined) {
      problems.push({ path: ['spreads', id, 'variant'], message: 'Layout ' + id + ' has variant tags but no family. Tags describe a variant within its family; add family, or remove variant.' });
    }
  }
  for (const [family, { label, picker }] of Object.entries(families)) {
    const ids = familyLayouts(layouts, family);
    if (ids.length < 2) {
      problems.push({ path: ['layoutFamilies', family], message: 'Family ' + family + ' (' + label + ') has ' + (ids.length ? 'only layout ' + ids[0] : 'no layouts') +
        '. A family groups at least two layouts; set family: \'' + family + '\' on each of its variants.' });
      continue;
    }
    const spans = [...new Set(ids.map((id) => layouts[id].span))];
    if (spans.length > 1) {
      problems.push({ path: ['layoutFamilies', family], message: 'The layouts of family ' + family + ' have different page footprints (' +
        ids.map((id) => id + ': ' + layouts[id].span).join(', ') + '). Switching between variants must keep the pages, so give them the same span.' });
    }
    if (new Set(ids.map((id) => JSON.stringify([...(layouts[id].sides ?? ['left', 'right'])].sort()))).size > 1) {
      problems.push({ path: ['layoutFamilies', family], message: 'The layouts of family ' + family + ' must allow the same page sides.' });
    }
    const tagged = ids.filter((id) => layouts[id].variant !== undefined);
    if (tagged.length && tagged.length < ids.length) {
      problems.push({ path: ['layoutFamilies', family], message: 'In family ' + family + ', ' + tagged.join(', ') + ' declare variant tags but ' +
        ids.filter((id) => !tagged.includes(id)).join(', ') + ' do not. Tag every variant, or none.' });
    }
    const seen = new Map<string, string>();
    for (const id of tagged) {
      const key = JSON.stringify(Object.entries(layouts[id].variant!).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
      const first = seen.get(key);
      if (first) {
        problems.push({ path: ['spreads', id, 'variant'], message: 'Layouts ' + first + ' and ' + id + ' of family ' + family +
          ' have the same variant tags, so a picker cannot tell them apart. Give each variant its own tags.' });
      } else seen.set(key, id);
    }
    // A built-in choice tells the variants apart by one tag, and names every value they have.
    const choice = picker?.choice;
    if (choice && ids.length >= 2) {
      const named = new Map<string, string>();
      for (const id of ids) {
        const value = layouts[id].variant?.[choice.tag];
        if (value === undefined) {
          problems.push({ path: ['spreads', id, 'variant'], message: 'Layout ' + id + ' of family ' + family + ' has no tag ' + choice.tag +
            ', which the family\'s picker chooses by. Give it ' + choice.tag + ': ' + Object.keys(choice.options).map((key) => JSON.stringify(key)).join(' or ') + '.' });
          continue;
        }
        const key = String(value);
        if (!Object.hasOwn(choice.options, key)) {
          problems.push({ path: ['layoutFamilies', family, 'picker', 'choice', 'options'], message: 'Family ' + family + '\'s choice names no option for ' +
            choice.tag + ': ' + JSON.stringify(key) + ' (layout ' + id + '). Add ' + JSON.stringify(key) + ' to options.' });
        }
        const first = named.get(key);
        if (first) {
          problems.push({ path: ['spreads', id, 'variant'], message: 'Layouts ' + first + ' and ' + id + ' of family ' + family + ' have the same ' +
            choice.tag + ' (' + JSON.stringify(key) + '), so the family\'s choice cannot tell them apart. Use a component picker for more than one tag.' });
        } else named.set(key, id);
      }
      for (const key of Object.keys(choice.options)) if (!ids.some((id) => String(layouts[id].variant?.[choice.tag]) === key)) {
        problems.push({ path: ['layoutFamilies', family, 'picker', 'choice', 'options', key], message: 'Family ' + family + '\'s choice offers ' +
          JSON.stringify(key) + ', but no layout of the family has ' + choice.tag + ': ' + JSON.stringify(key) + '.' });
      }
    }
  }
  return problems;
}

// The layouts the sidebar previews for a spread, from those it can switch to (`layoutChoices`), in declaration
// order. A family with a picker shows one preview: the spread's own layout when it is a variant, else the first
// variant. Other families keep a preview per variant, moved together to where the family first appears.
export function layoutPreviews(layouts: Layouts, current: string, families: LayoutFamilies = {}, format?: Pick<PrintFormat, 'structure'>,
  position?: { index: number; count: number }) {
  const choices = layoutChoices(layouts, current, format, position);
  const shown: string[] = [];
  const done = new Set<string>();
  for (const id of choices) {
    const family = layouts[id].family;
    if (family === undefined || !Object.hasOwn(families, family)) {
      shown.push(id);
      continue;
    }
    if (done.has(family)) continue;
    done.add(family);
    const variants = choices.filter((choice) => layouts[choice].family === family);
    shown.push(...(families[family].picker ? [variants.includes(current) ? current : variants[0]] : variants));
  }
  return shown;
}

// The editor's layout browser groups the current page's family just as the spread browser does. Filter the
// ordinary family presentation through the editor's side-aware choices instead of the old footprint restriction.
export function editorLayoutPreviews(layouts: Layouts, sheet: SpreadState, families: LayoutFamilies = {},
  format: Pick<PrintFormat, 'structure'>, position: LayoutPosition, side?: PageSide, includeRestricted = false) {
  const allowed = editorLayoutChoices(layouts, sheet, format, position, side);
  // Keep page tiles in the same places while selection crosses the fold; applying still uses strict choices.
  const choices = includeRestricted && hasFacingPages(format)
    ? Object.keys(layouts).filter(id => layouts[id].span === 'page' || allowed.includes(id)) : allowed;
  const current = sheet.split ? sheet.pages?.[side ?? 'left']?.definition : sheet.definition;
  const shown: string[] = [];
  const done = new Set<string>();
  for (const id of choices) {
    const family = layouts[id].family;
    if (!family || !Object.hasOwn(families, family)) { shown.push(id); continue; }
    if (done.has(family)) continue;
    done.add(family);
    const variants = choices.filter((choice) => layouts[choice].family === family);
    shown.push(...(families[family].picker ? [current && variants.includes(current) ? current : variants[0]] : variants));
  }
  return shown;
}

// The family with a picker that a previewed layout stands for, if any.
export function pickerFamily(layouts: Layouts, id: string, families: LayoutFamilies = {}) {
  const family = own(layouts, id)?.family;
  return family !== undefined && own(families, family)?.picker ? family : undefined;
}

type Kind = 'photo' | 'text';
type BoxState = SpreadState['boxes'][string];
const kindOf = (box: BoxState | undefined): Kind | undefined => box?.photo ? 'photo' : box?.text ? 'text' : undefined;
const boxKind = (layout: Layout | undefined, id: string): Kind | undefined => {
  const box = layout && own(layout.boxes, id);
  return box ? (box.type === 'photo' ? 'photo' : 'text') : undefined;
};

/** ImageFlow's own blank page (ADR 0009 §3): the paper, with no boxes, elements or parameters. Every template has it
 * without declaring it, and a page state without `definition` shows it. */
export const blankPage: Layout = { label: 'Blank page', span: 'page', parameters: {}, boxes: {}, elements: {} };
/** The layout a state shows: its definition's, the blank page for a page without one, or undefined when the template no
 * longer has it. */
export const stateLayout = (layouts: Layouts, definition: string | undefined) => definition === undefined ? blankPage : own(layouts, definition);

// Box IDs whose content a layout shows.
export function shownBoxes(state: Pick<LayoutState, 'boxes'>, layout: Layout | undefined) {
  return Object.entries(state.boxes).filter(([id, box]) => kindOf(box) && kindOf(box) === boxKind(layout, id)).map(([id]) => id);
}

// The states a spread shows: its pages when it is shown as pages, else its own.
const shownStates = (spread: SpreadState): StateLocation[] => spread.split ? pageSides.filter((side) => spread.pages?.[side]) : ['spread'];

export type KeptContent = { id: string; kind: Kind; source: string; location: StateLocation; replaced?: true };
// Content the spread stores that no shown layout shows: in a state's boxes its layout does not show, in a state that is
// not shown at all (the spread's own while it is shown as pages, a page's while it is not), and content set aside as
// replaced, which never shows by itself.
export function keptOutside(spread: SpreadState, layouts: Layouts): KeptContent[] {
  const shown = shownStates(spread);
  return storedBoxes(spread).flatMap(({ location, box: id, state, displaced }) => {
    const kind = kindOf(state);
    if (!kind) return [];
    if (displaced === undefined && shown.includes(location)) {
      const layout = stateLayout(layouts, scopeState(spread, location === 'spread' ? undefined : location)!.definition);
      if (kindOf(state) === boxKind(layout, id)) return [];
    }
    return [{ id, kind, source: state.photo ?? state.text!, location, ...(displaced !== undefined ? { replaced: true as const } : {}) }];
  });
}

export type Counts = Record<Kind, number>;
/** A layout change (ADR 0009 §3): the layout `definition` for the spread, or for one of its pages with `page` (no
 * `definition` there gives the page ImageFlow's blank page). `side` is the selected side when a spread layout merges a
 * spread shown as pages: its content wins when both pages show a value; without it the left page's does. */
export type LayoutTarget = { definition?: string; page?: PageSide; side?: PageSide };
// The values a change moves between states, keyed by the IDs the target layouts declare.
type Unit = { key: string; kind: 'box' | 'param' | 'element'; id: string; param?: string; label: string };
export type LayoutChange = {
  // The spread after the change. Planning changes nothing; `switchLayout` applies it.
  spread: SpreadState;
  carried: Counts; restored: Counts; kept: Counts;
  // Labels of stored parameter values the target layout's declarations reject; it uses their defaults instead.
  fallbacks: string[];
  reflow: boolean;
  // Values that move to another state, content that stays in a state no longer shown, and content set aside as
  // replaced, by label and location. A change within one state has none of them.
  moves: { label: string; from: StateLocation; to: StateLocation }[];
  keptIn: { label: string; location: StateLocation }[];
  replaced: { label: string; location: StateLocation }[];
  // The facing page a split shows as ImageFlow's blank page, because it remembers no layout.
  blank?: PageSide;
};

function declaredUnits(layout: Layout | undefined): Unit[] {
  if (!layout) return [];
  return [
    ...Object.entries(layout.parameters).map(([id, param]): Unit => ({ key: 'param\0' + id, kind: 'param', id, label: param.label })),
    ...Object.entries(layout.boxes).map(([id, box]): Unit => ({ key: 'box\0' + id, kind: 'box', id, label: box.label })),
    ...Object.entries(layout.elements).flatMap(([id, element]) => Object.entries(element.parameters).map(([param, declared]): Unit =>
      ({ key: 'element\0' + id + '\0' + param, kind: 'element', id, param, label: declared.label }))),
  ];
}
const declares = (layout: Layout | undefined, unit: Unit) => !!layout && (unit.kind === 'param' ? !!own(layout.parameters, unit.id)
  : unit.kind === 'box' ? !!own(layout.boxes, unit.id) : !!own(own(layout.elements, unit.id)?.parameters ?? {}, unit.param!));
// Whether a state stores a value for the ID: content for a box (an empty box is no value), a saved parameter value.
function hasValue(state: LayoutState | undefined, unit: Unit) {
  if (!state) return false;
  if (unit.kind === 'box') return !!kindOf(own(state.boxes, unit.id));
  if (unit.kind === 'param') return Object.hasOwn(state.params, unit.id);
  return Object.hasOwn(own(state.elements, unit.id)?.params ?? {}, unit.param!);
}
const where = (location: StateLocation) => location === 'spread' ? 'the spread' : 'the ' + location + ' page';
const opposite = (side: PageSide): PageSide => side === 'left' ? 'right' : 'left';

/**
 * Plans a layout change by ADR 0009 §3, without changing `spread`. A change replaces the layout of one or more states
 * and gives one or more targets a new layout. For each ID a target's new layout declares, the value comes from the
 * first of: (1) a replaced layout that shows it, empty boxes and defaults included, a value beating an empty box or a
 * default and the selected side winning between two values, each value going to one target only (the chosen side
 * first when splitting); (2) the target's own memory; (3) for a page, what the spread stores while no layout shows it.
 * A value that moves leaves its state; content the target stored for the ID is set aside as replaced, and a parameter
 * value is overwritten. A page that stays visible is neither a source nor a target.
 */
export function planLayoutChange(spread: SpreadState, request: string | LayoutTarget, layouts: Layouts): LayoutChange {
  const target: LayoutTarget = typeof request === 'string' ? { definition: request } : request;
  const layout = target.page && target.definition === undefined ? blankPage : own(layouts, target.definition ?? '');
  if (!layout) throw new Error('The template has no layout ' + target.definition + '.');
  const next = structuredClone(spread);
  const stateAt = (location: StateLocation): LayoutState | undefined => location === 'spread' ? next : next.pages?.[location];
  const ensure = (location: StateLocation): LayoutState => stateAt(location) ?? ((next.pages ??= {})[location as PageSide] = { params: {}, boxes: {}, elements: {} });
  // The layout each state showed or remembered before the change.
  const before = (location: StateLocation) => location === 'spread' ? own(layouts, spread.definition) : stateLayout(layouts, spread.pages?.[location]?.definition);

  let replaced: StateLocation[];
  let targets: { location: StateLocation; layout: Layout | undefined }[];
  let selected: PageSide = target.side ?? 'left';
  let blank: PageSide | undefined;
  if (!target.page) {
    // A spread layout: on a full spread, or merging both pages.
    replaced = spread.split ? pageSides.filter((side) => spread.pages?.[side]) : ['spread'];
    targets = [{ location: 'spread', layout }];
  } else if (spread.split) {
    // A page layout on one page of a spread shown as pages: only that page changes.
    selected = target.page;
    replaced = [target.page];
    targets = [{ location: target.page, layout }];
  } else {
    // Splitting: the chosen side gets the page layout, the other side the layout it remembers or the blank page.
    selected = target.page;
    const other = opposite(target.page);
    replaced = ['spread'];
    targets = [{ location: target.page, layout }, { location: other, layout: before(other) }];
    if (spread.pages?.[other]?.definition === undefined) blank = other;
  }

  // Content shown before, as the box objects themselves: they keep their identity when they move between states.
  const shownIn = (locations: StateLocation[], layoutOf: (location: StateLocation) => Layout | undefined) => new Set(locations.flatMap((location) => {
    const state = stateAt(location);
    return state ? shownBoxes(state, layoutOf(location)).map((id) => state.boxes[id]) : [];
  }));
  const shownBefore = shownIn(replaced, before);
  const displaced: NonNullable<SpreadState['displaced']> = [];
  const moves: LayoutChange['moves'] = [];
  const replacedContent: LayoutChange['replaced'] = [];
  // The layout that showed each value a target holds after the change, for reporting values it now rejects.
  const origin = new Map<string, Layout | undefined>();

  function move(from: StateLocation, to: StateLocation, unit: Unit) {
    origin.set(to + '\0' + unit.key, before(from));
    if (from === to) return;
    const source = stateAt(from);
    const destination = ensure(to);
    if (hasValue(source, unit)) moves.push({ label: unit.label, from, to });
    if (unit.kind === 'box') {
      const incoming = source && own(source.boxes, unit.id);
      if (source) delete source.boxes[unit.id];
      const old = own(destination.boxes, unit.id);
      if (old && kindOf(old)) {
        displaced.push({ from: to, box: unit.id, state: old });
        replacedContent.push({ label: unit.label, location: to });
      }
      if (incoming) destination.boxes[unit.id] = incoming;
      else delete destination.boxes[unit.id];
    } else if (unit.kind === 'param') {
      if (source && Object.hasOwn(source.params, unit.id)) destination.params[unit.id] = source.params[unit.id];
      else delete destination.params[unit.id];
      if (source) delete source.params[unit.id];
    } else {
      const incoming = source && own(source.elements, unit.id);
      const has = !!incoming && Object.hasOwn(incoming.params, unit.param!);
      const value = has ? incoming.params[unit.param!] : undefined;
      if (has) {
        delete incoming.params[unit.param!];
        if (!Object.keys(incoming.params).length) delete source!.elements[unit.id];
      }
      const element = own(destination.elements, unit.id);
      if (has) (element ?? (destination.elements[unit.id] = { params: {} })).params[unit.param!] = value!;
      else if (element) {
        delete element.params[unit.param!];
        if (!Object.keys(element.params).length) delete destination.elements[unit.id];
      }
    }
  }

  const claimed = new Set<string>();
  for (const { location, layout: shows } of targets) for (const unit of declaredUnits(shows)) {
    // 1. A replaced layout that shows the ID: what it shows is final, including nothing.
    const showing = claimed.has(unit.key) ? [] : replaced.filter((from) => declares(before(from), unit));
    if (showing.length) {
      claimed.add(unit.key);
      const valued = showing.filter((from) => hasValue(stateAt(from), unit));
      const pool = valued.length ? valued : showing;
      move(pool.find((from) => from === selected) ?? pool[0], location, unit);
      continue;
    }
    // 2. The target's own memory.
    if (location === 'spread' || hasValue(stateAt(location), unit)) {
      origin.set(location + '\0' + unit.key, before(location));
      continue;
    }
    // 3. For a page, what the spread stores and no layout shows.
    if (hasValue(next, unit)) move('spread', location, unit);
    else origin.set(location + '\0' + unit.key, before(location));
  }

  if (!target.page) {
    next.definition = target.definition!;
    delete next.split;
  } else {
    const page = ensure(target.page) as PageState;
    if (target.definition === undefined) delete page.definition;
    else page.definition = target.definition;
    next.split = true;
  }
  if (displaced.length) next.displaced = [...(next.displaced ?? []), ...displaced];

  const counts = (): Counts => ({ photo: 0, text: 0 });
  const change: LayoutChange = { spread: next, carried: counts(), restored: counts(), kept: counts(), fallbacks: [], reflow: false,
    moves: [], keptIn: [], replaced: replacedContent, ...(blank ? { blank } : {}) };
  const shownAfter = shownIn(targets.map(({ location }) => location), (location) => targets.find((item) => item.location === location)!.layout);
  for (const box of shownAfter) change[shownBefore.has(box) ? 'carried' : 'restored'][kindOf(box)!]++;
  const targetLocations = targets.map(({ location }) => location);
  for (const box of shownBefore) {
    if (shownAfter.has(box)) continue;
    change.kept[kindOf(box)!]++;
    // Content left in a state that no longer shows: named with where it stays, unless that state is a target.
    for (const { location, box: id, state } of storedBoxes(next)) {
      if (state !== box || targetLocations.includes(location)) continue;
      change.keptIn.push({ label: own(before(location)?.boxes ?? {}, id)?.label ?? id, location });
    }
  }
  change.reflow = [...shownBefore, ...shownAfter].some((box) => kindOf(box) === 'text');
  // Moves of content and values, merged by label and route.
  for (const item of moves) if (!change.moves.some((other) => other.label === item.label && other.from === item.from && other.to === item.to)) change.moves.push(item);

  // Values the new layouts reject, judged against the layout that showed them before.
  for (const { location, layout: shows } of targets) {
    const state = stateAt(location);
    if (!state || !shows) continue;
    const from = (key: string) => origin.has(location + '\0' + key) ? origin.get(location + '\0' + key) : before(location);
    for (const [id, value] of Object.entries(state.params)) {
      change.fallbacks.push(...rejected(own(from('param\0' + id)?.parameters ?? {}, id), own(shows.parameters, id), value));
    }
    for (const [id, box] of Object.entries(state.boxes)) for (const [key, value] of Object.entries(box.params)) {
      change.fallbacks.push(...rejected(own(own(from('box\0' + id)?.boxes ?? {}, id)?.parameters ?? {}, key), own(own(shows.boxes, id)?.parameters ?? {}, key), value));
    }
    for (const [id, element] of Object.entries(state.elements)) for (const [key, value] of Object.entries(element.params)) {
      const was = from('element\0' + id + '\0' + key);
      change.fallbacks.push(...rejected(own(own(was?.elements ?? {}, id)?.parameters ?? {}, key), own(own(shows.elements, id)?.parameters ?? {}, key), value));
    }
  }
  change.fallbacks = [...new Set(change.fallbacks)];
  return change;
}

// Whether a value the layout `after` declares is rejected there but was accepted (or not declared) before.
function rejected(was: Parameter | undefined, param: Parameter | undefined, value: Values[string]) {
  return param && !isParameterValue(param, value) && (!was || isParameterValue(was, value)) ? [param.label] : [];
}

// A one-line summary such as "Hero and Title move to the left page · Story kept on the spread · right page becomes
// blank", or, within one state, "2 photos set aside · Title will reset".
export function describeLayoutChange(change: LayoutChange) {
  const amount = (counts: Counts) => [
    counts.photo && counts.photo + (counts.photo === 1 ? ' photo' : ' photos'),
    counts.text && counts.text + (counts.text === 1 ? ' text' : ' texts'),
  ].filter(Boolean).join(', ');
  const list = (labels: string[]) => labels.length < 2 ? labels.join('') : labels.slice(0, -1).join(', ') + ' and ' + labels[labels.length - 1];
  const grouped = <T extends { label: string }>(items: T[], key: (item: T) => string) => [...new Set(items.map(key))]
    .map((group) => ({ group, labels: [...new Set(items.filter((item) => key(item) === group).map(({ label }) => label))] }));
  const parts = [
    ...grouped(change.moves, ({ to }) => to).map(({ group, labels }) => list(labels) + (labels.length === 1 ? ' moves' : ' move') + ' to ' + where(group as StateLocation)),
    // Content kept in a state that still has a layout is counted; content left in a state no longer shown is named.
    !change.keptIn.length && amount(change.kept) && amount(change.kept) + ' set aside',
    ...grouped(change.keptIn, ({ location }) => location).map(({ group, labels }) => list(labels) + ' kept on ' + where(group as StateLocation)),
    change.blank && change.blank + ' page becomes blank',
    ...grouped(change.replaced, ({ location }) => location).map(({ group, labels }) => list(labels) + ' on ' + where(group as StateLocation) + ' replaced'),
    ...change.fallbacks.map((label) => label + ' will reset'),
  ].filter(Boolean) as string[];
  return parts.join(' · ');
}

/** Applies a layout change to `spread` in place (see planLayoutChange) and returns what it did. */
export function switchLayout(spread: SpreadState, target: string | LayoutTarget, layouts: Layouts) {
  const change = planLayoutChange(spread, target, layouts);
  for (const key of Object.keys(spread) as (keyof SpreadState)[]) delete spread[key];
  Object.assign(spread, change.spread);
  return change;
}

/** Exchanges the two page states of a spread shown as pages, layouts included (ADR 0009 §5). The caller offers it only
 * when each page's layout is allowed on the other side. */
export function swapPages(spread: SpreadState) {
  if (!spread.split || !spread.pages) throw new Error('Only a spread shown as pages has pages to swap.');
  const { left, right } = spread.pages;
  spread.pages = { ...(right ? { left: right } : {}), ...(left ? { right: left } : {}) };
  // Replaced content belongs to the page state it came from, so it moves with that state.
  for (const item of spread.displaced ?? []) if (item.from !== 'spread') item.from = opposite(item.from);
}

// Whether any layout of the template declares this box (for its content type), element, or parameter. State the
// current layout does not show but another declares is kept quietly; state no layout declares is reported.
export function declaredInTemplate(layouts: Layouts) {
  const boxes = new Map<string, 'photo' | 'markdown'>();
  const params = new Set<string>();
  const elements = new Set<string>();
  for (const layout of Object.values(layouts)) {
    for (const id of Object.keys(layout.parameters)) params.add('\0' + id);
    for (const [id, box] of Object.entries(layout.boxes)) {
      boxes.set(id, box.type);
      for (const key of Object.keys(box.parameters)) params.add('box ' + id + '\0' + key);
    }
    for (const [id, element] of Object.entries(layout.elements)) {
      elements.add(id);
      for (const key of Object.keys(element.parameters)) params.add('element ' + id + '\0' + key);
    }
  }
  return {
    box: (id: string, kind: Kind) => boxes.get(id) === (kind === 'photo' ? 'photo' : 'markdown'),
    element: (id: string) => elements.has(id),
    // Scope '' for spread parameters, 'box <id>' or 'element <id>' otherwise.
    param: (scope: string, id: string) => params.has(scope + '\0' + id),
  };
}

// A box's content: the assignment and the crop focus. Box parameters belong to the box ID and stay put; per-layout
// crops were made for this box's frames, so they do not travel with the content.
function content(box: BoxState | undefined): Partial<BoxState> {
  if (!box?.photo && !box?.text) return {};
  return box.photo ? { photo: box.photo, ...(box.focus ? { focus: box.focus } : {}) } : { text: box.text };
}

// Swaps the content of two boxes, on one spread or two; an empty box takes the content and leaves the other empty.
// Returns what was in box `to`, if anything.
export function swapContent(from: LayoutState, fromBox: string, to: LayoutState, toBox: string) {
  if (from === to && fromBox === toBox) return;
  const moving = content(from.boxes[fromBox]);
  if (!moving.photo && !moving.text) throw new Error('There is no content in box ' + fromBox + '.');
  const displaced = content(to.boxes[toBox]);
  to.boxes[toBox] = { ...boxBase(to.boxes[toBox]), ...moving };
  from.boxes[fromBox] = { ...boxBase(from.boxes[fromBox]), ...displaced };
  return displaced.photo ?? displaced.text;
}

// Moves kept content into box `to`. Content already there moves to `from`, so nothing is lost: the two swap.
// Returns what was swapped out, if anything. The moved content is no longer kept, so it cannot come back twice.
export function moveContent(spread: SpreadState, from: string, to: string) {
  if (!content(spread.boxes[from]).photo && !content(spread.boxes[from]).text) throw new Error('There is no content saved for box ' + from + '.');
  return swapContent(spread, from, spread, to);
}

// Removes kept content from the spread; the source stays in the project.
export function discardContent(spread: LayoutState, id: string) {
  const box = spread.boxes[id];
  if (box) spread.boxes[id] = boxBase(box);
}

// Element settings the spread keeps for other layouts, by element ID.
export function keptElements(spread: SpreadState, layouts: Layouts) {
  const layout = own(layouts, spread.definition);
  return Object.entries(spread.elements).filter(([id, element]) => Object.keys(element.params).length && !(layout && own(layout.elements, id)))
    .map(([id]) => id);
}

// A readable name for a box ID: its label in the first layout that declares it.
export function boxLabel(layouts: Layouts, id: string) {
  const layout = Object.values(layouts).find((item) => own(item.boxes, id));
  return layout ? { box: layout.boxes[id].label, layout: layout.label } : undefined;
}

/** The sheet's footprint, independent of the spread layout a split spread remembers. */
export function layoutFootprint(spread: Pick<SpreadState, 'definition' | 'split'>, layouts: Layouts) {
  const layout = own(layouts, spread.definition);
  return spread.split ? { span: 'spread' as const } : { span: layout?.span ?? 'spread', sides: layout?.sides };
}

export function shownLayoutStates(spread: SpreadState) {
  return (spread.split ? pageSides : [undefined]).flatMap((page) => {
    const state = scopeSpread(spread, page);
    return state?.definition ? [{ page, state }] : [];
  });
}
