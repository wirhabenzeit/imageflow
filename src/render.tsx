import { sourcePath } from './source-locations';
import { impureMessage, impureSuggestion, installPurityGuards } from './purity';
import { configureRenderedImages, renderedImageState, renderingImages, settleRenderedImages, settleRestoredImages, watchRenderedImages } from './rendered-image';
import type { RenderedImageFailure } from './rendered-image';
import type { ImportMode, SourceReference } from './source-locations';
import React from 'react';
import * as jsx from 'react/jsx-runtime';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { editorURL } from './desktop';
import { bookLayout } from './desktop';
import type { BookGeometry, BookView, Issue, Rect, RenderStatus, TemplateInfo } from './desktop';
import { cssMM, pageLabel, pageNumbers, pageSequence, pagesText, resolveFormat, sheetBleed, sheetPages, toMillimeters } from './format';
import { animateReorder } from './reorder-motion';
import type { ReorderOffset } from './reorder-motion';
import type { PrintSide, ResolvedFormat, UnitPages } from './format';
import { parseDocument } from './project';
import type { FixtureMarking, RenderProject, SpreadState, Values } from './project';
import { markdownToHtml } from './markdown';
import { isParameterValue, parameterWarnings, resolveParams } from './parameters';
import type { Parameters } from './parameters';
import { flow } from './text-flow';
import { declarationWarnings, placeControlWarnings } from './declaration-check';
import type { Schema } from './declaration-check';
import { bookIndex, chooseFormat, editorContext, normalizeTemplate, refreshedEditorContext, withEditorDraft, withEditorGeometry, runtime, setTemplateAssets, setTemplateFiles, SpreadError, SpreadView, templateInfo, templateIssueSchema, templateSchema } from './template';
import type { AnchorLookup, EditorContext, EditorPresentation } from './template';
import type { FlowPosition, Template } from './template';
import { resolveEditPath } from './editing';
import { declaredInTemplate, familyLayouts, layoutPreviews } from './layouts';
import type { VariantTags } from './layouts';
import { numberOccurrences } from './edit-targets';
import { parsePreviewRequest, PreviewError } from './preview';
import type { PreviewMetadata, PagePreviewMetadata } from './preview';
import { inspectionSchema } from './inspection';
import type { ElementInspection, ElementMeasurement } from './inspection';
import { contactSheetLayout, fixtureBannerHeight } from './authoring-artwork';
import { Field, ProjectFilesContext } from './Fields';
import { editorChanges, unknownControl } from './editor-changes';
import { pictureTimeoutMs } from './render-budget';
import './render.css';

const post = (data: unknown) => window.parent.postMessage(data, editorURL.slice(0, -1));
// After the next painted frame. A frame that is not shown yet gets no animation frames, so a short timer stands in.
const afterPaint = () => new Promise<void>((resolve) => {
  const done = () => { clearTimeout(timer); resolve(); };
  const timer = setTimeout(done, 100);
  requestAnimationFrame(() => requestAnimationFrame(done));
});
function publish(status: RenderStatus) {
  window.imageflowRenderStatus = status;
  (globalThis as { imageflowRenderActivity?: number }).imageflowRenderActivity = Date.now();
  if (window.parent !== window) post(status);
}

function loadStyles(url?: string) {
  if (!url) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = url;
    link.onload = () => resolve();
    link.onerror = () => reject(new Error('The template stylesheet could not be loaded.'));
    document.head.append(link);
  });
}

type Target = { spread: string; box: string; source: string };
function textAssignments(book: RenderProject, template: Template) {
  const chains = new Map<string, Target[]>();
  const positions: Record<string, FlowPosition> = {};
  for (const spread of book.project.spreads) {
    const definition = template.spreads[spread.definition];
    if (!definition) continue;
    const boxes = Object.entries(definition.boxes).filter(([, box]) => box.type === 'markdown')
      .sort(([, a], [, b]) => (a.flowOrder ?? 1) - (b.flowOrder ?? 1));
    for (const [box] of boxes) {
      const source = spread.boxes[box]?.text;
      if (!source) continue;
      if (!chains.has(source)) chains.set(source, []);
      chains.get(source)!.push({ spread: spread.id, box, source });
    }
  }
  for (const [source, chain] of chains) {
    const title = (book.project.texts[source] && sourcePath(book.project.texts[source]))?.split('/').pop();
    chain.forEach(({ spread, box }, index) => {
      positions[spread + ':' + box] = { part: index + 1, parts: chain.length, title };
    });
  }
  return { chains, positions };
}

// Assigned files that are gone, unreadable, or of a type the parameter does not accept. An unassigned file
// parameter is valid; the template renders without it.
function fileErrors(book: RenderProject, schema: Parameters, values: Values, scope: string): Issue[] {
  return Object.entries(schema).flatMap(([id, param]): Issue[] => {
    const value = values[id];
    if (param.type !== 'file' || typeof value !== 'string' || !value) return [];
    const where = scope + ' · ' + param.label + ': ';
    const path = book.project.files[value];
    const found = book.files[value];
    const finding = (code: string, message: string, suggestion: string): Issue[] =>
      [{ message: where + message, code, parameter: id, source: value, suggestion }];
    if (!path || !found) {
      return finding('file-missing', 'the assigned file is no longer in the project. Choose it again.',
        'Import the file again with import_sources, then assign its new ID to parameter ' + id + '.');
    }
    if (found.problem) return finding('file-unreadable', found.problem, 'Replace the file or assign another file to parameter ' + id + '.');
    if (!param.accept.includes(found.extension)) {
      return finding('file-type', found.name + ' is not a ' + param.accept.join(' or ') + ' file. Choose another file.',
        'Assign a ' + param.accept.join(' or ') + ' file to parameter ' + id + '.');
    }
    return [];
  });
}

// Converts a measured CSS pixel distance to millimetres, rounded for reporting.
const reportedMm = (pixels: number, mmPerPixel: number) => Math.round(pixels * mmPerPixel * 10) / 10;
const ptPerMm = 72 / 25.4;

// The declared box or element that contains a node, for locating findings inside a spread.
function ownerOf(node: Element) {
  const owner = node.closest<HTMLElement>('[data-box], [data-element]');
  return owner?.dataset.box !== undefined ? { box: owner.dataset.box } : owner?.dataset.element !== undefined ? { element: owner.dataset.element } : {};
}

function validateSpread(container: HTMLElement, spread: SpreadState, template: Template, format: ResolvedFormat, where: string,
  warnings: Issue[], errors: Issue[]) {
  const sheet = container.firstElementChild;
  if (!(sheet instanceof HTMLElement) || !sheet.matches('.if-sheet') || container.childElementCount !== 1) {
    throw new Error('Spread ' + spread.id + ' must render one <Spread> at its root.');
  }
  const definition = template.spreads[spread.definition];
  const remaining = new Set(Object.keys(definition.boxes));
  const elements = new Set(Object.keys(definition.elements));
  const bounds = sheet.getBoundingClientRect();
  const mmPerPixel = format.spreadWidth / bounds.width;
  const resolution = template.format.output.resolution;
  const issue = (message: string, extra: Omit<Issue, 'message' | 'spread' | 'where'> = {}): Issue => ({ message, spread: spread.id, where, ...extra });
  const warn = (messages: string[], extra: Omit<Issue, 'message' | 'spread' | 'where'> = {}) =>
    warnings.push(...messages.map((message) => issue(message, extra)));
  // State the current layout does not show stays with the spread for other layouts; only state that no layout of
  // the template declares is reported.
  const declared = declaredInTemplate(template.spreads);
  const undeclared = (scope: string, parameters: Parameters, values: Values) =>
    Object.fromEntries(Object.entries(values).filter(([id]) => Object.hasOwn(parameters, id) || !declared.param(scope, id)));
  const parameterFix = 'Use set_parameter with a value the declaration allows, or reset_parameter to restore the default.';
  warn(parameterWarnings(definition.parameters, undeclared('', definition.parameters, spread.params), 'Layout'),
    { code: 'parameter-invalid', suggestion: parameterFix });
  for (const [id, state] of Object.entries(spread.boxes)) {
    const box = Object.hasOwn(definition.boxes, id) ? definition.boxes[id] : undefined;
    const kind = state.photo ? 'photo' : state.text ? 'text' : undefined;
    if (kind && !declared.box(id, kind)) {
      warn(['Content saved for box ' + id + ' fits no box of this template.'], { code: 'content-undeclared', box: id,
        source: state.photo ?? state.text, suggestion: 'Declare a ' + (kind === 'photo' ? 'photo' : 'markdown') + ' box ' + id +
          ' in a layout, or discard the saved assignment with clear_box (spread ' + spread.id + ', box ' + id + ').' });
      continue;
    }
    if (box && kind && (kind === 'photo') !== (box.type === 'photo')) continue;
    const parameters = box?.parameters ?? {};
    warn(parameterWarnings(parameters, undeclared('box ' + id, parameters, state.params), box?.label ?? 'Box ' + id),
      { code: 'parameter-invalid', box: id, suggestion: parameterFix });
  }
  for (const [id, state] of Object.entries(spread.elements)) {
    const element = Object.hasOwn(definition.elements, id) ? definition.elements[id] : undefined;
    if (!element && !declared.element(id)) {
      warn(['Settings saved for element ' + id + ' fit no element of this template.'], { code: 'element-undeclared', element: id,
        suggestion: 'Declare element ' + id + ' in a layout, or reset its saved parameters.' });
      continue;
    }
    const parameters = element?.parameters ?? {};
    warn(parameterWarnings(parameters, undeclared('element ' + id, parameters, state.params), element?.label ?? id),
      { code: 'parameter-invalid', element: id, suggestion: parameterFix });
  }
  // Templates report problems with their input, such as a file they cannot parse, on the node concerned.
  // Structured findings (`issue(...)`) carry their own code and location; repeated identical nodes report once.
  const reported = new Set<string>();
  for (const node of sheet.querySelectorAll<HTMLElement>('[data-issue]')) {
    if (!node.dataset.issue) continue;
    let finding: Issue;
    let severity: 'error' | 'warning' = 'warning';
    if (node.dataset.issueInfo !== undefined) {
      let info: unknown;
      try { info = JSON.parse(node.dataset.issueInfo); } catch { info = undefined; }
      const parsed = templateIssueSchema.safeParse(info);
      if (!parsed.success) {
        finding = issue('The layout reports an invalid finding: ' + (parsed.error?.issues[0]?.message ?? 'not JSON') + '.', {
          code: 'template-issue-invalid', ...ownerOf(node), suggestion: 'Pass issue() a lowercase code and a message.' });
      } else {
        const { code, message, box, element, parameter, file, details, suggestion } = parsed.data;
        severity = parsed.data.severity;
        const owner = box ? { box } : element ? { element } : ownerOf(node);
        finding = issue(message, { code: 'template:' + code, ...owner, ...(parameter ? { parameter } : {}), ...(file ? { source: file } : {}),
          ...(details ? { details } : {}), ...(suggestion ? { suggestion } : {}) });
      }
    } else finding = issue(node.dataset.issue, { code: 'template-issue', ...ownerOf(node) });
    const key = severity + JSON.stringify(finding);
    if (reported.has(key)) continue;
    reported.add(key);
    (severity === 'error' ? errors : warnings).push(finding);
  }
  const unknown = new Set([...sheet.querySelectorAll<HTMLElement>('[data-edit]')]
    .flatMap((node) => node.dataset.edit!.split(' ').filter(Boolean))
    .filter((path) => !resolveEditPath(template, spread.definition, path)));
  if (unknown.size) {
    warn(['The layout marks unknown parameters as editable: ' + [...unknown].join(', ') + '.'], { code: 'edit-path-unknown',
      details: { paths: [...unknown].join(' ') }, suggestion: 'Declare these parameters in the layout, or remove them from ctx.edit(...).' });
  }
  const boxes = new Map<string, HTMLElement>();
  for (const box of sheet.querySelectorAll<HTMLElement>('[data-box], [data-element]')) {
    const id = box.dataset.box ?? box.dataset.element!;
    if (box.dataset.element !== undefined) {
      if (!elements.delete(id)) throw new Error(where + ' renders an unknown or duplicate element: ' + id + '.');
    } else {
      if (!remaining.delete(id) || definition.boxes[id].type !== box.dataset.boxType) {
        throw new Error(where + ' renders an unknown, duplicate, or incompatible box: ' + id + '.');
      }
      if (!box.clientWidth || !box.clientHeight) throw new Error(where + ' · ' + id + ' has no area.');
      boxes.set(id, box);
      const assignment = spread.boxes[id];
      const ppi = Number(box.dataset.ppi);
      if (assignment?.photo && box.hasAttribute('data-empty')) {
        errors.push(issue(definition.boxes[id].label + ' is missing photo ' + assignment.photo + '.', {
          code: 'photo-missing', box: id, source: assignment.photo,
          suggestion: 'Restore the original file, import it again with import_sources, or assign another photo to box ' + id + '.',
        }));
      }
      if (resolution && Number.isFinite(ppi) && ppi < resolution.minimum) {
        errors.push(issue(definition.boxes[id].label + ' is ' + Math.round(ppi) + ' ppi (minimum ' + resolution.minimum + ').', {
          code: 'photo-resolution-low', box: id, source: assignment?.photo,
          details: { ppi: Math.round(ppi), minimumPpi: resolution.minimum,
            boxWidthMm: reportedMm(box.getBoundingClientRect().width, mmPerPixel),
            boxHeightMm: reportedMm(box.getBoundingClientRect().height, mmPerPixel) },
          suggestion: 'Zoom the crop out (set_crop with a smaller zoom), assign a higher-resolution photo, or switch to a layout with a smaller box.',
        }));
      }
    }
    const rect = box.getBoundingClientRect();
    const overshoot = {
      leftMm: reportedMm(bounds.left - rect.left, mmPerPixel), topMm: reportedMm(bounds.top - rect.top, mmPerPixel),
      rightMm: reportedMm(rect.right - bounds.right, mmPerPixel), bottomMm: reportedMm(rect.bottom - bounds.bottom, mmPerPixel),
    };
    if (rect.left < bounds.left - 1 || rect.top < bounds.top - 1 ||
        rect.right > bounds.right + 1 || rect.bottom > bounds.bottom + 1) {
      const owner = box.dataset.element !== undefined ? { element: id } : { box: id };
      errors.push(issue((definition.boxes[id]?.label ?? definition.elements[id]?.label ?? id) + ' extends outside the bleed.', {
        code: 'outside-bleed', ...owner,
        details: Object.fromEntries(Object.entries(overshoot).filter(([, value]) => value > 0)),
        suggestion: 'Change the template CSS so this ' + (owner.box ? 'box' : 'element') + ' stays within the sheet, which includes the bleed.',
      }));
    }
  }
  if (remaining.size) throw new Error(where + ' is missing boxes: ' + [...remaining].join(', ') + '.');
  return { sheet, boxes };
}

