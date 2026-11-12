import { isParameterValue } from './parameters';
import type { Parameter, Parameters } from './parameters';
import type { SpreadState, Values } from './project';

// Switching layouts. A spread keeps one state for all its layouts, keyed by the IDs the template declares: a box,
// element or parameter ID means the same thing in every layout that declares it. The layout only decides which of
// them are shown, so switching never deletes content and a later edit is never overridden by an older one.

export type Layout = {
  label: string;
  span: 'spread' | 'left' | 'right';
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
export type LayoutFamilies = Record<string, { label: string; picker?: { label?: string } }>;

const own = <T,>(record: Record<string, T>, key: string) => Object.hasOwn(record, key) ? record[key] : undefined;
const typeName = (param: Parameter) => param.type === 'enum' ? 'an enum' : param.type === 'integer' ? 'an integer' : 'a ' + param.type;

// Declarations that contradict the rule above: the same box ID with different box types, or the same parameter ID
// in one scope with different parameter types. Labels, defaults and constraints may differ between layouts.
export function declarationConflicts(layouts: Layouts) {
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
// longer has may choose any.
export function layoutChoices(layouts: Layouts, current: string) {
  const span = own(layouts, current)?.span;
  return Object.keys(layouts).filter((id) => !span || layouts[id].span === span);
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
  for (const [family, { label }] of Object.entries(families)) {
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
  }
  return problems;
}

// The layouts the sidebar previews for a spread, from those it can switch to (`layoutChoices`), in declaration
// order. A family with a picker shows one preview: the spread's own layout when it is a variant, else the first
// variant. Other families keep a preview per variant, moved together to where the family first appears.
export function layoutPreviews(layouts: Layouts, current: string, families: LayoutFamilies = {}) {
  const choices = layoutChoices(layouts, current);
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

// The family with a picker that a previewed layout stands for, if any.
export function pickerFamily(layouts: Layouts, id: string, families: LayoutFamilies = {}) {
  const family = own(layouts, id)?.family;
  return family !== undefined && own(families, family)?.picker ? family : undefined;
}

type Kind = 'photo' | 'text';
const kindOf = (box: SpreadState['boxes'][string]): Kind | undefined => box.photo ? 'photo' : box.text ? 'text' : undefined;
const boxKind = (layout: Layout | undefined, id: string): Kind | undefined => {
  const box = layout && own(layout.boxes, id);
  return box ? (box.type === 'photo' ? 'photo' : 'text') : undefined;
};

// Box IDs whose content a layout shows.
export function shownBoxes(spread: SpreadState, layout: Layout | undefined) {
  return Object.entries(spread.boxes).filter(([id, box]) => kindOf(box) && kindOf(box) === boxKind(layout, id)).map(([id]) => id);
}

// Content the spread keeps that its current layout does not show.
export function keptOutside(spread: SpreadState, layouts: Layouts) {
  const layout = own(layouts, spread.definition);
  const shown = new Set(shownBoxes(spread, layout));
  return Object.entries(spread.boxes).filter(([id, box]) => kindOf(box) && !shown.has(id))
    .map(([id, box]) => ({ id, kind: kindOf(box)!, source: box.photo ?? box.text! }));
}

export type Counts = Record<Kind, number>;
export type LayoutChange = {
  carried: Counts; restored: Counts; kept: Counts;
  // Labels of stored parameter values the target layout's declarations reject; it uses their defaults instead.
  fallbacks: string[];
  reflow: boolean;
};

function rejected(before: Parameters | undefined, after: Parameters | undefined, values: Values) {
  return Object.entries(values).flatMap(([id, value]) => {
    const param = after && own(after, id);
    const was = before && own(before, id);
    return param && !isParameterValue(param, value) && (!was || isParameterValue(was, value)) ? [param.label] : [];
  });
}

// What switching a spread to `target` would show, keep and fall back on. Planning reads the spread and changes nothing.
export function planLayoutChange(spread: SpreadState, target: string, layouts: Layouts): LayoutChange {
  const before = own(layouts, spread.definition);
  const after = own(layouts, target);
  if (!after) throw new Error('The template has no layout ' + target + '.');
  const shownBefore = new Set(shownBoxes(spread, before));
  const shownAfter = new Set(shownBoxes(spread, after));
  const counts = (): Counts => ({ photo: 0, text: 0 });
  const change: LayoutChange = { carried: counts(), restored: counts(), kept: counts(), fallbacks: [], reflow: false };
  for (const [id, box] of Object.entries(spread.boxes)) {
    const kind = kindOf(box);
    if (!kind) continue;
    if (shownBefore.has(id) && shownAfter.has(id)) change.carried[kind]++;
    else if (shownAfter.has(id)) change.restored[kind]++;
    else if (shownBefore.has(id)) change.kept[kind]++;
    if (kind === 'text' && (shownBefore.has(id) || shownAfter.has(id))) change.reflow = true;
  }
  change.fallbacks.push(...rejected(before?.parameters, after.parameters, spread.params));
  for (const [id, box] of Object.entries(spread.boxes)) {
    change.fallbacks.push(...rejected(before && own(before.boxes, id)?.parameters, own(after.boxes, id)?.parameters, box.params));
  }
  for (const [id, element] of Object.entries(spread.elements)) {
    change.fallbacks.push(...rejected(before && own(before.elements, id)?.parameters, own(after.elements, id)?.parameters, element.params));
  }
  change.fallbacks = [...new Set(change.fallbacks)];
  return change;
}

// A one-line summary such as "2 photos carried over · 2 photos kept outside this layout · text will reflow".
export function describeLayoutChange(change: LayoutChange) {
  const amount = (counts: Counts) => [
    counts.photo && counts.photo + (counts.photo === 1 ? ' photo' : ' photos'),
    counts.text && counts.text + (counts.text === 1 ? ' text' : ' texts'),
  ].filter(Boolean).join(', ');
  const parts = [
    amount(change.carried) && amount(change.carried) + ' carried over',
    amount(change.restored) && amount(change.restored) + ' shown again',
    amount(change.kept) && amount(change.kept) + ' kept outside this layout',
    ...change.fallbacks.map((label) => label + ' uses the default'),
    change.reflow && 'text will reflow',
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'No content to carry over';
}

// Switches the spread's layout. Content, crops and parameter values all stay with the spread.
export function switchLayout(spread: SpreadState, target: string, layouts: Layouts) {
  if (!own(layouts, target)) throw new Error('The template has no layout ' + target + '.');
  spread.definition = target;
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

type BoxState = SpreadState['boxes'][string];
// A box's content: the assignment and the crop focus. Box parameters belong to the box ID and stay put; per-layout
// crops were made for this box's frames, so they do not travel with the content.
function content(box: BoxState | undefined): Partial<BoxState> {
  if (!box?.photo && !box?.text) return {};
  return box.photo ? { photo: box.photo, ...(box.focus ? { focus: box.focus } : {}) } : { text: box.text };
}

// Swaps the content of two boxes, on one spread or two; an empty box takes the content and leaves the other empty.
// Returns what was in box `to`, if anything.
export function swapContent(from: SpreadState, fromBox: string, to: SpreadState, toBox: string) {
  if (from === to && fromBox === toBox) return;
  const moving = content(from.boxes[fromBox]);
  if (!moving.photo && !moving.text) throw new Error('There is no content in box ' + fromBox + '.');
  const displaced = content(to.boxes[toBox]);
  to.boxes[toBox] = { params: to.boxes[toBox]?.params ?? {}, ...moving };
  from.boxes[fromBox] = { params: from.boxes[fromBox]?.params ?? {}, ...displaced };
  return displaced.photo ?? displaced.text;
}

// Moves kept content into box `to`. Content already there moves to `from`, so nothing is lost: the two swap.
// Returns what was swapped out, if anything. The moved content is no longer kept, so it cannot come back twice.
export function moveContent(spread: SpreadState, from: string, to: string) {
  if (!content(spread.boxes[from]).photo && !content(spread.boxes[from]).text) throw new Error('There is no content saved for box ' + from + '.');
  return swapContent(spread, from, spread, to);
}

// Removes kept content from the spread; the source stays in the project.
export function discardContent(spread: SpreadState, id: string) {
  const box = spread.boxes[id];
  if (box) spread.boxes[id] = { params: box.params };
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
