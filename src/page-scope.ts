import type { PageSide } from './project';

// Finding the boxes and elements a sheet draws (ADR 0009). A spread shown as page layouts draws each page inside its
// own container, marked `data-if-page="left"` or `"right"` (prefixed, so a template's own `data-page` markup is not
// mistaken for it), and each page has its own box and element IDs: both pages may draw a `hero`. A box or element is
// therefore addressed by its page as well as its ID; no page means the spread's own layout. Every lookup by ID in the render frame goes through here, so none can find the other page's box.

export type DeclaredKind = 'box' | 'element';
export type DeclaredNode = { node: HTMLElement; kind: DeclaredKind; id: string; page?: PageSide; boxType?: string };
// A box or element of a spread, on one of its pages or on the spread itself.
export type DeclaredTarget = ({ box: string; element?: undefined } | { element: string; box?: undefined }) & { page?: PageSide };

const declaredSelector = '[data-box], [data-element]';
export const pageAttribute = 'data-if-page';

/** The page a node is drawn on, or undefined when it belongs to the spread's own layout. */
export function pageOf(node: Element): PageSide | undefined {
  const page = node.closest<HTMLElement>('[' + pageAttribute + ']')?.dataset.ifPage;
  return page === 'left' || page === 'right' ? page : undefined;
}
/** `{ page }` for a node on a page, else nothing, to spread into findings and messages. */
export const onPage = (page: PageSide | undefined): { page?: PageSide } => page ? { page } : {};

/** The box or element this node is itself, or undefined. */
export function declaredNode(node: HTMLElement): DeclaredNode | undefined {
  const { box, element, boxType } = node.dataset;
  if (box === undefined && element === undefined) return undefined;
  return { node, kind: box !== undefined ? 'box' : 'element', id: (box ?? element)!, ...onPage(pageOf(node)), ...(box !== undefined && boxType ? { boxType } : {}) };
}

/** Every box and element drawn inside `root`, in document order. */
export function declaredNodes(root: ParentNode): DeclaredNode[] {
  return [...root.querySelectorAll<HTMLElement>(declaredSelector)].map((node) => declaredNode(node)!);
}

/** The boxes and elements that draw `target`: its ID on its page (the spread's own layout without a page). */
export function findDeclared(root: ParentNode, target: DeclaredTarget): DeclaredNode[] {
  const kind: DeclaredKind = target.box !== undefined ? 'box' : 'element';
  const id = target.box ?? target.element;
  return declaredNodes(root).filter((found) => found.kind === kind && found.id === id && found.page === target.page);
}

/**
 * Why `target` was not found on a spread, for a preview or an inspection that asked for it: where a spread shows page
 * layouts, a box or element without a page is looked for in the spread's own layout only, so the message names the page
 * that draws it (27 Nov: a close-up of `{ spread, element: "map" }` on a split spread said only "not rendered").
 */
export function notDrawnMessage(root: ParentNode, target: DeclaredTarget, spread: string) {
  const kind: DeclaredKind = target.box !== undefined ? 'box' : 'element';
  const id = (target.box ?? target.element)!;
  const name = (kind === 'box' ? 'Box ' : 'Element ') + id;
  if (target.page) return name + ' is not rendered on the ' + target.page + ' page of spread ' + spread + '.';
  const pages = [...new Set(declaredNodes(root).filter((found) => found.kind === kind && found.id === id && found.page).map((found) => found.page!))];
  if (pages.length === 1) return name + ' is on the ' + pages[0] + ' page of spread ' + spread + ', which shows page layouts: add "page": "' + pages[0] + '".';
  if (pages.length > 1) return 'Both pages of spread ' + spread + ' draw ' + kind + ' ' + id + ': add "page": "left" or "right".';
  return 'The requested box or element is not rendered on spread ' + spread + '.';
}

/** The declared box or element that contains a node, with its page, for locating findings inside a spread. */
export function ownerOf(node: Element): { box?: string; element?: string; page?: PageSide } {
  // A further rectangle of a box (`rects`) belongs to that box, though it is not a declared node of its own.
  const owner = node.closest<HTMLElement>(declaredSelector + ', [data-box-rect]');
  if (owner?.dataset.boxRect !== undefined) return { box: owner.dataset.boxRect, ...onPage(pageOf(owner)) };
  const found = owner && declaredNode(owner);
  if (!found) return onPage(pageOf(node));
  return { [found.kind]: found.id, ...onPage(found.page) };
}

/** `{ owner }` for an edit target that is itself a box or element. The target carries its page itself (see pageOf). */
export function ownTarget(node: HTMLElement): { owner?: { type: DeclaredKind; id: string } } {
  const found = declaredNode(node);
  return found && found.id ? { owner: { type: found.kind, id: found.id } } : {};
}

/** A key that tells boxes and elements apart across both pages, such as `left:box:hero`. */
export const declaredKey = ({ kind, id, page }: Pick<DeclaredNode, 'kind' | 'id' | 'page'>) => (page ?? 'spread') + ':' + kind + ':' + id;

/** A readable name, such as `box hero` or `left page · element grid`. */
export const declaredName = ({ kind, id, page }: Pick<DeclaredNode, 'kind' | 'id' | 'page'>) => (page ? page + ' page · ' : '') + kind + ' ' + id;