function checkTypography(sheet: HTMLElement, format: ResolvedFormat, minimum: number | undefined) {
  const bounds = sheet.getBoundingClientRect();
  const mmPerPixel = format.spreadWidth / bounds.width;
  const { bleed, safe, trim } = format;
  const pages = sheetPages(format);
  const text = document.createTreeWalker(sheet, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  // The smallest text below the minimum and the largest safe-area overshoot, each with the box or element it is in.
  let small: { sizeMm: number; owner: ReturnType<typeof ownerOf> } | undefined;
  let outside: { overshootMm: number; owner: ReturnType<typeof ownerOf> } | undefined;
  for (let node = text.nextNode(); node; node = text.nextNode()) {
    const parent = node.parentElement;
    if (!node.textContent?.trim() || !parent || parent.closest('.if-placeholder, svg')) continue;
    const sizeMm = parseFloat(getComputedStyle(parent).fontSize) * mmPerPixel;
    if (minimum && sizeMm < minimum && (!small || sizeMm < small.sizeMm)) small = { sizeMm, owner: ownerOf(parent) };
    range.selectNodeContents(node);
    for (const rect of range.getClientRects()) {
      if (!rect.width || !rect.height) continue;
      // x from the sheet's left bleed edge, y from the top trim edge; the text's centre picks its page.
      const x = (rect.left - bounds.left) * mmPerPixel;
      const y = (rect.top - bounds.top) * mmPerPixel - bleed.top;
      const w = rect.width * mmPerPixel;
      const h = rect.height * mmPerPixel;
      const page = pages.find(({ trimX }, i) => i === pages.length - 1 || x + w / 2 < trimX + trim.width)!;
      const leftSafe = page.trimX + page.safeLeft;
      const rightSafe = page.trimX + trim.width - page.safeRight;
      const overshootMm = Math.max(leftSafe - x, x + w - rightSafe, safe.top - y, y + h - (trim.height - safe.bottom));
      if (overshootMm > .2 && (!outside || overshootMm > outside.overshootMm)) outside = { overshootMm, owner: ownerOf(parent) };
    }
  }
  return { small, outside };
}

// A short description of a text block for findings: its box/element, its edited parameter, its tag and text.
function textOwner(block: HTMLElement) {
  const owner = ownerOf(block);
  const parameter = block.closest<HTMLElement>('[data-edit]')?.dataset.edit;
  const text = (block.textContent ?? '').replace(/\s+/g, ' ').trim();
  const self = block.dataset.box !== undefined || block.dataset.element !== undefined;
  return { ...owner, ...(parameter ? { parameter } : {}), tag: block.localName, self, text: text.length > 60 ? text.slice(0, 59) + '…' : text };
}
const describe = ({ box, element, parameter, tag, self }: ReturnType<typeof textOwner>) => {
  const owner = box !== undefined ? 'box ' + box : element !== undefined ? 'element ' + element : '';
  if (self && owner) return owner;
  return '<' + tag + '>' + (parameter ? ' showing ' + parameter : '') + (owner ? ' in ' + owner : '');
};

/** Text blocks whose text spills out of their own fixed-size box, or overlaps text in another block. Flowing Markdown
 * boxes report overflow through text flow, and text inside them is not compared with itself. */
function checkTextBlocks(sheet: HTMLElement, format: ResolvedFormat) {
  const bounds = sheet.getBoundingClientRect();
  const mmPerPixel = format.spreadWidth / bounds.width;
  const lines = new Map<HTMLElement, DOMRect[]>();
  const walker = document.createTreeWalker(sheet, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  // Hidden or fully transparent text still has layout rectangles, but nobody sees it overflow or overlap.
  const transparent = new Map<Element, boolean>();
  const invisible = (element: Element): boolean => {
    if (element === sheet) return false;
    let known = transparent.get(element);
    if (known === undefined) {
      known = getComputedStyle(element).opacity === '0' || (!!element.parentElement && invisible(element.parentElement));
      transparent.set(element, known);
    }
    return known;
  };
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    let block = node.parentElement;
    if (!node.textContent?.trim() || !block || block.closest('.if-placeholder, svg')) continue;
    if (getComputedStyle(block).visibility !== 'visible' || invisible(block)) continue;
    while (block && block !== sheet && ['inline', 'contents'].includes(getComputedStyle(block).display)) block = block.parentElement;
    if (!block || block === sheet) continue;
    range.selectNodeContents(node);
    const rects = [...range.getClientRects()].filter(({ width, height }) => width > 0.5 && height > 0.5);
    lines.set(block, [...lines.get(block) ?? [], ...rects]);
  }
  const markdown = (block: HTMLElement) => block.closest('[data-box-type="markdown"]');
  // Half a millimetre absorbs sub-pixel rounding when comparing glyph rectangles.
  const tolerance = 0.5 / mmPerPixel;
  const overflows: { owner: ReturnType<typeof textOwner>; clipped: boolean; bottomMm: number; rightMm: number; clippedBy?: ReturnType<typeof textOwner> }[] = [];
  for (const [block, rects] of lines) {
    if (markdown(block) || !rects.length) continue;
    const style = getComputedStyle(block);
    if (style.textOverflow === 'ellipsis') continue;
    // Line-height slack below the last line is not a visible overflow; a quarter line or more means text does not fit.
    const fontSize = parseFloat(style.fontSize), lineHeight = parseFloat(style.lineHeight);
    const threshold = Math.max(tolerance, 0.25 * (Number.isFinite(lineHeight) ? lineHeight : fontSize * 1.2));
    const bottom = block.scrollHeight - block.clientHeight, right = block.scrollWidth - block.clientWidth;
    if (bottom >= threshold || right >= threshold) {
      const clipped = [style.overflowX, style.overflowY].some((value) => value !== 'visible');
      overflows.push({ owner: textOwner(block), clipped, bottomMm: Math.max(0, bottom) * mmPerPixel, rightMm: Math.max(0, right) * mmPerPixel });
      continue;
    }
    // A container further out can cut the text off even when the block itself fits its text.
    const text = { top: Math.min(...rects.map(({ top }) => top)), bottom: Math.max(...rects.map(({ bottom }) => bottom)),
      left: Math.min(...rects.map(({ left }) => left)), right: Math.max(...rects.map(({ right }) => right)) };
    for (let ancestor = block.parentElement; ancestor && ancestor !== sheet; ancestor = ancestor.parentElement) {
      const clip = getComputedStyle(ancestor);
      const clipX = clip.overflowX !== 'visible', clipY = clip.overflowY !== 'visible';
      if (!clipX && !clipY) continue;
      const outer = ancestor.getBoundingClientRect();
      const inner = { left: outer.left + ancestor.clientLeft, top: outer.top + ancestor.clientTop };
      const cutBottom = clipY ? Math.max(0, text.bottom - (inner.top + ancestor.clientHeight), inner.top - text.top) : 0;
      const cutRight = clipX ? Math.max(0, text.right - (inner.left + ancestor.clientWidth), inner.left - text.left) : 0;
      if (cutBottom < threshold && cutRight < threshold) continue;
      overflows.push({ owner: textOwner(block), clipped: true, bottomMm: cutBottom * mmPerPixel, rightMm: cutRight * mmPerPixel, clippedBy: textOwner(ancestor) });
      break;
    }
  }
  const overlaps: { owner: ReturnType<typeof textOwner>; other: ReturnType<typeof textOwner>; overlapMm: number }[] = [];
  const blocks = [...lines.keys()];
  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) {
      const a = blocks[i], b = blocks[j];
      if (a.contains(b) || b.contains(a) || (markdown(a) && markdown(a) === markdown(b))) continue;
      let overlap = 0;
      for (const p of lines.get(a)!) for (const q of lines.get(b)!) {
        const width = Math.min(p.right, q.right) - Math.max(p.left, q.left), height = Math.min(p.bottom, q.bottom) - Math.max(p.top, q.top);
        if (width > tolerance && height > tolerance) overlap = Math.max(overlap, height);
      }
      if (overlap) overlaps.push({ owner: textOwner(a), other: textOwner(b), overlapMm: overlap * mmPerPixel });
    }
  }
  return { overflows: overflows.slice(0, 5), overlaps: overlaps.slice(0, 5) };
}

