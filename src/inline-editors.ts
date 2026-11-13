import type { BookGeometry, Rect } from './desktop';
import { resolveTarget } from './edit-targets';
import type { TargetAnchor } from './edit-targets';
import type { EditorTarget } from './editor-session';
import type { InlineEditing } from './BookFrame';

// Where an open custom editor is shown (#102). An editor that asks for `presentation: 'inline'` edits on the page, in
// the rectangle of what it was opened from: its element, or for a document editor the marked node that was clicked
// (`at`, that node's target key). It opens in the panel instead when that rectangle is rotated or skewed (its
// on-screen box is only a bounding box, and transformed interaction geometry is out of scope), too small to use, or
// not on the page.
export type Presentation = 'dialog' | 'inline';
// `click` is the click on the page that opened an inline document editor (client coordinates and ⌥), passed on to the
// editor once it shows, so one click on a calendar day both opens the days and marks it.
export type OpenEditor = EditorTarget & { presentation: Presentation; at?: string; click?: { x: number; y: number; alt: boolean } };
type Target = BookGeometry['targets'][number];

// Below this, in screen pixels, an inline editor is too small to use; it opens in the panel.
export const minimumInline = { width: 32, height: 32, area: 6000 };
export const inlineFits = ({ width, height }: Rect) =>
  width >= minimumInline.width && height >= minimumInline.height && width * height >= minimumInline.area;

/** The presentation an editor opens in: inline when it asks for it and its rectangle allows it. */
export function presentationFor(declared: Presentation | undefined, rect: (Rect & { upright?: boolean }) | undefined): Presentation {
  return declared === 'inline' && rect && rect.upright !== false && inlineFits(rect) ? 'inline' : 'dialog';
}

/** The element of an element editor, as the book frame last measured it. */
export const elementRect = (geometry: BookGeometry | undefined, spread: string, element: string) =>
  geometry?.boxes.find((box) => box.spread === spread && box.id === element && box.type === 'element');

/**
 * The marked node an inline document editor is drawn over. It opens at the node its key names; afterwards it follows
 * the nearest node with the same fields (see resolveTarget), since a re-render can renumber occurrences.
 */
export function anchoredTarget(geometry: BookGeometry | undefined, open: OpenEditor, anchor?: TargetAnchor): Target | undefined {
  if (!geometry || open.kind !== 'document' || !open.at) return undefined;
  const sheet = geometry.sheets.find(({ spread }) => spread === open.spread);
  return resolveTarget(geometry.targets.filter(({ spread }) => spread === open.spread), open.at, anchor, sheet);
}

/**
 * Where an inline editor's frame goes, in the stage's coordinates, with the sheet's preview scale; undefined while
 * what it edits is not on the page. `target` is the anchored node of a document editor.
 */
export function inlinePlacement(geometry: BookGeometry | undefined, open: OpenEditor, target?: Target) {
  if (!geometry || open.presentation !== 'inline') return undefined;
  const rect = open.kind === 'element' ? elementRect(geometry, open.spread, open.element) : target;
  if (!rect || rect.width <= 0 || rect.height <= 0) return undefined;
  const zoom = geometry.sheets.find(({ spread }) => spread === open.spread)?.zoom ?? 1;
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, zoom };
}

/** The occurrence whose artwork the book view hides while the inline editor shows in its place. */
export function hiddenOccurrence(open: OpenEditor, target?: Target): InlineEditing | undefined {
  if (open.presentation !== 'inline') return undefined;
  if (open.kind === 'element') return { spread: open.spread, element: open.element };
  return target && { spread: open.spread, edits: target.edits.join(' '), occurrence: target.occurrence };
}