// True when nothing between the box and its sheet rotates, skews or mirrors it, so its on-screen rectangle is the
// box itself. Crop mode draws the photo over that rectangle. The sheet's own preview scaling is not checked.
function upright(box: HTMLElement, sheet: HTMLElement) {
  for (let node: HTMLElement | null = box; node && node !== sheet; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.transform !== 'none') {
      const matrix = new DOMMatrixReadOnly(style.transform);
      if (!matrix.is2D || Math.abs(matrix.b) > 1e-6 || Math.abs(matrix.c) > 1e-6 || matrix.a <= 0 || matrix.d <= 0) return false;
    }
    if (style.rotate && style.rotate !== 'none' && !/^0(deg|rad|grad|turn)?$/.test(style.rotate)) return false;
    if (style.scale && style.scale !== 'none' && style.scale.split(/\s+/).some((value) => parseFloat(value) < 0)) return false;
  }
  return true;
}

// Fits sheets to the frame width and reports where sheets and boxes landed. In book grid mode, each sheet fits
// one column and book order runs left to right, then continues on the next row. The book grows vertically.
type GridRequest = { columns: number };
function layoutBook(root: HTMLElement, sheets: { spread: string; sheet: HTMLElement }[], view: BookView, format: ResolvedFormat, initial?: GridRequest) {
  if (view === 'thumbs') {
    let animations: Animation[] = [];
    window.addEventListener('message', (event: MessageEvent) => {
      if (event.source !== parent || event.origin !== 'imageflow://editor') return;
      if (event.data?.type === 'prepare-reorder' && Array.isArray(event.data.offsets)) {
        animations.forEach(animation => animation.cancel());
        animations = [];
        if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
          for (const offset of event.data.offsets as ReorderOffset[]) {
            if (typeof offset.spread !== 'string' || !Number.isFinite(offset.x) || !Number.isFinite(offset.y)) continue;
            const slot = sheets.find(sheet => sheet.spread === offset.spread)?.sheet.parentElement;
            if (!slot) continue;
            const animation = animateReorder(slot, offset);
            animation.pause();
            animation.currentTime = 0;
            animations.push(animation);
          }
        }
        post({ type: 'reorder-ready' });
      } else if (event.data?.type === 'play-reorder' && Number.isFinite(event.data.start)) {
        for (const animation of animations) {
          animation.play();
          animation.startTime = event.data.start - performance.timeOrigin;
        }
      } else if (event.data?.type === 'cancel-reorder') {
        animations.forEach(animation => animation.cancel());
        animations = [];
      }
    });
  }
  const { pad, gap, columns = 1, columnGap = 0 } = bookLayout[view];
  root.style.setProperty('--if-pad', pad + 'px');
  root.style.setProperty('--if-gap', gap + 'px');
  root.style.setProperty('--if-columns', String(columns));
  root.style.setProperty('--if-column-gap', columnGap + 'px');
  const relative = (node: Element): Rect => {
    const { x, y, width, height } = node.getBoundingClientRect();
    return { x: x + scrollX, y: y + scrollY, width, height };
  };
  let gridColumns = view === 'book' ? initial?.columns ?? 0 : 0;
  let laidOut = '';
  function fit() {
    const width = root.clientWidth;
    const size = gridColumns + 'x' + width;
    if (size === laidOut) return;
    laidOut = size;
    root.classList.toggle('if-grid', gridColumns > 0);
    const count = gridColumns || columns;
    root.style.setProperty('--if-columns', String(count));
    const column = (width - pad * 2 - (gridColumns ? gap : columnGap) * (count - 1)) / count;
    for (const { sheet } of sheets) {
      const fitted = column / sheet.offsetWidth;
      const scale = Math.max(0.01, Math.min(fitted, 1));
      const slot = sheet.parentElement!;
      slot.style.width = sheet.offsetWidth * scale + 'px';
      slot.style.height = sheet.offsetHeight * scale + 'px';
      sheet.style.setProperty('--if-zoom', String(scale));
    }
    const bounds = root.getBoundingClientRect();
    const geometry: BookGeometry = {
      type: 'geometry', width: Math.ceil(bounds.width), height: Math.ceil(bounds.height), ...(gridColumns ? { columns: gridColumns } : {}),
      sheets: sheets.map(({ spread, sheet }) => ({ spread, ...relative(sheet), zoom: Number(sheet.style.getPropertyValue('--if-zoom')) || 1 })),
      boxes: sheets.flatMap(({ spread, sheet }) => {
        const scale = Number(sheet.style.getPropertyValue('--if-zoom')) || 1;
        const origin = measuredBounds(sheet.querySelector<HTMLElement>('.if-spread')!, sheet, format);
        return [...sheet.querySelectorAll<HTMLElement>('[data-box], [data-element]')].map((box) => {
          const rect = relative(box);
          const measured = measuredBounds(box, sheet, format);
          const sized = Math.abs(rect.width - box.offsetWidth * scale) < 1.5 && Math.abs(rect.height - box.offsetHeight * scale) < 1.5;
          return {
            spread, id: (box.dataset.box ?? box.dataset.element)!, upright: sized && upright(box, sheet),
            rect: { ...measured, x: measured.x - origin.x, y: measured.y - origin.y },
            type: (box.dataset.boxType ?? 'element') as BookGeometry['boxes'][number]['type'], ...rect,
          };
        });
      }),
      // Nodes that edit the same fields on a sheet, such as a heading shown twice, are told apart by occurrence.
      targets: sheets.flatMap(({ spread, sheet }) => numberOccurrences([...sheet.querySelectorAll<HTMLElement>('[data-edit]')].map((node) => ({
        spread, edits: node.dataset.edit!.split(' ').filter(Boolean), ...relative(node), upright: upright(node, sheet),
        ...(node.dataset.textFallback ? { textFallback: { parameter: node.dataset.edit!, text: node.dataset.textFallback,
          label: node.dataset.textFallbackLabel ?? 'inherited text' } } : {}),
        ...(node.dataset.box ? { owner: { type: 'box' as const, id: node.dataset.box } }
          : node.dataset.element ? { owner: { type: 'element' as const, id: node.dataset.element } } : {}),
      })))),
    };
    post(geometry);
  }
  root.classList.add('if-book', 'if-view-' + view);
  if (view === 'book') {
    // An inline editor is drawn over one element, or one marked node, while it is open; the app asks this frame to
    // hide that occurrence's artwork meanwhile, and to show it again after. Only this preview frame changes.
    let hidden: HTMLElement[] = [];
    window.addEventListener('message', (event: MessageEvent) => {
      if (event.source !== parent || event.origin !== editorURL.slice(0, -1) || event.data?.type !== 'inline-editing') return;
      for (const node of hidden) node.removeAttribute('data-if-editing');
      hidden = [];
      const { spread, element, edits, occurrence, key } = event.data;
      // Answered once drawn, so the app shows a frame, or removes an editor, only when the artwork is right.
      void afterPaint().then(() => post({ type: 'inline-editing-applied', key }));
      const sheet = sheets.find((item) => item.spread === spread)?.sheet;
      if (!sheet) return;
      if (typeof element === 'string') {
        hidden = [...sheet.querySelectorAll<HTMLElement>('[data-element]')].filter((node) => node.dataset.element === element);
      } else if (typeof edits === 'string') {
        const marked = [...sheet.querySelectorAll<HTMLElement>('[data-edit]')]
          .filter((node) => node.dataset.edit!.split(' ').filter(Boolean).join(' ') === edits)[Number(occurrence) || 0];
        if (marked) hidden = [marked];
      }
      for (const node of hidden) node.setAttribute('data-if-editing', '');
    });
  }
  fit();
  new ResizeObserver(fit).observe(root);
  // A custom editor consumes actual element sizes, including CSS layout changes within a stable viewport.
  let measuring = false;
  const measure = () => {
    if (measuring) return;
    measuring = true;
    requestAnimationFrame(() => { measuring = false; laidOut = ''; fit(); });
  };
  const elements = new ResizeObserver(measure);
  for (const { sheet } of sheets) for (const node of sheet.querySelectorAll<HTMLElement>('[data-element]')) elements.observe(node);
  // Position can change without resizing: a class/style change or a sibling's content may move an element.
  // Observe template content only; fit() writes the surrounding sheet/slot styles, so it cannot retrigger this.
  const layout = new MutationObserver(measure);
  for (const { sheet } of sheets) layout.observe(sheet.querySelector('.if-spread')!, {
    subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'open'],
  });
  window.addEventListener('resize', fit);
  return (next: GridRequest) => {
    if (view !== 'book') return;
    gridColumns = next.columns;
    fit();
  };
}

type Failure = { message: string; stack?: string };
// The message of an error, and the stack of its innermost cause, where template code threw.
function failure(error: unknown): Failure {
  let deepest = error;
  while (deepest instanceof Error && deepest.cause instanceof Error) deepest = deepest.cause;
  const stack = deepest instanceof Error ? deepest.stack : undefined;
  return { message: error instanceof Error ? error.message : String(error), ...(stack ? { stack: stack.slice(0, 4000) } : {}) };
}

class LayoutRenderError extends Error {
  constructor(readonly failures: Map<string, Failure>) {
    super('Layouts failed to render: ' + [...failures].map(([spread, { message }]) => spread + ': ' + message).join('; '));
  }
}

// Template declarations that do not satisfy the template contract, by declaration path.
class DeclarationError extends Error {
  constructor(message: string, readonly issues: { path: string; message: string }[]) { super(message); }
}

// Outside the editor, a layout that throws is attributed to its spread; the book still fails as a whole, except that
// a fixture book reports which fixtures failed so the others can be rendered without them.
class LayoutBoundary extends React.Component<{ spread: string; failures: Map<string, Failure>; children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown) { this.props.failures.set(this.props.spread, failure(error)); }
  render() { return this.state.failed ? null : this.props.children; }
}

// Both PDF pages and artwork captures start from a fully flowed sheet and use the same bleed offsets.
function sheetCrop(format: ResolvedFormat, side: PrintSide, bounds: PreviewMetadata['bounds']) {
  const { trim, bleed, spreadWidth, height } = format;
  if (side === 'spread') {
    if (bounds === 'bleed') return { x: 0, y: 0, widthMm: spreadWidth, heightMm: height };
    return { x: sheetBleed(format).left, y: bleed.top, widthMm: trim.width * 2, heightMm: trim.height };
  }
  const pages = sheetPages(format);
  const page = pages.find((candidate) => candidate.side === side) ?? pages[0];
  if (bounds === 'bleed') return { x: page.bleedX, y: 0, widthMm: page.bleedWidth, heightMm: height };
  return { x: page.trimX, y: bleed.top, widthMm: trim.width, heightMm: trim.height };
}

function croppedSheet(sheet: HTMLElement, crop: ReturnType<typeof sheetCrop>, pixels?: { width: number; height: number }) {
  const page = document.createElement('div');
  page.className = 'if-print-page';
  page.style.width = cssMM(crop.widthMm);
  page.style.height = cssMM(crop.heightMm);
  const clone = sheet.cloneNode(true) as HTMLElement;
  let scaleX = 1;
  let scaleY = 1;
  if (pixels) {
    // Lay out the artwork in millimetres, then fit the crop to the integer raster dimensions.
    scaleX = pixels.width / (crop.widthMm * 96 / 25.4);
    scaleY = pixels.height / (crop.heightMm * 96 / 25.4);
    page.classList.add('if-artwork');
    page.style.width = pixels.width + 'px';
    page.style.height = pixels.height + 'px';
    clone.style.transformOrigin = '0 0';
    clone.style.transform = 'scale(' + scaleX + ', ' + scaleY + ')';
    clone.style.top = cssMM(-crop.y * scaleY);
  }
  clone.style.left = cssMM(-crop.x * scaleX);
  page.append(clone);
  return page;
}

function makePrintPages(root: HTMLElement, sheets: HTMLElement[], sequence: ReturnType<typeof pageSequence>, format: ResolvedFormat) {
  const style = document.createElement('style');
  const { outputWidth, height } = format;
  style.textContent = '@page { size: ' + cssMM(outputWidth) + ' ' + cssMM(height) + '; margin: 0; }';
  document.head.append(style);
  const pages = document.createDocumentFragment();
  for (const [index, sheet] of sheets.entries()) {
    for (const side of sequence.spreads[index].sides) {
      pages.append(croppedSheet(sheet, sheetCrop(format, side, 'bleed')));
    }
  }
  root.hidden = true;
  document.body.append(pages);
}

function artworkTarget(spreads: SpreadState[], sequence: ReturnType<typeof pageSequence>, target: Exclude<ReturnType<typeof parsePreviewRequest>['target'], { spreads: string[] }>): { index: number; side: PrintSide; page: UnitPages; spread: string } {
  if ('page' in target) {
    const index = sequence.spreads.findIndex(({ page }) => pageNumbers(page).includes(target.page));
    if (index < 0) throw new PreviewError('preview-target-not-found', 'Page ' + target.page + ' does not exist in this book.');
    const { page } = sequence.spreads[index];
    const side = page.number !== undefined ? 'page' : page.left === target.page ? 'left' : 'right';
    return { index, side, page: side === 'page' ? { number: target.page } : { [side]: target.page }, spread: spreads[index].id };
  }
  const index = spreads.findIndex(({ id }) => id === target.spread);
  if (index < 0) throw new PreviewError('preview-target-not-found', 'Spread ' + target.spread + ' does not exist in this book.');
  const { span, page } = sequence.spreads[index];
  // A unit without facing pages is one page; a single-page layout in a facing format is drawn as a spread.
  const side = ('side' in target ? target.side : undefined) ?? (page.number !== undefined ? 'page' : span === 'page' ? 'spread' : span);
  if (page.number !== undefined) {
    if (side !== 'page') throw new PreviewError('preview-target-not-found', 'Page ' + target.spread + ' has no ' + side + ' side: this format has no facing pages.');
    return { index, side, page, spread: target.spread };
  }
  if (side === 'spread') return { index, side, page, spread: target.spread };
  const number = side === 'page' ? undefined : page[side];
  if (!number) throw new PreviewError('preview-target-not-found', 'Spread ' + target.spread + ' has no ' + side + ' page.');
  return { index, side, page: { [side]: number }, spread: target.spread };
}

function measuredBounds(node: HTMLElement, sheet: HTMLElement, format: ResolvedFormat) {
  const outer = sheet.getBoundingClientRect(), rect = node.getBoundingClientRect();
  const scale = format.spreadWidth / outer.width;
  return { x: (rect.left - outer.left) * scale, y: (rect.top - outer.top) * scale, width: rect.width * scale, height: rect.height * scale };
}

function inspectElements(sheet: HTMLElement, spread: SpreadState, template: Template, format: ResolvedFormat,
  request: ReturnType<typeof inspectionSchema.parse>): ElementInspection {
  const nodes = [...sheet.querySelectorAll<HTMLElement>('[data-box], [data-element]')].filter((node) =>
    (!request.box || node.dataset.box === request.box) && (!request.element || node.dataset.element === request.element));
  if ((request.box || request.element) && !nodes.length) throw new PreviewError('preview-target-not-found', 'The requested box or element is not rendered on spread ' + spread.id + '.');
  const definition = template.spreads[spread.definition];
  const items: ElementMeasurement[] = nodes.slice(request.offset, request.offset + request.limit).map((node) => {
    const box = node.dataset.box, id = box ?? node.dataset.element!, kind = box ? definition.boxes[id].type : 'element';
    const prefix = (box ? 'boxes.' : 'elements.') + id + '.';
    const parameters = box ? definition.boxes[id].parameters : definition.elements[id].parameters;
    const style = getComputedStyle(node);
    const points = (value: string) => Math.round(parseFloat(value) * 72 / 96 * 100) / 100;
    const source = box ? spread.boxes[id]?.photo ?? spread.boxes[id]?.text : undefined;
    return { spread: spread.id, id, kind, boundsMm: measuredBounds(node, sheet, format), upright: upright(node, sheet),
      typography: { fontFamily: style.fontFamily, fontSizePt: points(style.fontSize),
        lineHeightPt: style.lineHeight === 'normal' ? null : points(style.lineHeight), fontWeight: style.fontWeight, color: style.color },
      editPaths: Object.keys(parameters).map((key) => prefix + key), ...(source ? { source } : {}) };
  });
  return { spread: spread.id, coordinateSpace: 'sheet-bleed-mm', items, total: nodes.length,
    nextOffset: request.offset + items.length < nodes.length ? request.offset + items.length : null };
}

type MmRect = { x: number; y: number; width: number; height: number };
const overlayStyle = (rect: MmRect, extra: Partial<CSSStyleDeclaration>) => ({
  position: 'absolute', left: cssMM(rect.x), top: cssMM(rect.y), width: cssMM(rect.width), height: cssMM(rect.height),
  boxSizing: 'border-box', ...extra,
});

/** Draws requested authoring overlays onto a sheet after all checks and measurements: trim and safe-area guides, and
 * outlined, labelled boxes and elements. Coordinates are millimetres from the sheet's outer bleed corner, so the
 * overlays scale and crop with the artwork. */
function annotateSheet(sheet: HTMLElement, format: ResolvedFormat, { guides, labels }: { guides: boolean; labels: boolean }) {
  const layer = document.createElement('div');
  Object.assign(layer.style, { position: 'absolute', inset: '0', pointerEvents: 'none', zIndex: '2147483647' });
  const add = (rect: MmRect, extra: Partial<CSSStyleDeclaration>, text?: string) => {
    const node = document.createElement('div');
    Object.assign(node.style, overlayStyle(rect, extra));
    if (text) {
      const tag = document.createElement('span');
      tag.textContent = text;
      Object.assign(tag.style, { position: 'absolute', left: '0', top: '0', background: '#ff6a00', color: '#fff',
        font: '600 2.6mm/1.25 sans-serif', padding: '0 0.8mm', whiteSpace: 'nowrap' });
      node.append(tag);
    }
    layer.append(node);
  };
  if (labels) {
    for (const node of sheet.querySelectorAll<HTMLElement>('[data-box], [data-element]')) {
      const rect = measuredBounds(node, sheet, format);
      add(rect, { border: '0.35mm solid #ff6a00' }, node.dataset.box !== undefined ? 'box ' + node.dataset.box : 'element ' + node.dataset.element);
    }
  }
  if (guides) {
    const { trim, bleed, safe } = format;
    for (const { trimX, safeLeft, safeRight } of sheetPages(format)) {
      add({ x: trimX, y: bleed.top, width: trim.width, height: trim.height }, { border: '0.3mm solid #e6007e' });
      add({ x: trimX + safeLeft, y: bleed.top + safe.top, width: trim.width - safeLeft - safeRight,
        height: trim.height - safe.top - safe.bottom }, { border: '0.3mm dashed #00a3e0' });
    }
  }
  sheet.append(layer);
}

function renderArtwork(root: HTMLElement, sheets: HTMLElement[], spreads: SpreadState[], sequence: ReturnType<typeof pageSequence>,
  format: ResolvedFormat, artwork: ReturnType<typeof parsePreviewRequest>, fixture?: FixtureMarking) {
  const { bounds, maxEdge, guides, labels } = artwork;
  const overlays = { ...(guides ? { guides: true as const } : {}), ...(labels ? { labels: true as const } : {}) };
  const annotated = new Set<number>();
  const annotate = (index: number) => {
    if ((guides || labels) && !annotated.has(index)) annotateSheet(sheets[index], format, { guides, labels });
    annotated.add(index);
  };
  // Synthetic fixture artwork is only delivered inside its labelled, bannered contact sheet.
  if (fixture && !('spreads' in artwork.target)) {
    throw new PreviewError('invalid-preview-request', 'Fixture artwork is only available as a labelled contact sheet.');
  }
  if ('spreads' in artwork.target) {
    const targets = artwork.target.spreads.map((spread) => artworkTarget(spreads, sequence, { spread }));
    for (const { index } of targets) annotate(index);
    const crops = targets.map(({ side }) => sheetCrop(format, side, bounds));
    const header = fixture ? fixtureBannerHeight(maxEdge) : 0;
    const grid = contactSheetLayout(crops, maxEdge, artwork.target.columns, header);
    const frame = document.createElement('div');
    frame.className = 'if-artwork';
    Object.assign(frame.style, { width: grid.width + 'px', height: grid.height + 'px', overflow: 'hidden',
      background: fixture ? 'repeating-linear-gradient(135deg, #f2c94c 0 8px, #fbe7a1 8px 16px)' : '#e9e9e9' });
    if (fixture) {
      const banner = document.createElement('div');
      banner.textContent = fixture.banner;
      Object.assign(banner.style, { position: 'absolute', left: '0', top: '0', width: grid.width + 'px', height: header + 'px',
        background: '#1d1d1d', color: '#f2c94c', font: 'bold ' + Math.round(header * 0.55) + 'px/' + header + 'px sans-serif',
        overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', textAlign: 'center', letterSpacing: '0.04em' });
      frame.append(banner);
    }
    const cells = targets.map(({ index, spread, side, page }, i) => {
      const { x, y, width, height, label: labelRect } = grid.cells[i], crop = crops[i];
      const image = croppedSheet(sheets[index], crop, { width, height });
      Object.assign(image.style, { position: 'absolute', left: x + 'px', top: y + 'px' });
      const label = fixture ? 'FIXTURE · ' + (fixture.labels[spread] ?? spread) : spread + ' · ' + pageLabel(page);
      const caption = document.createElement('div');
      caption.textContent = label;
      Object.assign(caption.style, { position: 'absolute', left: labelRect.x + 'px', top: labelRect.y + 'px',
        width: labelRect.width + 'px', height: labelRect.height + 'px', font: (fixture ? 'bold ' : '') + '11px/16px sans-serif', color: '#111',
        overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', textAlign: 'center' });
      frame.append(image, caption);
      return { x, y, width, height, widthMm: crop.widthMm, heightMm: crop.heightMm, spread, side, page, bounds, label };
    });
    root.hidden = true;
    document.body.append(frame);
    return { frame, metadata: { kind: 'contact-sheet', width: grid.width, height: grid.height, bounds, columns: grid.columns, cells,
      ...(fixture ? { banner: { text: fixture.banner, height: header } } : {}), ...overlays } as PreviewMetadata };
  }
  const target = artworkTarget(spreads, sequence, artwork.target);
  const { index, side, page, spread } = target;
  let crop = sheetCrop(format, side, bounds);
  let detail: PagePreviewMetadata['detail'];
  if ('box' in artwork.target || 'element' in artwork.target) {
    const request = artwork.target;
    const box = 'box' in request ? request.box : undefined, element = 'element' in request ? request.element : undefined;
    const node = [...sheets[index].querySelectorAll<HTMLElement>('[data-box], [data-element]')]
      .find((node) => box ? node.dataset.box === box : node.dataset.element === element);
    if (!node) throw new PreviewError('preview-target-not-found', 'The requested box or element is not rendered on spread ' + spread + '.');
    const rect = measuredBounds(node, sheets[index], format), padding = request.paddingMm;
    const x = Math.max(crop.x, rect.x - padding), y = Math.max(crop.y, rect.y - padding);
    const right = Math.min(crop.x + crop.widthMm, rect.x + rect.width + padding);
    const bottom = Math.min(crop.y + crop.heightMm, rect.y + rect.height + padding);
    if (right <= x || bottom <= y) throw new PreviewError('preview-target-not-found', 'The element has no visible area within the requested page bounds.');
    crop = { x, y, widthMm: right - x, heightMm: bottom - y };
    detail = { ...(box ? { box } : { element }), xMm: x, yMm: y };
  }
  annotate(index);
  const { widthMm, heightMm } = crop, scale = maxEdge / Math.max(widthMm, heightMm);
  const width = Math.max(1, Math.round(widthMm * scale)), height = Math.max(1, Math.round(heightMm * scale));
  const frame = croppedSheet(sheets[index], crop, { width, height });
  root.hidden = true;
  document.body.append(frame);
  return { frame, metadata: { width, height, widthMm, heightMm, bounds, spread, side, page, ...(detail ? { detail } : {}), ...overlays } as PreviewMetadata };
}

// Font faces that were requested but could not be loaded. The book renders with a fallback font instead.
function fontFailures() {
  return [...new Set([...document.fonts].filter((font) => font.status === 'error')
    .map((font) => font.family.replace(/^["']|["']$/g, '')))].sort();
}

// Waits for fonts and photos so measurements and text flow see final metrics.
async function settle(images: HTMLImageElement[]) {
  // A font that fails to load is reported by `fontFailures` rather than aborting the render.
  const [, decoded] = await Promise.all([
    Promise.allSettled([...document.fonts].map((font) => font.load())),
    Promise.allSettled(images.map((img) => img.decode())),
  ]);
  await document.fonts.ready;
  // Hidden frames may not get animation frames; the timeout keeps the render from stalling.
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    setTimeout(resolve, 100);
  });
  return decoded;
}

// Renders one spread in every layout of the template, carrying its content over the way switching layouts does.
// Markdown boxes show their source from the beginning; the previews are for choosing a layout, not for proofing.
async function renderLayouts(root: HTMLElement, book: RenderProject, template: Template, info: TemplateInfo, spreadId: string) {
  const { spreads } = book.project;
  const index = spreads.findIndex(({ id }) => id === spreadId);
  if (index < 0) throw new Error('Spread does not exist.');
  const format = resolveFormat(template.format);
  const sequence = pageSequence(spreads.map((spread) => template.spreads[spread.definition]?.span ?? 'spread'), template.format);
  // A preview is the spread itself in another layout: switching only changes which of its content is shown.
  // A family with its own picker shows one preview, which stands for the family.
  const previews = layoutPreviews(template.spreads, spreads[index].definition, template.layoutFamilies, template.format, { index, count: spreads.length }).map((definition) => ({
    definition, span: template.spreads[definition].span, spread: { ...spreads[index], definition, id: definition },
  }));
  // Previews read the anchors of the book as saved, so a contents layout shows the real pages.
  const anchors = bookIndex(book, template, sequence);
  root.className = 'if-preview';
  let renderError: unknown;
  const react = createRoot(root, { onUncaughtError: (error) => { renderError = error; } });
  flushSync(() => react.render(previews.map(({ definition, span, spread }) => (
    <div className="if-spread-container" data-span={span} data-spread={definition} data-layout={definition} key={definition}>
      <SpreadView book={book} spread={spread} template={template} format={format} positions={{}}
        page={sequence.spreads[index].page} index={anchors} renderPhotos />
    </div>
  ))));
  if (renderError) throw renderError;
  await settle([...root.querySelectorAll('img')]);
  const containers = root.querySelectorAll<HTMLElement>('.if-spread-container');
  const sheets = previews.map(({ definition, spread }, n) => {
    const { sheet, boxes } = validateSpread(containers[n], spread, template, format, definition, [], []);
    const sources = new Map<string, HTMLElement[]>();
    const order = Object.entries(template.spreads[definition].boxes).sort(([, a], [, b]) => (a.flowOrder ?? 1) - (b.flowOrder ?? 1));
    for (const [box] of order) {
      const source = spread.boxes[box]?.text;
      if (source && book.texts[source] !== undefined && boxes.has(box)) sources.set(source, [...sources.get(source) ?? [], boxes.get(box)!]);
    }
    for (const [source, targets] of sources) flow.run(markdownToHtml(book.texts[source]), targets, 'columns');
    return { spread: definition, sheet };
  });
  layoutBook(root, sheets, 'layouts', format);
  await settleRestoredImages();
  publish({ state: 'ready', template: info, pages: sequence.count, units: [], errors: [], warnings: [], flow: {}, anchors: anchors.anchors });
}

// Loads the photos of spreads within a screen of the visible range and unloads those more than three screens
// away, so memory and the work per edit follow what is on screen rather than the length of the book.
type Viewport = { top: number; bottom: number; left: number; right: number };
// Loads the photos of spreads within a screen's distance of the visible area, in both directions, and unloads those
// far from it.
function photoLoader(root: HTMLElement, visible: () => Viewport | undefined) {
  const containers = [...root.querySelectorAll<HTMLElement>('.if-spread-container')];
  return () => {
    const range = visible() ?? { top: 0, bottom: screen.height, left: 0, right: screen.width };
    const height = Math.max(1, range.bottom - range.top);
    const width = Math.max(1, range.right - range.left);
    const loading: HTMLImageElement[] = [];
    for (const container of containers) {
      const { top, bottom, left, right } = container.getBoundingClientRect();
      const within = (distance: number) => bottom > range.top - distance * height && top < range.bottom + distance * height &&
        right > range.left - distance * width && left < range.right + distance * width;
      const near = within(1);
      const far = !within(3);
      for (const img of container.querySelectorAll<HTMLImageElement>('img[data-src]')) {
        if (near && !img.getAttribute('src')) {
          img.src = img.dataset.src!;
          loading.push(img);
        } else if (far && img.getAttribute('src')) img.removeAttribute('src');
      }
    }
    return loading;
  };
}

// Runs a template-supplied editor: an element's, or a document editor opened from a spread. The component edits a
// draft of the editor's parameters; the frame reports the draft, its height, and commit or cancel to the app, which
// validates and saves. The frame never changes project data itself. Its read-only context follows the book: the app
// names each newer render session, and the frame recomputes the context from it.
function renderEditor(root: HTMLElement, book: RenderProject, template: Template, spreadId: string, target: { element: string } | { editor: string }, readOnly: boolean,
  presentation: EditorPresentation) {
  const spread = book.project.spreads.find(({ id }) => id === spreadId);
  const layout = spread && template.spreads[spread.definition];
  const documentEditor = 'editor' in target && Object.hasOwn(template.editors ?? {}, target.editor) ? template.editors![target.editor] : undefined;
  const element = 'element' in target ? layout?.elements[target.element] : undefined;
  const elementId = 'element' in target ? target.element : '';
  const editor = documentEditor ?? element?.editor;
  const opened = editorContext(book, template, spreadId);
  if (!spread || !layout || !editor || !opened || (!documentEditor && !element)) throw new Error('This element has no editor.');
  // The editor's own scope: the element's parameters, or the document's for a document editor.
  const declared = documentEditor ? template.parameters : element!.parameters;
  const saved = documentEditor ? resolveParams(template.parameters, book.project.params) : resolveParams(element!.parameters, spread.elements[elementId]?.params ?? {});
  const savedSpread = resolveParams(layout.parameters, spread.params);
  const ownedSpread = documentEditor ? [] : element!.editor?.spread ?? [];
  const claimed = (values: Values) => Object.fromEntries(editor.parameters.map((key) => [key, values[key]]));
  const claimedSpread = (values: Values) => Object.fromEntries(ownedSpread.map((key) => [key, values[key]]));
  let seen = opened.context;
  let contextKey = opened.key;
  let updateContext: ((context: EditorContext) => void) | undefined;
  // Inline, the frame is the element's own rectangle at its printed size, which the app scales with the page; it
  // reports the scale as --if-inline-scale, so UI in the editor can keep its screen size.
  root.className = presentation === 'inline' ? 'if-editor if-editor-inline' : 'if-editor';
  // The project's file registry for file controls. An import adds to it, so it is state the host can update.
  let projectFiles = book.project.files;
  let updateFiles: ((files: Record<string, SourceReference>) => void) | undefined;

  // The draft lives outside React so set() followed directly by commit() sends the newest values, before React
  // has rendered them. Every message is posted in order, and commit carries the draft as well. The element's and
  // the layout's parameters are separate drafts, since the same ID can name a parameter in each scope.
  let draft: Values = saved;
  let spreadDraft: Values = savedSpread;
  let changed = false;
  let failed = false;
  const fail = (error: unknown) => {
    if (failed) return;
    failed = true;
    const reason = error instanceof Error ? error.message : String(error);
    post({ state: 'error', message: 'The editor stopped working: ' + reason });
  };
  const drafts = () => changed ? { values: claimed(draft), spread: claimedSpread(spreadDraft) } : { values: {}, spread: {} };
  const commit = () => {
    try { (window.document.activeElement as HTMLElement | null)?.blur?.(); }
    catch (error) { fail(error); }
    if (!failed) post({ type: 'editor-commit', ...drafts() });
  };
  const cancel = () => post({ type: 'editor-cancel' });
  let update: ((values: { element: Values; spread: Values }) => void) | undefined;
  // A change set() cannot apply (another parameter, or an invalid value) is ignored, as untyped template code would
  // otherwise lose it silently. Each problem is reported once: in the console for the author, and to the dialog,
  // which shows it without blocking Done.
  const reported = new Set<string>();
  const warn = (message: string) => {
    if (reported.has(message)) return;
    reported.add(message);
    console.warn('ImageFlow: ' + message);
    post({ type: 'editor-warning', message });
  };
  const changes = (scope: 'element' | 'spread', next: Values) => {
    if (readOnly || failed) return;
    const owned = scope === 'element' ? editor.parameters : ownedSpread;
    const parameters = scope === 'element' ? declared : layout.parameters;
    const { allowed, rejected } = editorChanges(parameters, owned, next, scope, documentEditor ? 'document' : 'element');
    for (const { message } of rejected) warn(message);
    if (!Object.keys(allowed).length) return;
    if (scope === 'element') draft = { ...draft, ...allowed };
    else spreadDraft = { ...spreadDraft, ...allowed };
    changed = true;
    post({ type: 'editor-draft', values: claimed(draft), spread: claimedSpread(spreadDraft) });
    update?.({ element: draft, spread: spreadDraft });
  };
  const set = (next: Values) => changes('element', next);
  const setSpread = (next: Values) => changes('spread', next);

  // File imports run in the app, which owns the project; it answers with the new file's ID. The frame then reloads
  // the project's files, so `file(id)` and the file controls see the new file at once.
  let requests = 0;
  const pending = new Map<number, (id: string | undefined) => void>();
  const importFile = (accept: readonly string[], mode?: ImportMode) => {
    if (readOnly || failed || !Array.isArray(accept)) return Promise.resolve(undefined);
    const request = ++requests;
    post({ type: 'editor-import', request, accept: accept.filter((extension) => typeof extension === 'string'), mode });
    return new Promise<string | undefined>((resolve) => pending.set(request, resolve));
  };
  // A newer render session of the book: recompute the context from it. Only the newest request counts, and the
  // component rerenders only when something it can see changed. A spread that is gone keeps the last context; the
  // app closes the editor.
  let contextRequests = 0;
  const refreshContext = (session: string, measurements: unknown) => {
    const request = ++contextRequests;
    void fetch('/render/' + session + '/data').then((response) => response.json()).then((latest: RenderProject) => {
      if (request !== contextRequests || failed) return;
      // The latest book may have chosen another format; the context follows it like the book render does.
      const next = refreshedEditorContext(latest, template, spreadId);
      if (!next) return;
      const measured = withEditorGeometry(next.context, measurements);
      const key = next.key + JSON.stringify(Object.fromEntries(Object.entries(measured.elements).map(([id, element]) => [id, element.rect])));
      if (key === contextKey) return;
      seen = measured;
      contextKey = key;
      updateContext?.(seen);
    }).catch(() => undefined);
  };
  window.addEventListener('message', (event) => {
    if (event.origin !== editorURL.slice(0, -1)) return;
    if (event.data?.type === 'editor-context') {
      if (typeof event.data.project === 'string' && /^[\w-]+$/.test(event.data.project)) refreshContext(event.data.project, event.data.elementRects);
      return;
    }
    if (event.data?.type === 'editor-scale') {
      const scale = Number(event.data.scale);
      if (Number.isFinite(scale) && scale > 0) root.style.setProperty('--if-inline-scale', String(scale));
      return;
    }
    if (event.data?.type === 'editor-flush') {
      // Closing the panel finishes a field that applies on blur, through set(), before confirming the close.
      // A failure is reported instead; earlier live changes remain saved.
      const request = event.data.request;
      if (typeof request !== 'number') return;
      try { (window.document.activeElement as HTMLElement | null)?.blur?.(); }
      catch (error) { fail(error); }
      if (!failed) post({ type: 'editor-flushed', request, ...drafts() });
      return;
    }
    if (event.data?.type === 'editor-values') {
      // The dialog's generated controls, for the element's other parameters: shown to the component, never claimed.
      const values = event.data.values && typeof event.data.values === 'object' ? event.data.values as Values : {};
      const others = Object.entries(values).filter(([key, value]) => !editor.parameters.includes(key) &&
        Object.hasOwn(declared, key) && isParameterValue(declared[key], value));
      if (!others.length) return;
      draft = { ...draft, ...Object.fromEntries(others) };
      update?.({ element: draft, spread: spreadDraft });
      return;
    }
    if (event.data?.type === 'editor-files') {
      // A file the app's controls imported for this element: the frame reads the project's files again.
      const session = typeof event.data.project === 'string' && /^[\w-]+$/.test(event.data.project) ? event.data.project : undefined;
      if (session) void fetch('/render/' + session + '/data').then((response) => response.json()).then((latest: RenderProject) => {
        setTemplateFiles(latest.files);
        projectFiles = latest.project.files;
        updateFiles?.(projectFiles);
        post({ type: 'editor-files-loaded' });
      }).catch(fail);
      return;
    }
    if (event.data?.type !== 'editor-imported') return;
    const resolve = pending.get(event.data.request);
    if (!resolve) return;
    pending.delete(event.data.request);
    const id = typeof event.data.id === 'string' ? event.data.id : undefined;
    const session = typeof event.data.project === 'string' && /^[\w-]+$/.test(event.data.project) ? event.data.project : undefined;
    if (!id || !session) return resolve(undefined);
    // The import started a new render session for the project; this frame keeps its own, so read the files there.
    void fetch('/render/' + session + '/data').then((response) => response.json()).then((latest: RenderProject) => {
      setTemplateFiles(latest.files);
      projectFiles = latest.project.files;
      updateFiles?.(projectFiles);
      resolve(id);
    }).catch(fail);
  });

  const EditorValues = React.createContext({ element: draft, spread: spreadDraft });
  // The app's control for one of this editor's parameters, writing to the draft like `set` (or `setSpread`).
  function Control({ parameter, label, scope = 'element' }: { parameter: string; label?: string; scope?: 'element' | 'spread' }) {
    const values = React.useContext(EditorValues)[scope === 'spread' ? 'spread' : 'element'];
    const [owned, parameters] = scope === 'spread' ? [ownedSpread, layout!.parameters] : [editor!.parameters, declared];
    const param = owned.includes(parameter) && Object.hasOwn(parameters, parameter) ? parameters[parameter] : undefined;
    if (!param) throw new Error(unknownControl(parameter, owned, scope));
    const value = isParameterValue(param, values[parameter]) ? values[parameter] : param.default;
    return React.createElement('fieldset', { className: 'if-control', disabled: readOnly },
      React.createElement(Field, { param: label ? { ...param, label } : param, value, change: (next) => changes(scope === 'spread' ? 'spread' : 'element', { [parameter]: next }) }));
  }

  // Inline, the editor replaces the page's artwork only once it has drawn: after its fonts, what it asked to wait for
  // with `waitUntil` while mounting (such as a map's first tiles, at most a few seconds), and one painted frame.
  const holds: Promise<unknown>[] = [];
  let announced = false;
  const waitUntil = (until: Promise<unknown>) => { if (!announced && presentation === 'inline') holds.push(Promise.resolve(until).catch(() => undefined)); };
  const settled = () => presentation !== 'inline' ? Promise.resolve()
    : Promise.race([Promise.all([...holds, window.document.fonts.ready]), new Promise((resolve) => setTimeout(resolve, 4000))]).then(afterPaint);

  function Host() {
    const [values, setValues] = React.useState({ element: draft, spread: spreadDraft });
    const [files, setFiles] = React.useState(projectFiles);
    const [current, setContext] = React.useState(seen);
    React.useEffect(() => {
      update = setValues;
      updateFiles = setFiles;
      updateContext = setContext;
      // Effects run only once the component has mounted without throwing; the component's own effects ran before.
      void settled().then(() => { announced = true; if (!failed) post({ type: 'editor-ready' }); });
      return () => { update = undefined; updateFiles = undefined; updateContext = undefined; };
    }, []);
    // The context shows the saved book with this editor's draft applied, so a helper reading `context` agrees with
    // what the editor shows: a document editor's own document parameters, or an element editor's element values
    // (including the generated controls' draft) and the layout parameters it owns.
    const shown = React.useMemo(() => withEditorDraft(current, documentEditor ? { document: claimed(values.element) }
      : { element: elementId, values: values.element, spread: claimedSpread(values.spread) }), [current, values]);
    const context = React.useMemo(() => ({ files, importFile: readOnly ? undefined : (accept: string[], mode?: ImportMode) => importFile(accept, mode) }), [files]);
    return React.createElement(ProjectFilesContext.Provider, { value: context },
      React.createElement(EditorValues.Provider, { value: values },
        documentEditor
          // A document editor's `values` are only its own parameters; every other setting is read from `context`, so there
          // is one current copy of each. `format` and an element editor's `document` follow the context too.
          ? React.createElement(documentEditor.component, { values: claimed(values.element), set, context: shown, format: shown.format, readOnly, commit, cancel, presentation, waitUntil, Control, importFile })
          : React.createElement(element!.editor!.component, { values: values.element, set, spread: values.spread, setSpread, document: shown.document,
            format: shown.format, context: shown, readOnly, commit, cancel, presentation, waitUntil, Control, importFile })));
  }

  // Errors from the component's event handlers and async work do not reach React's error handling.
  window.addEventListener('error', (event) => {
    // Browsers report a benign layout notice through the same event.
    if (!event.error && /^ResizeObserver loop/.test(event.message)) return;
    fail(event.error ?? event.message);
  });
  window.addEventListener('unhandledrejection', (event) => fail(event.reason));
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      cancel();
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      commit();
    }
  });
  if (presentation !== 'inline') new ResizeObserver(() => post({ type: 'editor-size', height: Math.ceil(root.getBoundingClientRect().height) })).observe(root);
  const react = createRoot(root, { onUncaughtError: fail, onCaughtError: fail });
  flushSync(() => react.render(React.createElement(Host)));
}

// Runs a layout family's picker. Its draft is one of the family's layout IDs; the frame reports it, its height, and
// commit or cancel to the app, which checks the choice and switches the layout. The frame changes nothing itself.
function renderLayoutPicker(root: HTMLElement, book: RenderProject, template: Template, spreadId: string, familyId: string,
  readOnly: boolean) {
  const spread = book.project.spreads.find(({ id }) => id === spreadId);
  const family = template.layoutFamilies && Object.hasOwn(template.layoutFamilies, familyId) ? template.layoutFamilies[familyId] : undefined;
  const picker = family?.picker;
  if (!spread || !family || !picker) throw new Error('This layout family has no picker.');
  const ids = familyLayouts(template.spreads, familyId);
  const variants = ids.map((id) => ({ id, label: template.spreads[id].label, variant: { ...template.spreads[id].variant } }));
  let document = resolveParams(template.parameters, book.project.params);
  const format = resolveFormat(template.format);
  root.className = 'if-editor if-layout-settings';
  let saved = spread.definition;
  let disabled = readOnly;

  // The draft lives outside React so choose() followed directly by commit() sends the newest choice.
  let draft = saved;
  let failed = false;
  const fail = (error: unknown) => {
    if (failed) return;
    failed = true;
    const reason = error instanceof Error ? error.message : String(error);
    post({ state: 'error', message: 'The picker stopped working: ' + reason });
  };
  const reported = new Set<string>();
  let update: (() => void) | undefined;
  const choose = (id: string) => {
    if (disabled || failed) return;
    if (typeof id !== 'string' || !ids.includes(id)) {
      // Reported once per value, like an unknown parameter in an element editor; the draft stays as it was.
      const name = String(id);
      if (!reported.has(name)) {
        reported.add(name);
        post({ type: 'editor-notice', message: 'The picker chose ' + name + ', which is not a layout of ' + family.label + '. It can choose ' + ids.join(', ') + '.' });
      }
      return;
    }
    draft = id;
    post({ type: 'editor-draft', values: { layout: draft } });
    update?.();
  };
  const find = (tags: VariantTags) => {
    const wanted = Object.entries(tags ?? {});
    return variants.find(({ variant }) => wanted.every(([key, value]) => Object.hasOwn(variant, key) && variant[key] === value))?.id;
  };
  const commit = () => { if (!failed && ids.includes(draft)) post({ type: 'editor-commit', values: { layout: draft } }); };
  const cancel = () => post({ type: 'editor-cancel' });
  window.addEventListener('message', (event) => {
    if (event.source !== parent || event.origin !== editorURL.slice(0, -1)) return;
    if (event.data?.type === 'layout-picker-state') {
      if (typeof event.data.saved !== 'string' || !Object.hasOwn(template.spreads, event.data.saved) || typeof event.data.readOnly !== 'boolean') return;
      saved = event.data.saved;
      draft = saved;
      document = resolveParams(template.parameters, event.data.document ?? {});
      disabled = event.data.readOnly;
      update?.();
      return;
    }
    if (event.data?.type !== 'editor-flush') return;
    const request = event.data.request;
    if (typeof request !== 'number') return;
    try { (window.document.activeElement as HTMLElement | null)?.blur?.(); }
    catch (error) { fail(error); }
    if (!failed) post({ type: 'editor-flushed', request, values: { layout: draft } });
  });

  function Host() {
    const [, refresh] = React.useReducer((value: number) => value + 1, 0);
    React.useEffect(() => {
      update = refresh;
      post({ type: 'editor-ready' });
      return () => { update = undefined; };
    }, []);
    return React.createElement(picker!.component, {
      variants, current: draft, saved, choose, find, document, format, readOnly: disabled, commit, cancel,
    });
  }

  window.addEventListener('error', (event) => {
    if (!event.error && /^ResizeObserver loop/.test(event.message)) return;
    fail(event.error ?? event.message);
  });
  window.addEventListener('unhandledrejection', (event) => fail(event.reason));
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      cancel();
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      commit();
    }
  });
  new ResizeObserver(() => post({ type: 'editor-size', height: Math.ceil(root.getBoundingClientRect().height) })).observe(root);
  const react = createRoot(root, { onUncaughtError: fail, onCaughtError: fail });
  flushSync(() => react.render(React.createElement(Host)));
}

export async function startRender(root: HTMLElement) {
  let info: TemplateInfo | undefined;
  // The editor reports which part of the book frame is on screen, and how many grid columns the book view uses (0 for
  // one column). Listen before anything slow happens and ask once, because the editor's first report may otherwise
  // arrive before this script runs.
  let onScreen: Viewport | undefined;
  let onScreenChange: (() => void) | undefined;
  let grid: GridRequest = { columns: 0 };
  let setGrid: ((grid: GridRequest) => void) | undefined;
  window.addEventListener('message', (event) => {
    if (event.origin !== editorURL.slice(0, -1) || event.data?.type !== 'viewport') return;
    const { top, bottom, left, right } = event.data;
    onScreen = { top: Number(top), bottom: Number(bottom), left: Number(left ?? 0), right: Number(right ?? innerWidth) };
    const requested = { columns: Math.max(0, Math.min(8, Math.floor(Number(event.data.columns) || 0))) };
    if (requested.columns !== grid.columns) {
      grid = requested;
      setGrid?.(grid);
    }
    onScreenChange?.();
  });
  if (window.parent !== window) post({ type: 'viewport-request' });
  try {
    const response = await fetch(location.pathname + '/data');
    if (!response.ok) throw new Error('Could not load the project. Reload and try again.');
    const book: RenderProject = await response.json();
    document.title = book.project.title;
    const base = document.createElement('base');
    base.href = new URL('./', book.template.script).href;
    document.head.append(base);
    setTemplateAssets(book.template.assets);
    setTemplateFiles(book.files);
    Object.assign(globalThis, { ImageFlowRuntime: runtime, ImageFlowReact: React, ImageFlowJSX: jsx });
    // Book check, export and artwork frames record impure calls from template code, including at module load.
    const guards = book.mode === 'edit' ? undefined : installPurityGuards(window as unknown as Record<string, unknown>,
      new URL(book.template.script, location.href).pathname, undefined, renderingImages);
    const [module] = await Promise.all([import(/* @vite-ignore */ book.template.script), loadStyles(book.template.css)]);
    // The project's format choice is resolved first; everything below works with that one format.
    // `spreads` may be a builder function when the template was exported without defineTemplate.
    const exported = normalizeTemplate(module.default);
    const declaration = declarationWarnings(exported, templateSchema as unknown as Schema);
    const declared = templateSchema.safeParse(exported);
    if (!declared.success) {
      // A misspelt property often causes the schema error, such as `lable` leaving `label` missing: name it too.
      const issues = [
        ...declared.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
        ...declaration.filter(({ code }) => code === 'declaration-unknown-property')
          .map(({ path, message, suggestion }) => ({ path, message: message + ' ' + suggestion })),
      ].slice(0, 20);
      const [first] = issues;
      throw new DeclarationError('Template' + (first.path ? ' → ' + first.path.split('.').join(' → ') : '') + ': ' + first.message, issues);
    }
    const template = chooseFormat(declared.data, book.project.format);
    // Known before the ID check, so a failed load still reports the declared ID (the template library reads it).
    info = templateInfo(template);
    if (template.id !== book.project.template.id) {
      throw new DeclarationError('The template ID does not match project.json.', [{ path: 'id',
        message: 'The template declares ID ' + template.id + ', but project.json uses ' + book.project.template.id + '.' }]);
    }
    const format = resolveFormat(template.format);
    const query = new URLSearchParams(location.search);
    if (book.mode === 'edit') {
      const focus = () => post({ type: 'editor-focus', text: !!document.activeElement?.matches('textarea, [contenteditable="true"], input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="color"]):not([type="button"])') });
      document.addEventListener('focusin', focus); document.addEventListener('focusout', focus); window.addEventListener('focus', focus);
      setTimeout(focus, 0);
    }
    if (book.mode === 'edit' && query.get('view') === 'editor') {
      renderEditor(root, book, template, query.get('spread') ?? '', query.has('editor') ? { editor: query.get('editor')! } : { element: query.get('element') ?? '' },
        query.has('readonly'), query.get('presentation') === 'inline' ? 'inline' : 'dialog');
      return;
    }
    if (book.mode === 'edit' && query.get('view') === 'layout-picker') {
      renderLayoutPicker(root, book, template, query.get('spread') ?? '', query.get('family') ?? '', query.has('readonly'));
      return;
    }
    const { spreads } = book.project;
    const sequence = pageSequence(spreads.map((spread) => template.spreads[spread.definition]?.span ?? 'spread'), template.format);
    const { chains, positions } = textAssignments(book, template);
    const edit = book.mode === 'edit';
    const check = !edit && query.get('view') === 'check';
    const artwork = !edit && query.get('view') === 'artwork' ? parsePreviewRequest(JSON.parse(query.get('request') ?? 'null')) : undefined;
    const inspect = !edit && query.has('inspect') ? inspectionSchema.parse(JSON.parse(query.get('inspect')!)) : undefined;
    // The editor renders the whole book twice: as scrolling spreads and as sidebar thumbnails.
    const view: BookView = query.get('view') === 'thumbs' ? 'thumbs' : query.get('view') === 'layouts' ? 'layouts' : 'book';
    if (edit && view !== 'book') {
      for (const photo of Object.values(book.photos)) photo.src = photo.src.replace(/\/photo\/([\w-]+)$/, '/thumb/$1');
    }
    const lazy = edit && view === 'book';
    // Pictures drawn by <RenderedImage>: at the screen's resolution in the editor (smaller for thumbnails), cheaply
    // in the Book check, and at the format's target resolution for export (ADR 0006).
    const target = template.format.output.resolution?.target ?? 300;
    configureRenderedImages(edit ? { mode: 'preview', pixelRatio: view === 'book' ? Math.min(window.devicePixelRatio || 1, 2) : 0.5,
      concurrency: view === 'book' ? 2 : 1, timeoutMs: pictureTimeoutMs.preview,
      previewCache: view !== 'book' ? location.pathname + '/picture/' : undefined }
      : check ? { mode: 'check', pixelRatio: 0.5, concurrency: 2, timeoutMs: pictureTimeoutMs.check }
        : artwork || inspect ? { mode: 'preview', pixelRatio: 1.5, concurrency: 2, timeoutMs: pictureTimeoutMs.preview }
          : { mode: 'export', pixelRatio: target / 96, concurrency: 1, timeoutMs: pictureTimeoutMs.export });
    if (edit && view === 'layouts') {
      await renderLayouts(root, book, template, info, query.get('spread') ?? '');
      return;
    }
    const activeChains = [...chains];
    const visible = spreads.map((spread, i) => ({ spread, i }));
    const where = spreads.map((spread, i) => {
      return pagesText(sequence.spreads[i].page) + ' · ' + (template.spreads[spread.definition]?.label ?? spread.definition);
    });
    if (edit) root.className = 'if-preview';
    const lookups = new Map<string, AnchorLookup>();
    const index = { ...bookIndex(book, template, sequence), lookups };

    let renderError: unknown;
    const layoutFailures = new Map<string, Failure>();
    const react = createRoot(root, { onUncaughtError: (error) => { renderError = error; } });
    flushSync(() => react.render(visible.map(({ spread, i }) => {
      const view = <SpreadView book={book} spread={spread} template={template} format={format} positions={positions}
        page={sequence.spreads[i].page} index={index} renderPhotos lazyPhotos={lazy} />;
      return <div className="if-spread-container" data-span={sequence.spreads[i].span} data-spread={spread.id} data-layout={spread.definition} key={spread.id}>
        {edit ? view : <LayoutBoundary spread={spread.id} failures={layoutFailures}>{view}</LayoutBoundary>}
      </div>;
    })));
    if (renderError) throw renderError;
    if (layoutFailures.size) throw new LayoutRenderError(layoutFailures);
    // A check or export is final only once every asynchronous picture is drawn or has failed; the editor shows
    // them as they arrive.
    const pictureFailures = lazy || (edit && view !== 'book') ? [] : await settleRenderedImages();
    if (edit && view === 'thumbs') await settleRestoredImages();
    const images = [...root.querySelectorAll<HTMLImageElement>('img[src]')];
    const decoded = await settle(images);
    const message = (text: string): Issue => ({ message: text });
    const located = (spread: string, text: string): Issue => ({ message: text, spread, where: where[spreads.findIndex(({ id }) => id === spread)] });
    // A control the generated controls could hide for good is fine on a spread that also marks it as editable on
    // the page: the marked node is the way to show it again (placeControlWarnings).
    const rendered = [...root.querySelectorAll<HTMLElement>('.if-spread-container[data-spread]')].flatMap((container) => {
      const spread = spreads.find(({ id }) => id === container.dataset.spread);
      return spread ? [{ spread: spread.id, layout: spread.definition, marked: new Set([...container.querySelectorAll<HTMLElement>('[data-edit]')]
        .flatMap((node) => node.dataset.edit!.split(' ').filter(Boolean))) }] : [];
    });
    const warnings: Issue[] = [
      ...placeControlWarnings(declaration, rendered).map(({ code, message: text, path, details, suggestion, spread }) =>
        ({ ...(spread ? located(spread, text) : message(text)), code, details: { ...details, path }, suggestion })),
      ...book.problems.map((text) => ({ ...message(text), code: 'project-input' })),
      ...(book.template.warnings ?? []).map((text) => ({ ...message(text), code: 'template-dependencies',
        suggestion: 'Run npm install in template/, then run the template dependency rebuild script.' })),
      ...parameterWarnings(template.parameters, book.project.params, 'Document').map((text) => ({ ...message(text), code: 'parameter-invalid',
        suggestion: 'Use set_parameter with scope document and an allowed value, or reset_parameter to restore the default.' })),
    ];
    // A book without spreads is valid while it is being started, but there is nothing to print yet.
    const errors: Issue[] = spreads.length ? sequence.issues.map((text) => ({ ...message(text), code: 'page-sequence',
      suggestion: 'Insert, remove or move spreads, or switch layouts, so the page sequence fits the format.' })) : [{
      ...message('The book has no spreads yet.'), code: 'book-empty', suggestion: 'Add a spread with insert_spread, or with Add Spread in the editor.' }];
    // The preview falls back to the default format, but printing at a size nobody chose is blocked.
    if (template.unknownChoice) {
      errors.push({ ...message('The template no longer offers the format ' + book.project.format + ' saved with this book. The preview uses ' +
        template.format.label + '; choose a format in template controls.'), code: 'format-unavailable',
      details: { saved: book.project.format ?? '', used: template.format.label },
      suggestion: 'Use select_format with one of the template formats, or declare format ' + book.project.format + ' again in the template.' });
    }
    errors.push(...fileErrors(book, template.parameters, book.project.params, 'Document'));
    const pictureIssues = (failures: RenderedImageFailure[]): Issue[] => failures.map((failed) => ({
      ...(failed.spread ? located(failed.spread, failed.message) : message(failed.message)), code: 'rendered-image-failed',
      ...(failed.element ? { element: failed.element } : {}), details: { label: failed.label, timedOut: failed.timedOut ? 1 : 0 },
      suggestion: failed.timedOut ? 'Check the internet connection, then check or export again.'
        : 'Check that the template’s network sites are allowed for this book and reachable, then check or export again.' }));
    errors.push(...pictureIssues(pictureFailures));
    for (const { api, spread } of guards?.calls ?? []) {
      errors.push({ ...(spread ? located(spread, impureMessage(api)) : message(impureMessage(api))), code: 'render-impure',
        details: { api }, suggestion: impureSuggestion });
    }
    for (const spread of spreads) {
      const definition = template.spreads[spread.definition];
      if (!definition) continue;
      const scoped = [
        ...fileErrors(book, definition.parameters, spread.params, 'Layout'),
        ...Object.entries(definition.boxes).flatMap(([id, box]) =>
          fileErrors(book, box.parameters, spread.boxes[id]?.params ?? {}, box.label).map((finding) => ({ ...finding, box: id }))),
        ...Object.entries(definition.elements).flatMap(([id, element]) =>
          fileErrors(book, element.parameters, spread.elements[id]?.params ?? {}, element.label).map((finding) => ({ ...finding, element: id }))),
      ];
      errors.push(...scoped.map((finding) => ({ ...located(spread.id, finding.message), ...finding })));
      for (const [box, declaration] of Object.entries(definition.boxes)) {
        const assignment = spread.boxes[box];
        const id = declaration.type === 'photo' ? assignment?.photo : assignment?.text;
        const kind = declaration.type === 'photo' ? 'photo' : 'markdown';
        const state = id && book.sources?.[kind + ':' + id];
        if (state && state.state !== 'available' && state.cached) errors.push({
          ...located(spread.id, state.problem + '. Showing a cached preview; the original is required for print.'),
          code: 'source-unavailable', box, source: id || undefined, suggestion: 'Locate the original or retry after reconnecting its location.',
        });
      }
    }
    for (const [i, result] of decoded.entries()) {
      if (result.status !== 'rejected') continue;
      const box = images[i].closest<HTMLElement>('[data-box]')?.dataset.box;
      const spread = images[i].closest<HTMLElement>('[data-spread]')?.dataset.spread;
      const photo = spread && box ? spreads.find(({ id }) => id === spread)?.boxes[box]?.photo : undefined;
      errors.push({ ...(spread ? located(spread, '') : {}), message: 'Could not decode photo ' + (images[i].alt || box) + '.',
        code: 'photo-decode-failed', box, source: photo,
        suggestion: 'Replace the original with a valid JPEG, PNG or WebP file, or assign another photo.' });
    }
    for (const { spread, anchor, found } of lookups.values()) {
      warnings.push(found ? {
        ...located(spread, found + ' spreads declare anchor ' + anchor + '; this spread uses the first.'), code: 'anchor-ambiguous',
        details: { anchor, declared: found },
        suggestion: 'Give each anchor a unique ID in the layouts\' anchors(), or list them with ctx.book.anchors(' + JSON.stringify(anchor) + ').',
      } : {
        ...located(spread, 'No spread declares anchor ' + anchor + '.'), code: 'anchor-missing', details: { anchor },
        suggestion: 'Insert a spread whose layout declares anchor ' + anchor + ', or change the referenced anchor ID.',
      });
    }
    for (const family of fontFailures()) {
      errors.push({ ...message('Font ' + family + ' could not be loaded; text using it renders with a fallback font.'), code: 'font-load-failed',
        details: { family }, suggestion: 'Check the @font-face src path in the template CSS and that the font file exists inside template/.' });
    }
    const containers = root.querySelectorAll<HTMLElement>('.if-spread-container');
    const layouts = new Map(visible.map(({ spread, i }, n) => {
      try { return [spread.id, validateSpread(containers[n], spread, template, format, where[i], warnings, errors)] as const; }
      catch (error) {
        if (edit) throw error;
        layoutFailures.set(spread.id, failure(error));
        return [spread.id, undefined] as const;
      }
    }));
    if (layoutFailures.size) throw new LayoutRenderError(layoutFailures);
    const validated = layouts as Map<string, NonNullable<ReturnType<typeof validateSpread>>>;
    for (const [source, chain] of activeChains) {
      const first = chain[0];
      if (book.texts[source] === undefined) {
        errors.push({ ...located(first.spread, 'Missing Markdown source ' + source + '.'), code: 'text-source-missing', box: first.box, source,
          suggestion: 'Restore ' + (book.project.texts[source] ? sourcePath(book.project.texts[source]) : 'the Markdown file') + ', or assign another text to box ' + first.box + '.' });
        continue;
      }
      const boxes = chain.map(({ spread, box }) => validated.get(spread)!.boxes.get(box)!);
      const result = flow.run(markdownToHtml(book.texts[source]), boxes, 'columns');
      const overflow = result.overflowText.trim();
      if (overflow || result.results.some(({ failed, unresolved }) => failed || unresolved)) {
        const last = chain.at(-1)!;
        errors.push({ ...located(last.spread, 'Text from ' + (book.project.texts[source] ? sourcePath(book.project.texts[source]) : source) + ' does not fit; add a spread that continues it.'),
          code: 'text-overflow', box: last.box, source,
          details: { overflowCharacters: overflow.length, boxes: chain.length, path: book.project.texts[source] ? sourcePath(book.project.texts[source]) : '' },
          suggestion: 'Insert a spread after ' + last.spread + ' with a markdown box and assign text ' + source +
            ' to it so the flow continues, or enlarge the boxes, reduce the text size or shorten the text.' });
      }
    }
    const minimum = template.format.output.minimumTextSize;
    for (const [spread, { sheet }] of validated) {
      const minimumMm = minimum && toMillimeters(minimum);
      const typography = checkTypography(sheet, format, minimumMm);
      if (typography.small && minimumMm) {
        warnings.push({ ...located(spread, 'Text is smaller than the format minimum.'), code: 'text-too-small', ...typography.small.owner,
          details: { sizePt: Math.round(typography.small.sizeMm * ptPerMm * 10) / 10, minimumPt: Math.round(minimumMm * ptPerMm * 10) / 10 },
          suggestion: 'Increase the font size in the template CSS or the size parameter of this box or element.' });
      }
      if (typography.outside) {
        warnings.push({ ...located(spread, 'Text extends outside the safe area.'), code: 'text-outside-safe-area', ...typography.outside.owner,
          details: { overshootMm: Math.round(typography.outside.overshootMm * 10) / 10 },
          suggestion: 'Move or inset this text in the template CSS so it stays inside the format safe area.' });
      }
      const round = (value: number) => Math.round(value * 10) / 10;
      const blocks = checkTextBlocks(sheet, format);
      for (const { owner: { tag, text, self, ...owner }, clipped, bottomMm, rightMm, clippedBy } of blocks.overflows) {
        const name = describe({ tag, text, self, ...owner });
        const fix = owner.parameter ? 'shorten ' + owner.parameter + ', or ' : '';
        const container = clippedBy ? describe({ ...clippedBy, parameter: undefined }) : undefined;
        warnings.push({ ...located(spread, 'Text in ' + name + (container ? ' is cut off by its container ' + container + '.' : clipped ? ' is cut off by its box.' : ' runs out of its box.')),
          code: clipped ? 'text-clipped' : 'text-overflows-box', ...owner,
          details: { overflowBottomMm: round(bottomMm), overflowRightMm: round(rightMm), tag, text,
            ...(clippedBy ? { clippedByTag: clippedBy.tag, ...(clippedBy.box ? { clippedByBox: clippedBy.box } : {}),
              ...(clippedBy.element ? { clippedByElement: clippedBy.element } : {}) } : {}) },
          suggestion: 'To fit the text, ' + fix + 'enlarge ' + (container ? 'the clipping ' + clippedBy!.tag + ' container' : 'this ' + tag) +
            ' or reduce the font size or line height in the template.' });
      }
      for (const { owner: { tag, text, self, ...owner }, other, overlapMm } of blocks.overlaps) {
        warnings.push({ ...located(spread, 'Text in ' + describe({ tag, text, self, ...owner }) + ' overlaps text in ' + describe(other) + '.'),
          code: 'text-overlap', ...owner,
          details: { overlapMm: round(overlapMm), tag, text, otherTag: other.tag, otherText: other.text,
            ...(other.box ? { otherBox: other.box } : {}), ...(other.element ? { otherElement: other.element } : {}),
            ...(other.parameter ? { otherParameter: other.parameter } : {}) },
          suggestion: 'Give each text block its own space in the template layout, limit the length of the parameters they show, ' +
            'or let the first block push the second down instead of positioning both absolutely.' });
      }
    }
    const sheets = [...validated.values()].map(({ sheet }) => sheet);
    let inspection: ElementInspection | undefined;
    if (inspect) {
      const index = spreads.findIndex(({ id }) => id === inspect.spread);
      if (index < 0) throw new PreviewError('preview-target-not-found', 'Spread ' + inspect.spread + ' does not exist in this book.');
      inspection = inspectElements(sheets[index], spreads[index], template, format, inspect);
    }
    if (edit) setGrid = layoutBook(root, [...validated].map(([spread, { sheet }]) => ({ spread, sheet })), view, format, grid);
    if (lazy) {
      const load = photoLoader(root, () => onScreen);
      let timer: ReturnType<typeof setTimeout> | undefined;
      onScreenChange = () => { timer ??= setTimeout(() => { timer = undefined; load(); }, 16); };
      // Report ready once the photos on screen are decoded, so swapping in this frame shows them.
      await Promise.allSettled(load().map((img) => img.decode()));
    }
    else if (artwork) {
      const { frame, metadata } = renderArtwork(root, sheets, spreads, sequence, format, artwork, book.fixture);
      await settle([...frame.querySelectorAll<HTMLImageElement>('img')]);
      window.imageflowPreview = { state: 'ready', metadata };
    } else if (!check) {
      makePrintPages(root, sheets, sequence, format);
      await Promise.allSettled([...document.querySelectorAll<HTMLImageElement>('.if-print-page img')].map((img) => img.decode()));
    }
    const units: { side: PrintSide; spread: string; where: string }[] = sequence.spreads.flatMap(({ sides }, i) =>
      sides.map((side) => ({ side, spread: spreads[i].id, where: where[i] })));
    publish({
      state: 'ready', template: info, pages: sequence.count, units, errors, warnings, flow: positions, anchors: index.anchors,
      ...(inspection ? { inspection } : {}),
    });
    // The editor's book view does not wait for its pictures. It reports them to the live Book check as they start,
    // finish or fail, so a map that failed on the page is never missing from the check.
    if (lazy && window.parent !== window) {
      let queued = false;
      const report = () => {
        if (queued) return;
        queued = true;
        setTimeout(() => {
          queued = false;
          const { pending, failures } = renderedImageState();
          post({ type: 'pictures', pending, errors: pictureIssues(failures) });
        }, 50);
      };
      watchRenderedImages(report);
      report();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The template could not be rendered.';
    if (error instanceof PreviewError) window.imageflowPreview = { state: 'error', code: error.code };
    root.hidden = true;
    const layoutFailures = error instanceof LayoutRenderError ? [...error.failures].map(([spread, details]) => ({ spread, ...details }))
      : error instanceof SpreadError ? [{ spread: error.spread, ...failure(error) }] : undefined;
    publish({ state: 'error', message, template: info,
      ...(layoutFailures ? { layoutFailures } : error instanceof DeclarationError ? { declarationIssues: error.issues }
        : error instanceof PreviewError ? {} : { stack: failure(error).stack }) });
  }
}
