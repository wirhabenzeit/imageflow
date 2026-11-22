import { textAssignments } from './text-assignments';
import { layoutFootprint, shownLayoutStates, planLayoutChange, sheetLayoutLabel } from './layouts';
import type { PresentationView } from './presentation-model';
import { presentationPhotoSource } from './presentation-model';
import { printProblem, sourceFileName, sourcePath } from './source-locations';
import { renameIds } from './svg-ids';
import { bundlesFamily, familiesOf, missingCharacters, setTemplateFonts } from './fonts';
import { parseSentinel, sentinelStrip, sentinelWidth } from './capture-sentinel';
import type { Sentinel } from './capture-sentinel';
import { impureMessage, impureSuggestion, installPurityGuards, unlocatedImpureSuggestion } from './purity';
import { activateAllRenderedImages, activateRenderedImageSpreads, configureRenderedImages, renderedImageNotes, renderedImageState, renderingImages, settleRenderedImages, settleRestoredImages, watchRenderedImages } from './rendered-image';
import type { RenderedImageFailure } from './rendered-image';
import type { ImportMode, SourceReference } from './source-locations';
import React from 'react';
import * as jsx from 'react/jsx-runtime';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { editorURL } from './desktop';
import { bookLayout } from './desktop';
import type { BookGeometry, BookView, Issue, Rect, RenderStatus, TemplateInfo } from './desktop';
import { cssMM, pageLabel, pageSequence, pagesText, resolveFormat, sheetBleed, sheetPages, spanRequiredAt, toMillimeters } from './format';
import { coverLayoutsFor, resolveCover } from './cover';
import type { CoverResolution } from './cover';
import { animateReorder, reorderOffsets } from './reorder-motion';
import type { ReorderOffset } from './reorder-motion';
import type { PrintSide, ResolvedFormat } from './format';
import { frameView, scopeSpread, scopeState } from './project';
import type { FixtureMarking, PageSide, RenderProject, SpreadState, Values } from './project';
import { composeHtml, markdownToHtml } from './markdown';
import { splitFrontmatter } from './frontmatter';
import { isParameterValue, parameterWarnings, resolveParams, resolveValue } from './parameters';
import type { ListItem } from './parameters';
import { fileErrors } from './file-findings';
import type { Parameters } from './parameters';
import { flow } from './text-flow';
import { declarationWarnings, placeControlWarnings } from './declaration-check';
import type { Schema } from './declaration-check';
import { bookIndex, chooseFormat, CoverArtwork, currentPhotoRenderFailures, watchPhotoRenderFailures, editorContext, normalizeTemplate, photoNearEvent, refreshedEditorContext, setLivePlacement, withEditorDraft, withEditorGeometry, runtime, setTemplateAssets, setTemplateFiles, SpreadError, SpreadView, templateInfo, templateIssueSchema, templateSchema, textComposition } from './template';
import type { AnchorLookup, PhotoRenderFailure, EditorContext, EditorPresentation } from './template';
import type { FlowPosition, Template } from './template';
import { resolveEditPath } from './editing';
import { declaredInTemplate, editorLayoutPreviews, editorLayoutTarget, familyLayouts } from './layouts';
import type { VariantTags } from './layouts';
import { numberOccurrences } from './edit-targets';
import { declaredName, declaredNode, declaredNodes, findDeclared, onPage, ownerOf, ownTarget, pageAttribute, pageOf } from './page-scope';
import { textEditorOwner } from './inline-text';
import { inlineTextFrame } from './inline-text-frame';
import { readEdit } from './editing';
import { artworkTarget, parsePreviewRequest, PreviewError } from './preview';
import { previewAspectMismatch, trimAspect } from './template-preview';
import type { PreviewFileReport } from './template-preview';
import type { CoverPreviewMetadata, PreviewMetadata, PagePreviewMetadata, PickerPreviewMetadata } from './preview';
import { Choice } from './choice';
import { inspectionSchema } from './inspection';
import type { ElementInspection, ElementMeasurement } from './inspection';
import { contactSheetLayout, fixtureBannerHeight } from './authoring-artwork';
import { Field, ProjectFilesContext } from './Fields';
import { editorChanges, unknownControl } from './editor-changes';
import { pictureTimeoutMs } from './render-budget';
import { pendingNetwork, pictureFailureSuggestion } from './network-access';
import { proofLayout, proofPhotoPixels, proofPixelRatio, proofSheet } from './proof-sheet';
import { isUnavailableSource } from './source-diagnostics';
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

// A frame of the editor runs in a process of its own, and gets its size from the editor shortly after it starts. Until
// then its document is not laid out: every box measures 0 × 0, and the render would fail with "has no area". On a slow
// Mac the render could get there first, and the book view then waited for this failed frame (beta CI flakiness). Waits
// for the size, at most 10 s, so a frame that really has no width still renders and reports what it finds.
async function laidOut() {
  for (const started = Date.now(); !(document.documentElement.clientWidth > 0) && Date.now() - started < 10_000;) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
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

// Converts a measured CSS pixel distance to millimetres, rounded for reporting.
const reportedMm = (pixels: number, mmPerPixel: number) => Math.round(pixels * mmPerPixel * 10) / 10;
const ptPerMm = 72 / 25.4;

function photoResolutionIssue(node: HTMLElement, minimum: number | undefined, mmPerPixel: number, label: string, source?: string): Issue | undefined {
  const ppi = Number(node.dataset.ppi);
  if (minimum === undefined || !Number.isFinite(ppi) || ppi >= minimum) return;
  const bounds = node.getBoundingClientRect();
  return {
    message: label + ' is ' + Math.round(ppi) + ' ppi (minimum ' + minimum + ').', code: 'photo-resolution-low', source,
    details: { ppi: Math.round(ppi), minimumPpi: minimum,
      boxWidthMm: reportedMm(bounds.width, mmPerPixel), boxHeightMm: reportedMm(bounds.height, mmPerPixel) },
    suggestion: 'Zoom the crop out (set_crop with a smaller zoom), assign a higher-resolution photo, or switch to a layout with a smaller box.',
  };
}

// Whether the rectangles of a box start level below a head that opens it (`alignHeads`); otherwise each flows on its own,
// like chained boxes.
const aligned = (first: HTMLElement) => first.dataset.alignHeads !== undefined;

// A box and the further rectangles it is drawn over, in flow order.
function rectsOf(boxes: Map<string, HTMLElement>, key: string) {
  const rects = [boxes.get(key)!];
  for (let i = 1; boxes.has(key + '#' + i); i++) rects.push(boxes.get(key + '#' + i)!);
  return rects;
}

function validateSpread(container: HTMLElement, spread: SpreadState, template: Template, format: ResolvedFormat, where: string,
  warnings: Issue[], errors: Issue[]) {
  const sheet = container.firstElementChild;
  if (!(sheet instanceof HTMLElement) || !sheet.matches('.if-sheet') || container.childElementCount !== 1) {
    throw new Error('Spread ' + spread.id + ' must render one <Spread> at its root.');
  }
  const definition = template.spreads[spread.definition];
  // The sheet draws the spread's own layout, or one layout per page container (ADR 0009). Each drawn layout must
  // draw each of its boxes exactly once, and nothing it does not declare.
  const drawnPages = (['left', 'right'] as const).filter((side) => sheet.querySelector('[' + pageAttribute + '="' + side + '"]'));
  if (drawnPages.length && !spread.split) throw new Error(where + ' draws page containers (' + pageAttribute + '), which only ImageFlow draws for a spread shown as pages.');
  const scopes = new Map((drawnPages.length ? drawnPages : [undefined]).map((page) => {
    const id = page ? scopeState(spread, page)?.definition : spread.definition;
    const layout = id !== undefined && Object.hasOwn(template.spreads, id) ? template.spreads[id] : undefined;
    const shown: Pick<Template['spreads'][string], 'boxes' | 'elements' | 'parameters'> | undefined = layout ?? (page && id === undefined ? { boxes: {}, elements: {}, parameters: {} } : undefined);
    if (!shown) throw new SpreadError(where + ' draws the ' + page + ' page without a known layout.', spread.id, { page });
    return [page, { layout: shown, boxes: new Set(Object.keys(shown.boxes)), elements: new Set(Object.keys(shown.elements)) }] as const;
  }));
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
  const parameterFix = 'Use set_parameter with an allowed value, or reset_parameter to remove the saved value.';
  for (const [page, { layout: definition }] of scopes) {
    const saved = scopeState(spread, page) ?? { params: {}, boxes: {}, elements: {} };
    warn(parameterWarnings(definition.parameters, undeclared('', definition.parameters, saved.params), 'Layout'),
      { code: 'parameter-invalid', ...onPage(page), suggestion: parameterFix });
    for (const [id, state] of Object.entries(saved.boxes)) {
      const box = Object.hasOwn(definition.boxes, id) ? definition.boxes[id] : undefined;
      const kind = state.photo ? 'photo' : state.text ? 'text' : undefined;
      if (kind && !declared.box(id, kind)) {
        warn(['Content saved for box ' + id + ' fits no box of this template.'], { code: 'content-undeclared', ...onPage(page), box: id,
          source: state.photo ?? state.text, suggestion: 'Declare a ' + (kind === 'photo' ? 'photo' : 'markdown') + ' box ' + id +
            ' in a layout, or discard the saved assignment with clear_box (spread ' + spread.id + ', box ' + id + ').' });
        continue;
      }
      if (box && kind && (kind === 'photo') !== (box.type === 'photo')) continue;
      const parameters = box?.parameters ?? {};
      warn(parameterWarnings(parameters, undeclared('box ' + id, parameters, state.params), box?.label ?? 'Box ' + id),
        { code: 'parameter-invalid', ...onPage(page), box: id, suggestion: parameterFix });
    }
    for (const [id, state] of Object.entries(saved.elements)) {
      const element = Object.hasOwn(definition.elements, id) ? definition.elements[id] : undefined;
      if (!element && !declared.element(id)) {
        warn(['Settings saved for element ' + id + ' fit no element of this template.'], { code: 'element-undeclared', ...onPage(page), element: id,
          suggestion: 'Declare element ' + id + ' in a layout, or reset its saved parameters.' });
        continue;
      }
      const parameters = element?.parameters ?? {};
      warn(parameterWarnings(parameters, undeclared('element ' + id, parameters, state.params), element?.label ?? id),
        { code: 'parameter-invalid', ...onPage(page), element: id, suggestion: parameterFix });
    }
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
        const owner = { ...onPage(pageOf(node)), ...(box ? { box } : element ? { element } : ownerOf(node)) };
        finding = issue(message, { code: 'template:' + code, ...owner, ...(parameter ? { parameter } : {}), ...(file ? { source: file } : {}),
          ...(details ? { details } : {}), ...(suggestion ? { suggestion } : {}) });
      }
    } else finding = issue(node.dataset.issue, { code: 'template-issue', ...ownerOf(node) });
    const key = severity + JSON.stringify(finding);
    if (reported.has(key)) continue;
    reported.add(key);
    (severity === 'error' ? errors : warnings).push(finding);
  }
  const unknownAt = new Map<PageSide | undefined, Set<string>>();
  for (const node of sheet.querySelectorAll<HTMLElement>('[data-edit]')) {
    const page = pageOf(node);
    // On a sheet shown as pages, a mark outside every drawn page belongs to no layout, so none of its paths resolve.
    const definition = scopes.has(page) ? scopeSpread(spread, page)?.definition ?? '' : undefined;
    const unknown = node.dataset.edit!.split(' ').filter(Boolean).filter((path) => definition === undefined || !resolveEditPath(template, definition, path));
    if (unknown.length) unknownAt.set(page, new Set([...unknownAt.get(page) ?? [], ...unknown]));
  }
  for (const [page, unknown] of unknownAt) {
    warn(['The layout marks unknown parameters as editable: ' + [...unknown].join(', ') + '.'], { code: 'edit-path-unknown', ...onPage(page),
      details: { paths: [...unknown].join(' ') }, suggestion: 'Declare these parameters in the layout, or remove them from ctx.edit(...).' });
  }
  // Boxes by ID, prefixed with their page on a page (`left:hero`), so text flow finds each page's own box.
  const boxes = new Map<string, HTMLElement>();
  for (const found of declaredNodes(sheet)) {
    const { node: box, id, page } = found;
    const scope = scopes.get(page);
    const name = page ? declaredName(found) : id;
    const at = onPage(page);
    if (!scope) throw new SpreadError(where + ' renders ' + declaredName(found) + ' outside the layouts it draws.', spread.id, { page });
    const { layout } = scope;
    if (found.kind === 'element') {
      if (!scope.elements.delete(id)) throw new SpreadError(where + ' renders an unknown or duplicate element: ' + name + '.', spread.id, { page });
    } else {
      if (!scope.boxes.delete(id) || layout.boxes[id].type !== found.boxType) {
        throw new SpreadError(where + ' renders an unknown, duplicate, or incompatible box: ' + name + '.', spread.id, { page });
      }
      if (!box.clientWidth || !box.clientHeight) throw new SpreadError(where + ' · ' + name + ' has no area.', spread.id, { page });
      boxes.set(page ? page + ':' + id : id, box);
      const assignment = scopeState(spread, page)?.boxes[id];
      if (assignment?.photo && box.hasAttribute('data-empty')) {
        errors.push(issue(layout.boxes[id].label + ' is missing photo ' + assignment.photo + '.', {
          code: 'photo-missing', box: id, ...at, source: assignment.photo,
          suggestion: 'Restore the original file, import it again with import_sources, or assign another photo to box ' + id + '.',
        }));
      }
      const finding = photoResolutionIssue(box, resolution?.minimum, mmPerPixel, layout.boxes[id].label, assignment?.photo);
      if (finding) errors.push(issue(finding.message, { ...finding, box: id, ...at }));
    }
    const rect = box.getBoundingClientRect();
    const overshoot = {
      leftMm: reportedMm(bounds.left - rect.left, mmPerPixel), topMm: reportedMm(bounds.top - rect.top, mmPerPixel),
      rightMm: reportedMm(rect.right - bounds.right, mmPerPixel), bottomMm: reportedMm(rect.bottom - bounds.bottom, mmPerPixel),
    };
    if (rect.left < bounds.left - 1 || rect.top < bounds.top - 1 ||
        rect.right > bounds.right + 1 || rect.bottom > bounds.bottom + 1) {
      const owner = found.kind === 'element' ? { element: id } : { box: id };
      errors.push(issue((layout.boxes[id]?.label ?? layout.elements[id]?.label ?? id) + ' extends outside the bleed.', {
        code: 'outside-bleed', ...owner, ...at,
        details: Object.fromEntries(Object.entries(overshoot).filter(([, value]) => value > 0)),
        suggestion: 'Change the template CSS so this ' + (owner.box ? 'box' : 'element') + ' stays within the sheet, which includes the bleed.',
      }));
    }
  }
  for (const [page, scope] of scopes) {
    if (scope.boxes.size) throw new SpreadError(where + (page ? ' · ' + page + ' page' : '') + ' is missing boxes: ' + [...scope.boxes].join(', ') + '.', spread.id, { page });
  }
  // A Markdown box drawn over several rectangles (`rects`): the first is the box itself, the others are registered as
  // `id#1`, `id#2`, … and flow after it.
  for (const node of sheet.querySelectorAll<HTMLElement>('[data-box-rect]')) {
    const id = node.dataset.boxRect!, page = pageOf(node);
    const key = (page ? page + ':' : '') + id;
    if (!boxes.has(key)) throw new SpreadError(where + ' draws a rectangle of box ' + id + ' without the box itself.', spread.id, { page });
    if (!node.clientWidth || !node.clientHeight) throw new SpreadError(where + ' · rectangle ' + node.dataset.rect + ' of box ' + id + ' has no area.', spread.id, { page });
    boxes.set(key + '#' + node.dataset.rect, node);
  }
  return { sheet, boxes };
}

function typographyIssues(sheet: HTMLElement, sheetWidth: number, minimum: number | undefined,
  safeAt: (centerX: number) => Rect, location: Pick<Issue, 'spread' | 'cover' | 'where'>, avoid: readonly Rect[] = []) {
  const bounds = sheet.getBoundingClientRect();
  const mmPerPixel = sheetWidth / bounds.width;
  const text = document.createTreeWalker(sheet, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  // The smallest text below the minimum and the largest safe-area overshoot, each with the box or element it is in.
  let small: { sizeMm: number; owner: ReturnType<typeof ownerOf> } | undefined;
  let outside: { overshootMm: number; owner: ReturnType<typeof ownerOf> } | undefined;
  let nearFold: ReturnType<typeof ownerOf> | undefined;
  for (let node = text.nextNode(); node; node = text.nextNode()) {
    const parent = node.parentElement;
    if (!node.textContent?.trim() || !parent || parent.closest('.if-placeholder, .if-text-placeholder, svg, [data-decorative]')) continue;
    const sizeMm = parseFloat(getComputedStyle(parent).fontSize) * 25.4 / 96;
    if (minimum && sizeMm < minimum && (!small || sizeMm < small.sizeMm)) small = { sizeMm, owner: ownerOf(parent) };
    range.selectNodeContents(node);
    for (const rect of range.getClientRects()) {
      if (!rect.width || !rect.height) continue;
      const x = (rect.left - bounds.left) * mmPerPixel;
      const y = (rect.top - bounds.top) * mmPerPixel;
      const w = rect.width * mmPerPixel;
      const h = rect.height * mmPerPixel;
      const safe = safeAt(x + w / 2);
      const overshootMm = Math.max(safe.x - x, x + w - safe.x - safe.width, safe.y - y, y + h - safe.y - safe.height);
      if (overshootMm > .2 && (!outside || overshootMm > outside.overshootMm)) outside = { overshootMm, owner: ownerOf(parent) };
      if (!nearFold && avoid.some((area) => x < area.x + area.width && x + w > area.x && y < area.y + area.height && y + h > area.y)) {
        nearFold = ownerOf(parent);
      }
    }
  }
  const issues: Issue[] = [];
  if (small && minimum) issues.push({ ...location, message: 'Text is smaller than the format minimum.', code: 'text-too-small', ...small.owner,
    details: { sizePt: Math.round(small.sizeMm * ptPerMm * 10) / 10, minimumPt: Math.round(minimum * ptPerMm * 10) / 10 },
    suggestion: 'Increase the font size in the template CSS or the size parameter of this box or element.' });
  if (outside) issues.push({ ...location, message: 'Text extends outside the safe area.', code: 'text-outside-safe-area', ...outside.owner,
    details: { overshootMm: Math.round(outside.overshootMm * 10) / 10 },
    suggestion: 'Move or inset this text in the template CSS so it stays inside the format safe area.' });
  if (nearFold) issues.push({ ...location, message: 'Some cover text crosses a fold avoidance area.', code: 'cover-text-near-fold', ...nearFold });
  return issues;
}

function printPictures(mode: 'check' | 'preview' | 'export', target = 300) {
  return { mode, pixelRatio: mode === 'check' ? .5 : mode === 'preview' ? 1.5 : target / 96,
    concurrency: mode === 'export' ? 1 : 2, timeoutMs: pictureTimeoutMs[mode] };
}

/**
 * Text the bundled fonts cannot set, and stroked text, per box or element, including text inside SVG such as the
 * labels of a vector map. A character no bundled font has falls back to a system font, and stroked glyphs print as a
 * Type 3 font; PDF preflight rejects both, so the Book check names where they are before export does.
 */
function checkFonts(sheet: HTMLElement) {
  const walker = document.createTreeWalker(sheet, NodeFilter.SHOW_TEXT);
  const missing = new Map<string, { owner: ReturnType<typeof ownerOf>; family: string; chars: Set<string> }>();
  let stroked: { owner: ReturnType<typeof ownerOf>; text: string } | undefined;
  const styles = new Map<Element, CSSStyleDeclaration>();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    const text = node.textContent ?? '';
    if (!text.trim() || !parent || parent.closest('.if-placeholder, [data-decorative], style, script, title, desc')) continue;
    let style = styles.get(parent);
    if (!style) styles.set(parent, style = getComputedStyle(parent));
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    // The bundled families of the stack set the text, each passing what it lacks to the next; without one, PDF
    // preflight already names the system font.
    const bundled = familiesOf(style.fontFamily).filter(bundlesFamily);
    const family = bundled.join(', ');
    if (bundled.length) {
      const chars = missingCharacters(text, { family: bundled, weight: Number(style.fontWeight) || 400, style: /italic|oblique/.test(style.fontStyle) ? 'italic' : 'normal' });
      if (chars.length) {
        const owner = ownerOf(parent);
        const key = JSON.stringify(owner) + family;
        const entry = missing.get(key) ?? missing.set(key, { owner, family, chars: new Set() }).get(key)!;
        for (const char of chars) entry.chars.add(char);
      }
    }
    const strokeWidth = parseFloat(style.strokeWidth);
    const textStroke = parseFloat(style.getPropertyValue('-webkit-text-stroke-width'));
    if (!stroked && ((parent instanceof SVGElement && style.stroke !== 'none' && strokeWidth > 0) || textStroke > 0)) {
      stroked = { owner: ownerOf(parent), text: text.trim().slice(0, 40) };
    }
  }
  return { missing: [...missing.values()], stroked };
}

// A short description of a text block for findings: its box/element, its edited parameter, its tag and text.
function textOwner(block: HTMLElement) {
  const owner = ownerOf(block);
  const parameter = block.closest<HTMLElement>('[data-edit]')?.dataset.edit;
  const text = (block.textContent ?? '').replace(/\s+/g, ' ').trim();
  const self = declaredNode(block) !== undefined;
  return { ...owner, ...(parameter ? { parameter } : {}), tag: block.localName, self, text: text.length > 60 ? text.slice(0, 59) + '…' : text };
}
const describe = ({ box, element, page, parameter, tag, self }: ReturnType<typeof textOwner>) => {
  const owner = box !== undefined ? declaredName({ kind: 'box', id: box, page }) : element !== undefined ? declaredName({ kind: 'element', id: element, page }) : '';
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
    if (!node.textContent?.trim() || !block || block.closest('.if-placeholder, svg, [data-decorative]')) continue;
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
// The order of a book's spreads as the app has saved it, before this frame's replacement has rendered it: `added` names
// the new spreads, each with the spread it is a copy of (duplicated) or looks like (inserted after it).
export type ProvisionalOrder = { type: 'provisional'; order: string[]; added: Record<string, { like?: string; copy?: boolean }> };
function layoutBook(root: HTMLElement, initialSheets: { spread: string; sheet: HTMLElement }[], view: BookView, format: ResolvedFormat, initial?: GridRequest) {
  let sheets = initialSheets;
  let animations: Animation[] = [];
  // The geometry last reported, from which a provisional order slides the sheets to their new places.
  let reported: BookGeometry | undefined;
  // Until it is replaced, the frame shows a structural edit at once (beta finding: an edit showed nothing until the
  // whole book had rendered again, seconds in a long book). It moves its spreads into the saved order, hides removed
  // ones, and stands in for added ones: a copy of a duplicated spread, an empty sheet of the right size for a new one.
  // What depends on the order inside the pages, such as page numbers and contents, follows with the replacement.
  const provisional = (request: ProvisionalOrder) => {
    const known = new Map(sheets.map((item) => [item.spread, item]));
    const original = new Map(initialSheets.map((item) => [item.spread, item]));
    const next: { spread: string; sheet: HTMLElement }[] = [];
    for (const spread of request.order) {
      const existing = known.get(spread) ?? original.get(spread);
      if (existing) { next.push(existing); continue; }
      const added = request.added[spread];
      const model = (added?.like !== undefined ? known.get(added.like) ?? original.get(added.like) : undefined) ?? next.at(-1) ?? sheets[0];
      if (!model) continue;
      const container = document.createElement('div');
      container.className = 'if-spread-container if-provisional';
      container.dataset.spread = spread;
      let sheet: HTMLElement;
      if (added?.copy) {
        sheet = model.sheet.cloneNode(true) as HTMLElement;
        for (const node of sheet.querySelectorAll('[data-edit], [data-box], [data-element]')) {
          node.removeAttribute('data-edit'); node.removeAttribute('data-box'); node.removeAttribute('data-element');
        }
      } else {
        sheet = document.createElement('div');
        sheet.className = 'if-sheet if-provisional-sheet';
        sheet.style.width = model.sheet.offsetWidth + 'px';
        sheet.style.height = model.sheet.offsetHeight + 'px';
        const paper = model.sheet.querySelector<HTMLElement>('.paper');
        sheet.style.background = (paper && getComputedStyle(paper).backgroundColor) || '#fff';
        sheet.append(Object.assign(document.createElement('div'), { className: 'if-spread' }));
      }
      container.append(sheet);
      next.push({ spread, sheet });
    }
    const wanted = new Set(next.map(({ sheet }) => sheet.parentElement!));
    for (const { sheet } of [...known.values(), ...original.values()]) {
      const container = sheet.parentElement!;
      if (!wanted.has(container)) container.hidden = true;
    }
    // Stand-ins that a newer order no longer lists go.
    for (const container of root.querySelectorAll<HTMLElement>(':scope > .if-provisional')) if (!wanted.has(container)) container.remove();
    for (const { sheet } of next) { const container = sheet.parentElement!; container.hidden = false; root.append(container); }
    const before = reported;
    sheets = next;
    laidOut = '';
    // Measured at rest: a slide still running from an earlier order offsets its sheets by where they came from. A busy
    // frame handles two orders at once, and reported a sheet that slid up where it had been, past the end of the shorter
    // book, so the editor scrolled to blank space below the last spread until the replacement showed.
    animations.forEach((animation) => animation.cancel());
    fit(true);
    const offsets = reorderOffsets(before, reported);
    animations = matchMedia('(prefers-reduced-motion: reduce)').matches ? [] : offsets.flatMap((offset) => {
      const slot = sheets.find((item) => item.spread === offset.spread)?.sheet.parentElement;
      return slot ? [animateReorder(slot, offset)] : [];
    });
  };
  if (view === 'thumbs' || view === 'book') {
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
      } else if (event.data?.type === 'provisional' && Array.isArray(event.data.order) && event.data.order.every((id: unknown) => typeof id === 'string') &&
          event.data.added && typeof event.data.added === 'object') {
        provisional(event.data as ProvisionalOrder);
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
  // `moved` reports the geometry as a provisional order (above), so the app slides its labels with the sheets.
  function fit(moved = false) {
    const width = root.clientWidth;
    const size = gridColumns + 'x' + width;
    if (size === laidOut) return;
    laidOut = size;
    root.classList.toggle('if-grid', gridColumns > 0);
    const count = gridColumns || columns;
    root.style.setProperty('--if-columns', String(count));
    const column = (width - pad * 2 - (gridColumns ? gap : columnGap) * (count - 1)) / count;
    for (const { sheet } of sheets) {
      const units = view === 'layouts' ? Number(sheet.parentElement?.dataset.layoutUnits) || 1 : 1;
      const available = column * units + columnGap * (units - 1);
      const fitted = available / sheet.offsetWidth;
      if (view === 'layouts') sheet.parentElement!.style.gridColumn = 'span ' + units;
      const scale = Math.max(0.01, Math.min(fitted, 1));
      const slot = sheet.parentElement!;
      slot.style.width = sheet.offsetWidth * scale + 'px';
      slot.style.height = sheet.offsetHeight * scale + 'px';
      slot.dataset.fitted = '';
      sheet.style.setProperty('--if-zoom', String(scale));
    }
    const bounds = root.getBoundingClientRect();
    const geometry: BookGeometry = {
      type: 'geometry', width: Math.ceil(bounds.width), height: Math.ceil(bounds.height), ...(gridColumns ? { columns: gridColumns } : {}),
      sheets: sheets.map(({ spread, sheet }) => ({ spread, ...relative(sheet), zoom: Number(sheet.style.getPropertyValue('--if-zoom')) || 1 })),
      boxes: sheets.flatMap(({ spread, sheet }) => {
        const scale = Number(sheet.style.getPropertyValue('--if-zoom')) || 1;
        const origin = measuredBounds(sheet.querySelector<HTMLElement>('.if-spread')!, sheet, format);
        return declaredNodes(sheet).map(({ node: box, id, page, boxType }) => {
          const rect = relative(box);
          const measured = measuredBounds(box, sheet, format);
          const sized = Math.abs(rect.width - box.offsetWidth * scale) < 1.5 && Math.abs(rect.height - box.offsetHeight * scale) < 1.5;
          return {
            spread, id, ...onPage(page), upright: sized && upright(box, sheet),
            rect: { ...measured, x: measured.x - origin.x - (box.closest('.if-page[data-side="right"]') && format.facingPages ? format.trim.width : 0), y: measured.y - origin.y },
            type: (boxType ?? 'element') as BookGeometry['boxes'][number]['type'], ...rect,
            ...(box.dataset.photoRender === 'custom' ? { custom: true } : {}),
          };
        });
      }),
      // Nodes that edit the same fields on a sheet, such as a heading shown twice, are told apart by occurrence. Every
      // target names its page, whether or not it is a box or element: two pages' `ctx.edit('heading')` are different
      // targets that edit different saved values.
      targets: sheets.flatMap(({ spread, sheet }) => numberOccurrences([...sheet.querySelectorAll<HTMLElement>('[data-edit]')].map((node) => ({
        spread, ...onPage(pageOf(node)), edits: node.dataset.edit!.split(' ').filter(Boolean), ...relative(node), upright: upright(node, sheet),
        ...(node.hasAttribute('data-inline-text') ? { inlineText: true } : {}),
        ...(/^(vertical|sideways)/.test(getComputedStyle(node).writingMode) ? { vertical: true } : {}),
        ...(node.dataset.textFallback ? { textFallback: { parameter: node.dataset.edit!, text: node.dataset.textFallback,
          label: node.dataset.textFallbackLabel ?? 'inherited text' } } : {}),
        ...ownTarget(node),
      })))),
    };
    reported = geometry;
    post(moved ? { ...geometry, motion: performance.timeOrigin + performance.now() } : geometry);
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
      const { spread, element, page, edits, occurrence, key } = event.data;
      // Answered once drawn, so the app shows a frame, or removes an editor, only when the artwork is right.
      void afterPaint().then(() => post({ type: 'inline-editing-applied', key }));
      const sheet = sheets.find((item) => item.spread === spread)?.sheet;
      if (!sheet) return;
      if (typeof element === 'string') {
        hidden = findDeclared(sheet, { element, page: page === 'left' || page === 'right' ? page : undefined }).map(({ node }) => node);
      } else if (typeof edits === 'string') {
        // Occurrences are counted per page, as the geometry numbers them.
        const marked = [...sheet.querySelectorAll<HTMLElement>('[data-edit]')]
          .filter((node) => pageOf(node) === (page === 'left' || page === 'right' ? page : undefined))
          .filter((node) => node.dataset.edit!.split(' ').filter(Boolean).join(' ') === edits)[Number(occurrence) || 0];
        if (marked) hidden = [marked];
      }
      for (const node of hidden) node.setAttribute('data-if-editing', '');
    });
    // While the app crops the photo of a box with a render callback, the template draws the gesture's placement, so
    // its mask or artwork follows the crop before it is saved. Without a placement the saved crop shows again.
    window.addEventListener('message', (event: MessageEvent) => {
      if (event.source !== parent || event.origin !== editorURL.slice(0, -1) || event.data?.type !== 'crop-preview') return;
      const { spread, box, page, placement } = event.data;
      const valid = placement && [placement.centerX, placement.centerY, placement.zoom].every(Number.isFinite);
      if (typeof spread === 'string' && typeof box === 'string' && valid) {
        setLivePlacement(spread, box, { centerX: Math.min(1, Math.max(0, placement.centerX)), centerY: Math.min(1, Math.max(0, placement.centerY)),
          zoom: Math.min(20, Math.max(1, placement.zoom)) }, page === 'left' || page === 'right' ? page : undefined);
      } else setLivePlacement('', '', undefined);
    });
  }
  fit();
  new ResizeObserver(() => fit()).observe(root);
  // A custom editor consumes actual element sizes, including CSS layout changes within a stable viewport.
  let measuring = false;
  const measure = () => {
    if (measuring) return;
    measuring = true;
    requestAnimationFrame(() => { measuring = false; laidOut = ''; fit(); });
  };
  const elements = new ResizeObserver(measure);
  // Position can change without resizing: a class/style change or a sibling's content may move an element.
  // Observe template content only; fit() writes the surrounding sheet/slot styles, so it cannot retrigger this.
  const layout = new MutationObserver(measure);
  for (const { sheet } of sheets) for (const { node, kind } of declaredNodes(sheet)) if (kind === 'element') elements.observe(node);
  for (const { sheet } of sheets) layout.observe(sheet.querySelector('.if-spread')!, {
    subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'open'],
  });
  window.addEventListener('resize', () => fit());
  return (next: GridRequest) => {
    if (view !== 'book') return;
    gridColumns = next.columns;
    fit();
  };
}

type Failure = { message: string; stack?: string; page?: PageSide };
// The message of an error, and the stack of its innermost cause, where template code threw.
function failure(error: unknown): Failure {
  let deepest = error;
  while (deepest instanceof Error && deepest.cause instanceof Error) deepest = deepest.cause;
  const stack = deepest instanceof Error ? deepest.stack : undefined;
  return { ...(error instanceof SpreadError ? onPage(error.page) : {}), message: error instanceof Error ? error.message : String(error), ...(stack ? { stack: stack.slice(0, 4000) } : {}) };
}

class LayoutRenderError extends Error {
  constructor(readonly failures: Map<string, Failure>) {
    super('Layouts failed to render: ' + [...failures].map(([spread, { message }]) => spread + ': ' + message).join('; '));
  }
}

// Problems with the template's own preview image (`preview` in defineTemplate). The app reads the file, since the frame
// cannot; the aspect ratio is compared with the default format's trimmed page, the shape of the New Book tile.
async function templatePreviewWarnings(declared: string, format: Template['format']): Promise<Issue[]> {
  let report: PreviewFileReport;
  try {
    const response = await fetch(location.pathname + '/template-preview?' + new URLSearchParams({ path: declared }));
    if (!response.ok) return [];
    report = await response.json();
  } catch { return []; }
  if ('problem' in report) return [{ message: report.problem, code: 'template-preview-invalid', details: { path: declared },
    suggestion: 'Fix the file or the preview path in the template declaration. Until then the template library shows a render of the opening spread.' }];
  const aspect = trimAspect(format);
  if (!previewAspectMismatch(report.width, report.height, aspect)) return [];
  const ratio = (value: number) => Math.round(value * 100) / 100;
  return [{ message: 'The template preview is ' + report.width + ' × ' + report.height + ' pixels, a ratio of ' + ratio(report.width / report.height) +
    ', but the default format ' + format.label + ' is ' + ratio(aspect) + '. New Book crops the preview to fill its tile.',
  code: 'template-preview-aspect', details: { path: declared, width: report.width, height: report.height, expected: ratio(aspect) },
  suggestion: 'Crop the preview to the default format, such as ' + (aspect >= 1 ? '1200 × ' + Math.round(1200 / aspect) : Math.round(1200 * aspect) + ' × 1200') + ' pixels.' }];
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
function sheetCrop(format: ResolvedFormat, side: PrintSide, bounds: 'trim' | 'bleed') {
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

// A sheet is copied once per printed side and the original is hidden. SVG references such as clip-path="url(#id)"
// resolve to the first element with that id in the document, which would be the hidden original, so each copy gets
// its own ids and its references follow them.
let printCopies = 0;

// cloneNode copies a canvas element but not its pixels, so a chart drawn on a 2D canvas would print blank.
function copyCanvases(from: HTMLElement, to: HTMLElement) {
  const sources = from.querySelectorAll('canvas'), copies = to.querySelectorAll('canvas');
  sources.forEach((source, i) => {
    const copy = copies[i];
    if (!copy || !source.width || !source.height) return;
    try { copy.getContext('2d')?.drawImage(source, 0, 0); } catch { /* A canvas that cannot be read stays as it is. */ }
  });
}

function croppedSheet(sheet: HTMLElement, crop: ReturnType<typeof sheetCrop>, pixels?: { width: number; height: number }) {
  const page = document.createElement('div');
  page.className = 'if-print-page';
  page.style.width = cssMM(crop.widthMm);
  page.style.height = cssMM(crop.heightMm);
  const clone = sheet.cloneNode(true) as HTMLElement;
  copyCanvases(sheet, clone);
  renameIds(clone, '.p' + ++printCopies);
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

// Uses the same flowed sheets and crop geometry as proof/export. Only the current crop and its neighbours
// are mounted at full size; overview crops reuse the final artwork rather than the editor decoration.
async function renderPresentation(root: HTMLElement, sheets: HTMLElement[], spreads: SpreadState[], sequence: ReturnType<typeof pageSequence>, format: ResolvedFormat, start: string,
  replacement: boolean) {
  // Keep source layouts measured while their asynchronous pictures finish. display:none would resize those
  // pictures to zero and cancel them; the presentation copies receive their finished pixels below.
  const sourceWidth = root.getBoundingClientRect().width;
  Object.assign(root.style, { position: 'absolute', left: '-100000px', top: '0', width: sourceWidth + 'px', visibility: 'hidden', pointerEvents: 'none' });
  root.inert = true;
  root.setAttribute('aria-hidden', 'true');
  const stage = document.createElement('div');
  stage.className = 'if-presentation';
  document.body.append(stage);
  const initial = Math.max(0, spreads.findIndex(({ id }) => id === start));
  let state: PresentationView = { spread: spreads[initial]?.id ?? '', side: hasSinglePage(format) ? 'page' : sequence.spreads[initial]?.span ?? 'spread', bounds: 'trim', overview: false };
  const cache = new Map<string, HTMLElement>();
  const sources = new Map<HTMLElement, HTMLElement>();
  // The drawn <svg> each presentation copy of a vector picture shows, so a copy is replaced only when it changes.
  const copiedVectors = new WeakMap<HTMLElement, Element | null>();
  let warm = false;
  let drawRevision = 0;
  let firstPaint!: () => void;
  const painted = new Promise<void>((resolve) => { firstPaint = resolve; });
  // A new revision's frame (`replacement`) starts at the spread the presentation started on, and is told the spread on
  // screen once it has drawn. It is ready only with that spread's photos, so it does not load them after it replaced
  // the previous frame, when they blinked. The presentation's first frame starts on the spread on screen, and an empty
  // book is never told a spread: neither waits.
  let told = !replacement || !spreads.length;
  const untold = told ? undefined : setTimeout(() => { told = true; draw(); }, 2000);
  function syncPictures() {
    for (const [frame, sheet] of sources) {
      const originals = sheet.querySelectorAll<HTMLElement>('.if-rendered-image');
      frame.querySelectorAll<HTMLElement>('.if-rendered-image').forEach((picture, i) => {
        const original = originals[i];
        if (!original) return;
        picture.dataset.rendered = original.dataset.rendered;
        picture.title = original.title;
        for (const property of ['--if-failure-line', '--if-failure-lines']) picture.style.setProperty(property, original.style.getPropertyValue(property));
        const image = picture.querySelector<HTMLElement>(':scope > img') as HTMLImageElement | null;
        const source = original.querySelector<HTMLElement>(':scope > img') as HTMLImageElement | null;
        if (image && source?.getAttribute('src') && image.getAttribute('src') !== source.getAttribute('src')) image.src = source.src;
        if (image && source) image.style.display = source.style.display;
        // A vector picture is an <svg> element, not an image source: copy the drawing itself. A copy made before the
        // picture was drawn, or restored from the cache, would otherwise never show it, such as a map's borders and
        // labels over its shaded relief.
        const vector = picture.querySelector<HTMLElement>(':scope > div'), drawn = original.querySelector<HTMLElement>(':scope > div');
        if (!vector || !drawn) return;
        const svg = drawn.firstElementChild;
        if (copiedVectors.get(vector) !== svg) {
          copiedVectors.set(vector, svg);
          if (svg) {
            const copy = svg.cloneNode(true) as Element;
            renameIds(copy, '.p' + ++printCopies);
            vector.replaceChildren(copy);
          } else vector.replaceChildren();
        }
        vector.style.display = drawn.style.display;
        if ('vector' in original.dataset) picture.dataset.vector = ''; else delete picture.dataset.vector;
      });
    }
  }
  function draw() {
    const revision = ++drawRevision;
    const width = innerWidth, height = innerHeight;
    const at = Math.max(0, spreads.findIndex(({ id }) => id === state.spread));
    const visible = state.overview ? spreads.map((_, i) => i) : (warm ? [at, at - 1, at + 1] : [at]).filter((i) => i >= 0 && i < sheets.length);
    activateRenderedImageSpreads(visible.map((i) => spreads[i].id));
    const columns = Math.max(1, Math.floor(width / 240));
    const cellWidth = width / columns, cellHeight = 200;
    const keep = new Set<string>();
    const fresh: HTMLElement[] = [];
    stage.classList.toggle('overview', state.overview);
    const rects: BookGeometry['sheets'] = [];
    visible.forEach((i, n) => {
      const side = state.overview || i !== at ? (hasSinglePage(format) ? 'page' : sequence.spreads[i].span) : state.side;
      const crop = sheetCrop(format, side, state.bounds);
      const scale = Math.min(((state.overview ? cellWidth : width) - 32) / crop.widthMm, ((state.overview ? cellHeight : height) - 32) / crop.heightMm);
      const w = Math.max(1, crop.widthMm * scale), h = Math.max(1, crop.heightMm * scale);
      const key = [i, side, state.bounds, w, h, state.overview].join(':');
      keep.add(key);
      let frame = cache.get(key);
      if (!frame) {
        frame = croppedSheet(sheets[i], crop, { width: w, height: h });
        frame.classList.add('if-present-crop');
        if (state.overview) {
          frame.setAttribute('role', 'button');
          frame.setAttribute('aria-label', pagesText(sequence.spreads[i].page));
          frame.addEventListener('click', () => post({ type: 'present-select', spread: spreads[i].id }));
        }
        cache.set(key, frame);
        sources.set(frame, sheets[i]);
        stage.append(frame);
        fresh.push(frame);
      }
      const x = state.overview ? (n % columns) * cellWidth + (cellWidth - w) / 2 : (width - w) / 2;
      const y = state.overview ? Math.floor(n / columns) * cellHeight + (cellHeight - h) / 2 : (height - h) / 2;
      Object.assign(frame.style, { position: 'absolute', left: x + 'px', top: y + 'px', visibility: !state.overview && i !== at ? 'hidden' : 'visible',
        outline: state.overview && i === at ? '2px solid #87baff' : '' });
      if (state.overview || i === at) rects.push({ spread: spreads[i].id, x, y, width: w, height: h });
    });
    for (const [key, frame] of cache) if (!keep.has(key)) {
      for (const image of frame.querySelectorAll('img')) image.removeAttribute('src');
      frame.remove(); sources.delete(frame); cache.delete(key);
    }
    for (const frame of fresh) for (const image of frame.querySelectorAll<HTMLImageElement>('img[data-src]')) {
      image.loading = state.overview ? 'lazy' : 'eager';
      image.src = presentationPhotoSource(image.dataset.src!, image.getBoundingClientRect().width * (devicePixelRatio || 1), state.overview);
    }
    syncPictures();
    post({ type: 'geometry', width, height: state.overview ? Math.max(height, Math.ceil(spreads.length / columns) * cellHeight) : height,
      sheets: rects, boxes: [], targets: [] });
    if (!warm) {
      const images = [...stage.querySelectorAll<HTMLImageElement>('img[data-src]')];
      void Promise.all(images.map((image) => image.complete ? Promise.resolve() : new Promise<void>((resolve) => {
        const loaded = () => { image.removeEventListener('load', loaded); image.removeEventListener('error', loaded); resolve(); };
        image.addEventListener('load', loaded, { once: true }); image.addEventListener('error', loaded, { once: true });
      }))).then(() => {
        // Then decoded: the crop shows full originals, and one that has only loaded is drawn as empty paper until
        // Chromium has decoded it, so the photos blinked once the frame replaced the previous one. The candidate frame
        // is painted (opacity .01, not hidden), so decode() resolves; a short cap guards against one that does not.
        // Readiness also follows the latest crop if fullscreen resized it meanwhile.
        const shown = [...stage.querySelectorAll<HTMLImageElement>('img')].filter((image) => image.getAttribute('src') && image.closest<HTMLElement>('.if-present-crop')?.style.visibility !== 'hidden');
        return Promise.race([Promise.allSettled(shown.map((image) => image.decode())), new Promise((resolve) => setTimeout(resolve, 3000))]);
      }).then(() => {
        if (revision === drawRevision && told) firstPaint();
      });
    }
  }
  window.addEventListener('message', (event) => {
    if (event.source !== parent || event.origin !== 'imageflow://editor' || event.data?.type !== 'present') return;
    const next = event.data as PresentationView;
    const valid = spreads.some(({ id }) => id === next.spread) && ['page', 'left', 'right', 'spread'].includes(next.side) && ['trim', 'bleed'].includes(next.bounds);
    // A spread this revision removed keeps the one the frame shows, without waiting to be told another.
    if (!valid && told) return;
    if (valid) state = next;
    told = true;
    clearTimeout(untold);
    draw();
  });
  window.addEventListener('resize', draw);
  window.addEventListener('keydown', (event) => {
    if (event.metaKey || event.ctrlKey) return;
    event.preventDefault();
    post({ type: 'present-key', key: event.key, shiftKey: event.shiftKey, metaKey: event.metaKey, ctrlKey: event.ctrlKey, altKey: event.altKey });
  });
  let queued: ReturnType<typeof setTimeout> | undefined;
  watchRenderedImages(() => { queued ??= setTimeout(() => { queued = undefined; syncPictures(); }, 0); });
  draw();
  // The current spread gets the first photo requests. Neighbours warm only after it can be shown, and slow
  // generated artwork fills in progressively instead of holding the entire presentation behind it.
  await painted;
  warm = true;
  setTimeout(draw, 0);
}
const hasSinglePage = (format: ResolvedFormat) => !format.facingPages;

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

// The design proof (proof-sheet): each spread once, cropped to its trim and scaled alike, `perPage` to an A4 sheet,
// with its pages, layout and problems under it.
type ProofOptions = { perPage: number; title: string; date: string };
function proofUnit(format: ResolvedFormat, span: string): PrintSide {
  return !format.facingPages ? 'page' : span === 'left' || span === 'right' ? span : 'spread';
}
function proofLayoutFor(format: ResolvedFormat, perPage: number) {
  const unit = { width: format.trim.width * (format.facingPages ? 2 : 1), height: format.trim.height };
  return { unit, layout: proofLayout(unit, perPage) };
}
// Photos load once laid out, each as wide as it shows on the proof sheet, in the presentation's rendition sizes.
function loadProofPhotos(root: HTMLElement, scale: number) {
  for (const image of root.querySelectorAll<HTMLImageElement>('img[data-src]')) {
    image.src = presentationPhotoSource(image.dataset.src!, proofPhotoPixels(image.getBoundingClientRect().width * 25.4 / 96, scale), false);
  }
}
function makeProofPages(root: HTMLElement, sheets: HTMLElement[], sequence: ReturnType<typeof pageSequence>, format: ResolvedFormat,
  spreads: SpreadState[], where: string[], errors: Issue[], options: ProofOptions) {
  const { unit, layout } = proofLayoutFor(format, options.perPage);
  const { margin, header, label, gapX, gapY } = proofSheet;
  const style = document.createElement('style');
  style.textContent = '@page { size: ' + cssMM(layout.page.width) + ' ' + cssMM(layout.page.height) + '; margin: 0; }';
  document.head.append(style);
  document.title = options.title + ' – Proof';
  const perPage = layout.columns * layout.rows;
  const count = Math.ceil(sheets.length / perPage);
  const element = (tag: string, className: string, text?: string) => {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const pages = document.createDocumentFragment();
  for (let p = 0; p < count; p++) {
    const page = element('section', 'if-proof-page');
    page.style.width = cssMM(layout.page.width);
    page.style.height = cssMM(layout.page.height);
    page.style.padding = cssMM(margin);
    const head = element('header', 'if-proof-header');
    head.style.height = cssMM(header);
    head.append(element('span', 'if-proof-title', options.title), element('span', 'if-proof-meta',
      'Proof' + (options.date ? ' · ' + options.date : '') + ' · ' + (p + 1) + ' / ' + count));
    const grid = element('div', 'if-proof-grid');
    grid.style.gridTemplateColumns = 'repeat(' + layout.columns + ', ' + cssMM(layout.cell.width) + ')';
    grid.style.gridAutoRows = cssMM(layout.cell.height);
    grid.style.columnGap = cssMM(gapX);
    grid.style.rowGap = cssMM(gapY);
    for (let i = p * perPage; i < Math.min(sheets.length, (p + 1) * perPage); i++) {
      const side = proofUnit(format, sequence.spreads[i].span);
      const crop = sheetCrop(format, side, 'trim');
      const cell = element('figure', 'if-proof-cell');
      const art = element('div', 'if-proof-art');
      art.style.width = cssMM(unit.width * layout.scale);
      art.style.height = cssMM(unit.height * layout.scale);
      const frame = element('div', 'if-proof-frame');
      frame.style.width = cssMM(crop.widthMm * layout.scale);
      frame.style.height = cssMM(crop.heightMm * layout.scale);
      // A single page keeps its place in the spread: the opening right page on the right.
      if (side === 'right') frame.style.marginLeft = cssMM((unit.width - crop.widthMm) * layout.scale);
      else if (side === 'page') frame.style.marginInline = 'auto';
      const copy = croppedSheet(sheets[i], crop);
      copy.className = 'if-proof-crop';
      copy.style.transform = 'scale(' + layout.scale + ')';
      (copy.firstElementChild as HTMLElement).style.top = cssMM(-crop.y);
      frame.append(copy);
      if (side === 'spread') frame.append(element('div', 'if-proof-fold'));
      art.append(frame);
      const caption = element('figcaption', 'if-proof-label');
      caption.style.height = cssMM(label);
      caption.append(element('span', 'if-proof-where', where[i]));
      const own = errors.filter((issue) => issue.spread === spreads[i].id);
      const missing = own.filter(isUnavailableSource).length;
      const problems = own.length - missing;
      if (missing || problems) caption.append(element('span', 'if-proof-problem',
        [missing ? 'Original unavailable' : '', problems ? problems + (problems === 1 ? ' problem' : ' problems') : ''].filter(Boolean).join(' · ')));
      cell.append(art, caption);
      grid.append(cell);
    }
    page.append(head, grid);
    pages.append(page);
  }
  root.hidden = true;
  document.body.append(pages);
}

function measuredBounds(node: HTMLElement, sheet: HTMLElement, format: Pick<ResolvedFormat, 'spreadWidth'>) {
  const outer = sheet.getBoundingClientRect(), rect = node.getBoundingClientRect();
  const scale = format.spreadWidth / outer.width;
  return { x: (rect.left - outer.left) * scale, y: (rect.top - outer.top) * scale, width: rect.width * scale, height: rect.height * scale };
}

function typographyOf(node: HTMLElement) {
  const style = getComputedStyle(node);
  const points = (value: string) => Math.round(parseFloat(value) * 72 / 96 * 100) / 100;
  return { fontFamily: style.fontFamily, fontSizePt: points(style.fontSize),
    lineHeightPt: style.lineHeight === 'normal' ? null : points(style.lineHeight), fontWeight: style.fontWeight, color: style.color };
}

function inspectElements(sheet: HTMLElement, spread: SpreadState, template: Template, format: ResolvedFormat,
  request: ReturnType<typeof inspectionSchema.parse>): ElementInspection {
  const nodes = request.box ? findDeclared(sheet, { box: request.box, page: request.page }) : request.element ? findDeclared(sheet, { element: request.element, page: request.page }) : declaredNodes(sheet).filter(node => !request.page || node.page === request.page);
  if ((request.box || request.element) && !nodes.length) throw new PreviewError('preview-target-not-found', 'The requested box or element is not rendered on spread ' + spread.id + '.');
  const items: ElementMeasurement[] = nodes.slice(request.offset, request.offset + request.limit).map(({ node, kind: declared, id, page }) => {
    // A node on a page belongs to that page's layout and state (validated before inspection); a page that draws a box
    // or element shows a declared layout, never the blank page.
    const state = scopeState(spread, page)!;
    const definition = template.spreads[state.definition!];
    const box = declared === 'box', kind = box ? definition.boxes[id].type : 'element';
    const prefix = (box ? 'boxes.' : 'elements.') + id + '.';
    const parameters = box ? definition.boxes[id].parameters : definition.elements[id].parameters;
    const source = box ? state.boxes[id]?.photo ?? state.boxes[id]?.text : undefined;
    return { spread: spread.id, id, ...onPage(page), kind, boundsMm: measuredBounds(node, sheet, format), upright: upright(node, sheet),
      typography: typographyOf(node),
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
function annotationLayer(sheet: HTMLElement) {
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
  sheet.append(layer);
  return add;
}

function annotateSheet(sheet: HTMLElement, format: ResolvedFormat, { guides, labels }: { guides: boolean; labels: boolean }) {
  const add = annotationLayer(sheet);
  if (labels) {
    for (const found of declaredNodes(sheet)) {
      add(measuredBounds(found.node, sheet, format), { border: '0.35mm solid #ff6a00' }, declaredName(found));
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
}

// The flowed book stays laid out at its size while the artwork shows its copy. Hiding it with display:none would
// resize every <RenderedImage> in it to nothing, which starts new drawings and revokes the pictures the copy shows.
// Paint containment also keeps position:fixed content of the template inside the hidden book.
function hideArtworkSource(root: HTMLElement) {
  const width = root.getBoundingClientRect().width;
  Object.assign(root.style, { position: 'absolute', left: '-100000px', top: '0', width: width + 'px', visibility: 'hidden',
    contain: 'paint', pointerEvents: 'none' });
  root.inert = true;
  root.setAttribute('aria-hidden', 'true');
}

// Painted just below the artwork in the same frame, so the capture can tell its pixels from an older frame's.
function paintSentinel(sentinel: Sentinel, top: number) {
  const strip = document.createElement('div');
  strip.className = 'if-capture-sentinel';
  Object.assign(strip.style, { position: 'fixed', left: '0', top: top + 'px', width: sentinelWidth + 'px', height: sentinelStrip.height + 'px',
    display: 'flex', zIndex: '2147483647' });
  for (const color of [sentinel.first, sentinel.second, sentinel.first]) {
    const cell = document.createElement('div');
    Object.assign(cell.style, { width: sentinelStrip.cellWidth + 'px', height: '100%', background: 'rgb(' + color.join(',') + ')' });
    strip.append(cell);
  }
  document.body.append(strip);
}

function renderArtwork(root: HTMLElement, sheets: HTMLElement[], spreads: SpreadState[], sequence: ReturnType<typeof pageSequence>,
  format: ResolvedFormat, artwork: ReturnType<typeof parsePreviewRequest>, fixture?: FixtureMarking) {
  if ('cover' in artwork.target) throw new PreviewError('invalid-preview-request', 'Use the cover renderer for an exterior cover preview.');
  if ('picker' in artwork.target) throw new PreviewError('invalid-preview-request', 'Use the picker renderer for a layout family\'s picker.');
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
    hideArtworkSource(root);
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
    const node = findDeclared(sheets[index], box ? { box, page: request.page } : { element: element!, page: request.page })[0]?.node;
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
  hideArtworkSource(root);
  document.body.append(frame);
  return { frame, metadata: { width, height, widthMm, heightMm, bounds, spread, side, page, ...(detail ? { detail } : {}), ...overlays } as PreviewMetadata };
}

// Font faces that were requested but could not be loaded. The book renders with a fallback font instead.
function fontFailures() {
  return [...new Set([...document.fonts].filter((font) => font.status === 'error')
    .map((font) => font.family.replace(/^["']|["']$/g, '')))].sort();
}

// The pictures in `root` to wait for: HTML images with a source, and SVG <image> references, such as a PhotoBox render
// callback draws. An SVG image is loaded through a detached HTML image with the same URL, which the SVG then shares
// from the cache; `pictureSource` maps it back to the SVG element for error reports.
const pictureSource = new WeakMap<HTMLImageElement, Element>();
function decodable(root: ParentNode): HTMLImageElement[] {
  const html = [...root.querySelectorAll<HTMLImageElement>('img[src]')];
  const svg = [...root.querySelectorAll<SVGImageElement>('image')].flatMap((node) => {
    const href = node.getAttribute('href') ?? node.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
    if (!href) return [];
    const proxy = new Image();
    proxy.alt = node.getAttribute('aria-label') ?? '';
    proxy.src = new URL(href, document.baseURI).href;
    pictureSource.set(proxy, node);
    return [proxy];
  });
  return [...html, ...svg];
}

// The HTML a text flows as: its Markdown, or what the composition named by the box it starts in makes of its blocks.
// The composition renders off the page, once per text, before the flow.
function textHtml(template: Template, book: RenderProject, source: string, composition: string | undefined, spread: string, page?: PageSide) {
  if (!composition) return markdownToHtml(book.texts[source]);
  const { element, blocks } = textComposition(template, book, composition, book.texts[source], spread, page);
  const host = document.createElement('div');
  let failure: { error: unknown } | undefined;
  const fail = (error: unknown) => { failure ??= { error }; };
  const react = createRoot(host, { onUncaughtError: fail, onCaughtError: fail });
  let staged = '';
  try {
    flushSync(() => react.render(element));
    staged = host.innerHTML;
  } finally {
    react.unmount();
  }
  if (failure) throw failure.error;
  return composeHtml(staged, blocks);
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
async function renderLayouts(root: HTMLElement, book: RenderProject, template: Template, info: TemplateInfo, spreadId: string, side?: PageSide) {
  const { spreads } = book.project;
  const index = spreads.findIndex(({ id }) => id === spreadId);
  if (index < 0) throw new Error('Spread does not exist.');
  const format = resolveFormat(template.format);
  const sequence = pageSequence(spreads.map((spread) => layoutFootprint(spread, template.spreads)), template.format);
  // A preview is the spread itself in another layout: switching only changes which of its content is shown.
  // A family with its own picker shows one preview, which stands for the family.
  const position = { index, count: spreads.length };
  const previews = editorLayoutPreviews(template.spreads, spreads[index], template.layoutFamilies, template.format, position, side, true)
    .sort((a, b) => Number(template.spreads[b].span === 'spread') - Number(template.spreads[a].span === 'spread'))
    .map((definition) => {
      const layout = template.spreads[definition];
      const required = spanRequiredAt(index, spreads.length, template.format);
      const wantedSide = required === 'left' || required === 'right' ? required : side ?? 'left';
      const previewSide = layout.span === 'page' && layout.sides && !layout.sides.includes(wantedSide) ? layout.sides[0] : wantedSide;
      const target = editorLayoutTarget(template.spreads, definition, template.format, position, previewSide);
      const planned = planLayoutChange(spreads[index], target, template.spreads).spread;
      const pageLayout = template.spreads[definition].span === 'page';
      // A page candidate is shown alone, with its side's values after the actual change planner has run. The facing
      // page remains in the planned sheet for switching, but has no place in this single-page thumbnail.
      const state = target.page ? scopeSpread(planned, target.page)! : planned;
      const spread = { ...state, id: definition };
      const page = pageLayout && format.facingPages ? { [previewSide]: sequence.spreads[index].page[previewSide] ?? sequence.spreads[index].page.left ?? sequence.spreads[index].page.right } : sequence.spreads[index].page;
      return { definition, span: pageLayout ? 'page' : template.spreads[definition].span, spread, page,
        crop: format.facingPages ? pageLayout ? previewSide : template.spreads[definition].span === 'left' ? 'left' : template.spreads[definition].span === 'right' ? 'right' : undefined : undefined };
    });
  // The spread's own layout, or its page's: its preview draws its pictures as they are (RenderedImage).
  const current = side && spreads[index].split ? spreads[index].pages?.[side]?.definition : spreads[index].definition;
  // Previews read the anchors of the book as saved, so a contents layout shows the real pages.
  const anchors = bookIndex(book, template, sequence);
  const offerBlank = format.facingPages && spanRequiredAt(index, spreads.length, template.format) === 'spread';
  root.className = 'if-preview';
  let renderError: unknown;
  const react = createRoot(root, { onUncaughtError: (error) => { renderError = error; } });
  flushSync(() => react.render(<>{previews.map(({ definition, span, spread, page }) => (
    <div className="if-spread-container" data-layout-units={span === 'spread' ? 2 : 1} data-span={span} data-spread={definition} data-layout={definition} key={definition}
      data-current-layout={definition === current ? '' : undefined}>
      <SpreadView book={book} spread={spread} template={template} format={format} positions={{}}
        page={page} index={anchors} renderPhotos bookSpread={spreads[index].id} />
    </div>
  ))}{offerBlank && <div className="if-spread-container" data-layout-units="1" data-spread="__blank__">
    <div className="if-sheet if-blank-layout" style={{ width: cssMM(format.trim.width + (format.facingPages ? format.bleed.outside : 0)), height: cssMM(format.height) }}>
      <div className="if-spread" style={{ left: 0, top: 0, width: '100%', height: '100%' }} />
    </div>
  </div>}</>));
  if (renderError) throw renderError;
  await settle(decodable(root));
  const containers = root.querySelectorAll<HTMLElement>('.if-spread-container');
  const sheets = previews.map(({ definition, spread, crop }, n) => {
    const { sheet, boxes } = validateSpread(containers[n], spread, template, format, definition, [], []);
    const sources = new Map<string, { targets: HTMLElement[]; groups: number[]; next: number; composition?: string }>();
    const order = Object.entries(template.spreads[definition].boxes).sort(([, a], [, b]) => (a.flowOrder ?? 1) - (b.flowOrder ?? 1));
    for (const [box, { composition }] of order) {
      const source = spread.boxes[box]?.text;
      if (!source || book.texts[source] === undefined || !boxes.has(box)) continue;
      const entry = sources.get(source) ?? sources.set(source, { targets: [], groups: [], next: 0, composition }).get(source)!;
      const together = aligned(boxes.get(box)!);
      let group = entry.next++;
      for (const rect of rectsOf(boxes, box)) { entry.targets.push(rect); entry.groups.push(group); if (!together) group = entry.next++; }
    }
    for (const [source, { targets, groups, composition }] of sources) {
      let html: string;
      // A preview has nowhere to report a failing composition; the book's own render does.
      try { html = textHtml(template, book, source, composition, spreads[index].id); } catch { html = markdownToHtml(book.texts[source]); }
      flow.run(html, targets, 'columns', groups);
    }
    if (crop) {
      const page = sheetPages(format).find(({ side }) => side === crop)!;
      const artwork = sheet.querySelector<HTMLElement>('.if-spread')!;
      // Keep page-local rendering and mirrored insets from the original format, while displaying only one page.
      sheet.style.width = cssMM(page.bleedWidth);
      artwork.style.left = cssMM(sheetBleed(format).left - page.bleedX);
    }
    return { spread: definition, sheet };
  });
  if (offerBlank) sheets.push({ spread: '__blank__', sheet: containers[containers.length - 1].querySelector<HTMLElement>('.if-sheet')! });
  layoutBook(root, sheets, 'layouts', format);
  await settleRestoredImages();
  publish({ state: 'ready', template: info, pages: sequence.count, units: [], errors: [], warnings: [], flow: {}, anchors: anchors.anchors });
}

// Loads the photos of spreads within a screen of the visible range and unloads those more than three screens
// away, so memory and the work per edit follow what is on screen rather than the length of the book.
type Viewport = { top: number; bottom: number; left: number; right: number; spreads?: Set<string> };
// Loads the photos of spreads within a screen's distance of the visible area, in both directions, and unloads those
// far from it.
function photoLoader(root: HTMLElement, visible: () => Viewport | undefined) {
  const containers = [...root.querySelectorAll<HTMLElement>('.if-spread-container')];
  return () => {
    const profileStart = import.meta.env.IMAGEFLOW_PROFILE ? performance.now() : 0;
    const range = visible() ?? { top: 0, bottom: screen.height, left: 0, right: screen.width };
    if (range.bottom <= range.top || range.right <= range.left) return [];
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
      // Boxes with a render callback draw their photo only while near the screen, and drop it when far away.
      for (const box of container.querySelectorAll<HTMLElement>('[data-photo-render="custom"]')) {
        const shown = box.dataset.near === '';
        if (near && !shown) {
          box.dataset.near = '';
          box.dispatchEvent(new CustomEvent(photoNearEvent, { detail: true }));
          loading.push(...decodable(box));
        } else if (far && shown) {
          delete box.dataset.near;
          box.dispatchEvent(new CustomEvent(photoNearEvent, { detail: false }));
        }
      }
    }
    if (import.meta.env.IMAGEFLOW_PROFILE) performance.measure('imageflow.photoLoader', { start: profileStart, end: performance.now() });
    return loading;
  };
}

// Runs a template-supplied editor: an element's, or a document editor opened from a spread. The component edits a
// draft of the editor's parameters; the frame reports the draft, its height, and commit or cancel to the app, which
// validates and saves. The frame never changes project data itself. Its read-only context follows the book: the app
// names each newer render session, and the frame recomputes the context from it.
// Identifies the project's files and their contents, so a changed file refreshes an open editor. A short hash keeps
// large files out of the key.
function filesKey(book: RenderProject) {
  return JSON.stringify(Object.entries(book.files).map(([id, found]) => {
    const text = found.text ?? '';
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
    return [id, book.project.files[id], found.problem ?? '', text.length, hash >>> 0];
  }));
}

function renderEditor(root: HTMLElement, book: RenderProject, template: Template, spreadId: string, target: { element: string } | { editor: string }, readOnly: boolean,
  presentation: EditorPresentation, page?: import('./project').PageSide) {
  const spread = scopeSpread(book.project.spreads.find(({ id }) => id === spreadId), page);
  const layout = spread && template.spreads[spread.definition];
  const documentEditor = 'editor' in target && Object.hasOwn(template.editors ?? {}, target.editor) ? template.editors![target.editor] : undefined;
  const element = 'element' in target ? layout?.elements[target.element] : undefined;
  const elementId = 'element' in target ? target.element : '';
  const editor = documentEditor ?? element?.editor;
  const opened = editorContext(book, template, spreadId, page);
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
      const next = refreshedEditorContext(latest, template, spreadId, page);
      if (!next) return;
      const measured = withEditorGeometry(next.context, measurements);
      // The project's files count too: an editor reading `file(id)` shows the file's current content.
      const key = next.key + JSON.stringify(Object.fromEntries(Object.entries(measured.elements).map(([id, element]) => [id, element.rect])))
        + filesKey(latest);
      if (key === contextKey) return;
      setTemplateFiles(latest.files);
      projectFiles = latest.project.files;
      updateFiles?.(projectFiles);
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
    if (event.data?.type === 'editor-click' && presentation === 'inline') {
      // The click on the page that opened this editor, at the same place in it.
      const { x, y, altKey } = event.data;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      const target = window.document.elementFromPoint(x, y);
      if (!(target instanceof HTMLElement)) return;
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, altKey: !!altKey }));
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
  // For a list, `item` and `field` name one field of one item (by its ID), and the control writes the whole list with
  // that field changed.
  // Item IDs a list's controls have shown: a control for one of them renders nothing once the item is removed, while
  // an ID never seen is a mistake in the editor.
  const seenItems = new Set<string>();
  function Control({ parameter, label, scope = 'element', itemId: item, field }: { parameter: string; label?: string; scope?: 'element' | 'spread'; itemId?: string; field?: string }) {
    const values = React.useContext(EditorValues)[scope === 'spread' ? 'spread' : 'element'];
    const [owned, parameters] = scope === 'spread' ? [ownedSpread, layout!.parameters] : [editor!.parameters, declared];
    const param = owned.includes(parameter) && Object.hasOwn(parameters, parameter) ? parameters[parameter] : undefined;
    if (!param) throw new Error(unknownControl(parameter, owned, scope));
    const value = resolveValue(param, values[parameter]);
    const write = (next: Values[string]) => changes(scope === 'spread' ? 'spread' : 'element', { [parameter]: next });
    if (item !== undefined || field !== undefined) {
      if (param.type !== 'list') throw new Error('Control ' + parameter + ' is not a list, so it takes no itemId or field.');
      const items = value as ListItem[];
      const fieldParam = field !== undefined && Object.hasOwn(param.item, field) ? param.item[field] : undefined;
      if (!fieldParam) throw new Error('Control ' + parameter + ' needs field, one of: ' + Object.keys(param.item).join(', ') + '.');
      if (typeof item !== 'string') throw new Error('Control ' + parameter + ' with field ' + field + ' needs itemId, the id of one of its items.');
      const key = scope + ' ' + parameter + ' ';
      for (const { id } of items) seenItems.add(key + id);
      const current = items.find(({ id }) => id === item);
      // An item that was just removed renders nothing rather than failing the editor; an unknown ID is a mistake.
      if (!current) {
        if (seenItems.has(key + item)) return null;
        throw new Error('Control ' + parameter + ' has no item ' + JSON.stringify(item) + '. Use the id of one of its items.');
      }
      return React.createElement('fieldset', { className: 'if-control', disabled: readOnly },
        React.createElement(Field, { param: label ? { ...fieldParam, label } : fieldParam, value: current[field!],
          change: (next) => write(items.map((other) => other.id === item ? { ...other, [field!]: next as ListItem[string] } : other)) }));
    }
    return React.createElement('fieldset', { className: 'if-control', disabled: readOnly },
      React.createElement(Field, { param: label ? { ...param, label } : param, value, change: write }));
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
      // Mounted: the app sends the measured context now, so the editor can draw before it is announced ready.
      post({ type: 'editor-mounted' });
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
  readOnly: boolean, page?: PageSide) {
  const sheet = book.project.spreads.find(({ id }) => id === spreadId);
  const spread = scopeSpread(sheet, page);
  const family = template.layoutFamilies && Object.hasOwn(template.layoutFamilies, familyId) ? template.layoutFamilies[familyId] : undefined;
  const picker = family?.picker;
  if (!spread || !family || !picker?.component) throw new Error('This layout family has no picker component.');
  const ids = familyLayouts(template.spreads, familyId);
  const variants = ids.map((id) => ({ id, label: template.spreads[id].label, variant: { ...template.spreads[id].variant } }));
  let document = resolveParams(template.parameters, book.project.params);
  const format = resolveFormat(template.format);
  root.className = 'if-editor if-layout-settings';
  let saved = sheet?.split && !page ? '' : spread.definition;
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
      if (typeof event.data.saved !== 'string' || (event.data.saved !== '' && !Object.hasOwn(template.spreads, event.data.saved)) || typeof event.data.readOnly !== 'boolean') return;
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
    return React.createElement(picker!.component!, {
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

// The width of the Inspector's settings column, where a family's picker is shown.
const pickerWidth = 260;
type PickerTarget = Extract<ReturnType<typeof parsePreviewRequest>['target'], { picker: true }>;

/**
 * Draws a layout family's picker for check_book, as the settings show it, and optionally clicks the control named by
 * `choose` to report the variant the picker would switch to (API-008). It runs the template's own picker component, or
 * the app's choice for a `choice` picker, and saves nothing: `choose` only records the choice.
 */
async function renderPickerArtwork(book: RenderProject, template: Template, target: PickerTarget, width: number) {
  const sheet = book.project.spreads.find(({ id }) => id === target.spread);
  if (!sheet) throw new PreviewError('preview-target-not-found', 'Spread ' + target.spread + ' does not exist in this book.');
  if (target.page && !sheet.split) throw new PreviewError('preview-target-not-found', 'Spread ' + target.spread + ' is not shown as two pages; omit page.');
  const spread = scopeSpread(sheet, target.page);
  const shown = sheet.split && !target.page ? undefined : spread?.definition;
  const familyId = target.family ?? (shown ? template.spreads[shown]?.family : undefined);
  const families = Object.keys(template.layoutFamilies ?? {});
  if (!familyId || !template.layoutFamilies || !Object.hasOwn(template.layoutFamilies, familyId)) {
    throw new PreviewError('preview-target-not-found', (target.family ? 'The template has no layout family ' + target.family + '.'
      : 'Spread ' + target.spread + (target.page ? ' (' + target.page + ' page)' : '') + ' does not show a layout of a family; name one with family.') +
      (families.length ? ' Families: ' + families.join(', ') + '.' : ' The template declares no layout families.'));
  }
  const family = template.layoutFamilies[familyId];
  const ids = familyLayouts(template.spreads, familyId);
  if (!family.picker) throw new PreviewError('preview-target-not-found', 'The layout family ' + familyId + ' has no picker: the sidebar shows each of its layouts.');
  if (target.current !== undefined && !ids.includes(target.current)) {
    throw new PreviewError('preview-target-not-found', target.current + ' is not a layout of ' + family.label + '. Its layouts: ' + ids.join(', ') + '.');
  }
  const variants = ids.map((id) => ({ id, label: template.spreads[id].label, variant: { ...template.spreads[id].variant } }));
  const saved = target.current ?? (shown && ids.includes(shown) ? shown : ids[0]);
  const notices: string[] = [];
  let draft = saved;
  let refresh: (() => void) | undefined;
  const choose = (id: string) => {
    if (typeof id !== 'string' || !ids.includes(id)) {
      notices.push('The picker chose ' + String(id) + ', which is not a layout of ' + family.label + '. It can choose ' + ids.join(', ') + '.');
      return;
    }
    draft = id;
    refresh?.();
  };
  const find = (tags: VariantTags) => {
    const wanted = Object.entries(tags ?? {});
    return variants.find(({ variant }) => wanted.every(([key, value]) => Object.hasOwn(variant, key) && variant[key] === value))?.id;
  };
  const document = resolveParams(template.parameters, book.project.params);
  const format = resolveFormat(template.format);
  const frame = window.document.createElement('div');
  frame.className = 'if-editor if-layout-settings if-picker-preview';
  Object.assign(frame.style, { position: 'fixed', left: '0', top: '0', zIndex: '2147483646', boxSizing: 'border-box',
    width: width + 'px', padding: '8px', background: '#f5f5f5', colorScheme: 'only light' });
  window.document.body.append(frame);
  const failures: unknown[] = [];
  function Host() {
    const [, update] = React.useReducer((value: number) => value + 1, 0);
    React.useEffect(() => { refresh = update; return () => { refresh = undefined; }; }, []);
    const choice = family.picker!.choice;
    if (choice) {
      const options = ids.map((id) => ({ value: id, label: choice.options[String(template.spreads[id].variant?.[choice.tag])] ?? id }));
      return React.createElement(Choice<string>, { label: family.picker!.label ?? family.label, hideLabel: true, value: draft, options, onChange: choose });
    }
    return React.createElement(family.picker!.component!, {
      variants, current: draft, saved, choose, find, document, format, readOnly: false, commit: () => {}, cancel: () => {},
    });
  }
  const react = createRoot(frame, { onUncaughtError: (error) => failures.push(error), onCaughtError: (error) => failures.push(error) });
  flushSync(() => react.render(React.createElement(Host)));
  const failed = () => {
    if (!failures.length) return;
    const error = failures[0];
    throw new PreviewError('render-failed', 'The picker of ' + family.label + ' failed: ' + (error instanceof Error ? error.message : String(error)));
  };
  failed();
  let chosen: string | undefined;
  if (target.choose !== undefined) {
    const name = (node: Element) => (node.getAttribute('aria-label') ?? node.getAttribute('title') ?? (node as HTMLElement).innerText ?? node.textContent ?? '').trim();
    const controls = [...frame.querySelectorAll('button, [role="radio"], [role="option"], [role="tab"], [role="button"], [role="checkbox"], [role="switch"], input, label')];
    const wanted = target.choose.trim().toLowerCase();
    const control = controls.find((node) => name(node).toLowerCase() === wanted);
    if (!control) {
      const names = [...new Set(controls.map(name).filter(Boolean))];
      throw new PreviewError('preview-target-not-found', 'The picker has no control labelled ' + target.choose + '.' +
        (names.length ? ' Its controls: ' + names.join(', ') + '.' : ''));
    }
    if ((control as HTMLButtonElement).disabled || control.getAttribute('aria-disabled') === 'true') {
      notices.push('The control ' + target.choose + ' is disabled, so clicking it changes nothing.');
    } else {
      const before = draft;
      flushSync(() => (control as HTMLElement).click());
      failed();
      chosen = draft;
      if (draft === before && !notices.length) notices.push('Clicking ' + target.choose + ' kept ' + draft + '.');
    }
  }
  // Let the picker settle, such as a layout effect that measures itself, before measuring and capturing it.
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  failed();
  const height = Math.max(1, Math.ceil(frame.getBoundingClientRect().height));
  frame.style.height = height + 'px';
  const metadata: PickerPreviewMetadata = { kind: 'picker', width, height, spread: sheet.id, ...(target.page ? { page: target.page } : {}),
    family: familyId, picker: family.picker.choice ? 'choice' : 'component', variants, current: saved,
    ...(chosen !== undefined ? { chosen } : {}), ...(notices.length ? { notices } : {}) };
  return { frame, metadata };
}

function coverArtworkPreview(root: HTMLElement, sheet: HTMLElement, cover: Exclude<CoverResolution, { status: 'unavailable' }>,
  artwork: ReturnType<typeof parsePreviewRequest>, query: URLSearchParams) {
  const { target, bounds, guides, labels, maxEdge } = artwork;
  const { geometry } = cover;
  const relative = (rect: Rect) => ({ ...rect, x: rect.x - geometry.sheet.x, y: rect.y - geometry.sheet.y });
  let crop = relative(bounds === 'trim' ? geometry.trim : geometry.sheet);
  let detail: CoverPreviewMetadata['detail'];
  if ('cover' in target && (target.box || target.element)) {
    const owner = target.box ? { box: target.box } : { element: target.element! };
    const node = findDeclared(sheet, owner)[0]?.node;
    if (!node) throw new PreviewError('preview-target-not-found', 'The requested box or element is not drawn on the cover.');
    const rect = measuredBounds(node, sheet, { spreadWidth: geometry.sheet.width });
    const padding = target.paddingMm ?? 2;
    const x = Math.max(crop.x, rect.x - padding), y = Math.max(crop.y, rect.y - padding);
    const width = Math.min(crop.x + crop.width, rect.x + rect.width + padding) - x;
    const height = Math.min(crop.y + crop.height, rect.y + rect.height + padding) - y;
    if (width <= 0 || height <= 0) throw new PreviewError('preview-target-not-found', 'The requested cover artwork has no visible area.');
    crop = { x, y, width, height };
    detail = { ...owner, xMm: x, yMm: y };
  }
  if (guides || labels) {
    const add = annotationLayer(sheet);
    if (guides) {
      add(relative(geometry.trim), { border: '0.3mm solid #e6007e' });
      for (const area of Object.values(geometry.safe)) if (area) add(relative(area), { border: '0.3mm dashed #00a3e0' });
      for (const x of geometry.folds) add(relative({ x, y: geometry.sheet.y, width: .2, height: geometry.sheet.height }), { background: '#e6007e' });
    }
    if (labels) for (const node of declaredNodes(sheet)) {
      add(measuredBounds(node.node, sheet, { spreadWidth: geometry.sheet.width }), { border: '0.35mm solid #ff6a00' }, declaredName(node));
    }
  }
  const scale = maxEdge / Math.max(crop.width, crop.height);
  const width = Math.max(1, Math.round(crop.width * scale)), height = Math.max(1, Math.round(crop.height * scale));
  const frame = croppedSheet(sheet, { x: crop.x, y: crop.y, widthMm: crop.width, heightMm: crop.height }, { width, height });
  const marker = query.get('sentinel');
  const sentinel = marker && parseSentinel(marker);
  if (sentinel) {
    frame.dataset.previewArtwork = marker;
    paintSentinel(sentinel, height);
  }
  hideArtworkSource(root);
  document.body.append(frame);
  const metadata: CoverPreviewMetadata = { cover: true, width, height, widthMm: crop.width, heightMm: crop.height, bounds,
    interiorPages: cover.interiorPages, ...(cover.status === 'provisional' ? { previewPages: cover.previewPages } : {}),
    ...(detail ? { detail } : {}), ...(guides ? { guides: true } : {}), ...(labels ? { labels: true } : {}) };
  window.imageflowPreview = { state: 'ready', metadata };
}

async function renderPhysicalCover(root: HTMLElement, book: RenderProject, template: ReturnType<typeof chooseFormat>,
  info: TemplateInfo, sequence: ReturnType<typeof pageSequence>, query: URLSearchParams, renderIssues: () => string[]) {
  const formats = template.coverFormats;
  const coverFormat = !template.unknownChoice && formats && Object.hasOwn(formats, template.formatId) ? formats[template.formatId] : undefined;
  const interiorPages = book.fixture?.coverPages ?? sequence.count;
  const cover = resolveCover({ interior: template.format, cover: coverFormat }, interiorPages);
  if (cover.status === 'unavailable') throw new PreviewError('cover-unavailable', 'This format does not have an exterior cover.');
  const state = book.project.cover;
  const candidates = coverLayoutsFor(template.coverLayouts, template.formatId);
  const layout = state && Object.hasOwn(candidates, state.definition) ? candidates[state.definition] : undefined;
  const { geometry } = cover;
  const edit = book.mode === 'edit';
  const errors: Issue[] = [], warnings: Issue[] = [];
  const issue = (message: string, code: string, box?: string): Issue => ({ message, code, cover: true, where: 'Cover', box });
  if (cover.status === 'provisional') {
    errors.push(issue('The cover needs a supported interior page count. The preview uses ' + cover.previewPages + ' pages.', 'cover-page-count'));
  } else if (book.fixture?.coverPages === undefined && sequence.issues.length) {
    errors.push(issue('Fix the interior page sequence before exporting the cover. ' + sequence.issues[0], 'cover-page-sequence'));
  }
  if (!layout) errors.push(issue('Choose a cover layout for this format.', 'cover-layout-unavailable'));
  const printing = !edit && query.get('view') === 'cover';
  const artwork = query.get('view') === 'cover-artwork' ? parsePreviewRequest(JSON.parse(query.get('request') ?? 'null')) : undefined;
  const inspect = query.has('inspect') ? inspectionSchema.parse(JSON.parse(query.get('inspect')!)) : undefined;
  if (printing && errors.length) throw new Error(errors[0].message);
  if (!layout && (artwork || inspect)) throw new PreviewError('preview-target-not-found', 'Choose a cover layout before requesting its artwork.');

  const width = cssMM(geometry.sheet.width), height = cssMM(geometry.sheet.height);
  root.className = 'if-cover-root';
  if (edit) {
    root.classList.add('if-preview');
    const fit = () => {
      root.style.transform = 'scale(' + Math.min(innerWidth / (geometry.sheet.width * 96 / 25.4), innerHeight / (geometry.sheet.height * 96 / 25.4)) + ')';
    };
    fit();
    window.addEventListener('resize', fit);
  } else if (printing) {
    const style = document.createElement('style');
    style.textContent = '@page { size: ' + width + ' ' + height + '; margin: 0; }';
    document.head.append(style);
  }
  configureRenderedImages(edit ? { ...printPictures('preview'), pixelRatio: Math.min(window.devicePixelRatio || 1, 2) }
    : printPictures(printing ? 'export' : artwork ? 'preview' : 'check', geometry.output.resolution?.target));
  let renderError: unknown;
  const reactRoot = createRoot(root, { onUncaughtError: (error) => { renderError = error; } });
  flushSync(() => reactRoot.render(
    <div className="if-cover-sheet" style={{ width, height }}>
      <div className="if-cover-trim" style={{ left: cssMM(-geometry.sheet.x), top: cssMM(-geometry.sheet.y),
        width: cssMM(geometry.trim.width), height: cssMM(geometry.trim.height) }}>
        {layout && state && <CoverArtwork book={book} template={template} cover={state} geometry={geometry} interiorPages={interiorPages} />}
      </div>
    </div>,
  ));
  if (renderError) throw renderError;
  const sheet = root.firstElementChild as HTMLElement;
  const bounds = sheet.getBoundingClientRect();
  const mmPerPixel = geometry.sheet.width / bounds.width;
  const files = (parameters: Parameters, values: Values) => fileErrors(book, parameters, values, 'Cover')
    .map((found) => ({ ...found, cover: true as const, where: 'Cover' }));
  if (layout && state) {
    errors.push(...files(layout.parameters, state.params));
    const boxes = new Map<string, HTMLElement>();
    const elements = new Set<string>();
    for (const { kind, id, node, boxType } of declaredNodes(sheet)) {
      if (kind === 'element') {
        if (!Object.hasOwn(layout.elements, id) || elements.has(id)) throw new Error('Unknown or duplicate cover element ' + id + '.');
        elements.add(id);
      } else {
        if (!Object.hasOwn(layout.boxes, id) || boxes.has(id) || boxType !== 'photo') throw new Error('Unknown or duplicate cover photo box ' + id + '.');
        if (!node.clientWidth || !node.clientHeight) throw new Error('Cover photo box ' + id + ' has no area.');
        boxes.set(id, node);
      }
    }
    for (const [id, declared] of Object.entries(layout.boxes)) {
      const node = boxes.get(id);
      if (!node) errors.push(issue('Draw ' + declared.label + ' exactly once.', 'cover-box-count', id));
      const box = state.boxes[id];
      const photo = box?.photo && book.photos[box.photo];
      const unavailable = box?.photo ? printProblem(book.sources?.['photo:' + box.photo]) : undefined;
      if (unavailable) errors.push({
        ...issue(unavailable + '. The cover preview uses a cached image.', 'source-unavailable', id), source: box.photo,
      });
      if (box?.photo && !photo) errors.push({ ...issue(declared.label + ' uses an unavailable photo.', 'photo-missing', id), source: box.photo });
      else if (!box?.photo) warnings.push(issue(declared.label + ' is empty.', 'cover-box-empty', id));
      if (node) {
        const finding = photoResolutionIssue(node, geometry.output.resolution?.minimum, mmPerPixel, declared.label, box?.photo);
        if (finding) errors.push({ ...finding, cover: true, where: 'Cover', box: id });
      }
      errors.push(...files(declared.parameters, box?.params ?? {}).map((finding) => ({ ...finding, box: id })));
    }
    for (const [id, declared] of Object.entries(layout.elements)) {
      errors.push(...files(declared.parameters, state.elements[id]?.params ?? {}).map((finding) => ({ ...finding, element: id })));
    }
  }
  // Wait for asynchronous artwork before printing or giving an agent a proof.
  if (!edit) {
    const images = await settleRenderedImages();
    errors.push(...images.map(({ message, element }) => ({ ...issue(message, 'rendered-image-failed'), element })));
    const photos = decodable(sheet);
    const decoded = await settle(photos);
    for (const [index, result] of decoded.entries()) {
      if (result.status === 'rejected') errors.push(issue('A cover image could not be decoded.', 'photo-decode', ownerOf(pictureSource.get(photos[index]) ?? photos[index]).box));
    }
    errors.push(...currentPhotoRenderFailures().map(({ message, box }) => issue(message, 'photo-render-failed', box)));
    errors.push(...renderIssues().map((message) => issue(message, 'render-impure')));
    for (const font of fontFailures()) errors.push(issue('Could not load cover font ' + font + '.', 'font-load'));
    const fontUse = checkFonts(sheet);
    for (const { chars, family, owner } of fontUse.missing) errors.push({
      ...issue(family + ' has no glyphs for ' + [...chars].join(' ') + '.', 'font-coverage'), ...owner,
    });
    if (fontUse.stroked) errors.push({ ...issue('Stroked cover text prints as a Type 3 font.', 'text-stroked'), ...fontUse.stroked.owner });
  }
  if (edit) await settle(decodable(sheet));
  if (layout) {
    const fromBleed = (area: Rect) => ({ ...area, x: area.x - geometry.sheet.x, y: area.y - geometry.sheet.y });
    const regions = (Object.entries(geometry.regions) as [keyof typeof geometry.regions, Rect][]).map(([key, region]) => {
      const safe = geometry.safe[key];
      return { end: region.x + region.width - geometry.sheet.x, safe: fromBleed(safe ?? {
        x: region.x + region.width / 2, y: region.y + region.height / 2, width: 0, height: 0,
      }) };
    });
    warnings.push(...typographyIssues(sheet, geometry.sheet.width, geometry.output.minimumTextSize && toMillimeters(geometry.output.minimumTextSize),
      (x) => (regions.find(({ end }) => x < end) ?? regions.at(-1)!).safe, { cover: true, where: 'Cover' }, geometry.avoid.map(fromBleed)));
  }
  let inspection: ElementInspection | undefined;
  if (inspect && layout && state) {
    const nodes = (inspect.box ? findDeclared(sheet, { box: inspect.box }) : inspect.element ? findDeclared(sheet, { element: inspect.element })
      : declaredNodes(sheet)).filter(({ kind, id }) => Object.hasOwn(kind === 'box' ? layout.boxes : layout.elements, id));
    if ((inspect.box || inspect.element) && !nodes.length) throw new PreviewError('preview-target-not-found', 'The requested box or element is not drawn on the cover.');
    const items: ElementMeasurement[] = nodes.slice(inspect.offset, inspect.offset + inspect.limit).map(({ node, kind, id }) => {
      const box = kind === 'box';
      const parameters = (box ? layout.boxes[id] : layout.elements[id]).parameters;
      const prefix = (box ? 'boxes.' : 'elements.') + id + '.';
      return { cover: true, id, kind: box ? 'photo' : 'element', boundsMm: measuredBounds(node, sheet, { spreadWidth: geometry.sheet.width }),
        typography: typographyOf(node), upright: upright(node, sheet), editPaths: Object.keys(parameters).map((key) => prefix + key),
        ...(box && state.boxes[id]?.photo ? { source: state.boxes[id].photo } : {}) };
    });
    inspection = { cover: true, coordinateSpace: 'sheet-bleed-mm', items, total: nodes.length,
      nextOffset: inspect.offset + items.length < nodes.length ? inspect.offset + items.length : null };
  }
  if (artwork) coverArtworkPreview(root, sheet, cover, artwork, query);
  publish({ state: 'ready', template: info, pages: interiorPages, units: [], errors, warnings, flow: {}, anchors: [], cover,
    ...(inspection ? { inspection } : {}) });
}

export async function startRender(root: HTMLElement) {
  let info: TemplateInfo | undefined;
  // Profiling builds time each step of a render as imageflow.render.<step>, from the end of the previous step.
  let stepStart = performance.now();
  const step = (name: string) => {
    if (!import.meta.env.IMAGEFLOW_PROFILE) return;
    const now = performance.now();
    performance.measure('imageflow.render.' + name, { start: stepStart, end: now });
    stepStart = now;
  };
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
    const near = Array.isArray(event.data.spreads) && event.data.spreads.every((id: unknown) => typeof id === 'string') ? new Set<string>(event.data.spreads) : undefined;
    onScreen = { top: Number(top), bottom: Number(bottom), left: Number(left ?? 0), right: Number(right ?? innerWidth), spreads: near };
    const requested = { columns: Math.max(0, Math.min(8, Math.floor(Number(event.data.columns) || 0))) };
    if (requested.columns !== grid.columns) {
      grid = requested;
      setGrid?.(grid);
    }
    onScreenChange?.();
  });
  if (window.parent !== window) post({ type: 'viewport-request' });
  // The app shows a progress cursor while it waits for an update, here too, whatever cursor the template sets.
  window.addEventListener('message', (event) => {
    if (event.origin === editorURL.slice(0, -1) && event.data?.type === 'busy') document.documentElement.classList.toggle('if-busy', !!event.data.busy);
  });
  try {
    const response = await fetch(location.pathname + '/data');
    if (!response.ok) throw new Error('Could not load the project. Reload and try again.');
    const book: RenderProject = await response.json();
    step('data');
    document.title = book.project.title;
    const base = document.createElement('base');
    base.href = new URL('./', book.template.script).href;
    document.head.append(base);
    setTemplateAssets(book.template.assets);
    setTemplateFonts(book.template.fonts);
    setTemplateFiles(book.files);
    Object.assign(globalThis, { ImageFlowRuntime: runtime, ImageFlowReact: React, ImageFlowJSX: jsx });
    // Book check, export and artwork frames record impure calls from template code, including at module load.
    const guards = book.mode === 'edit' ? undefined : installPurityGuards(window as unknown as Record<string, unknown>,
      new URL(book.template.script, location.href).pathname, undefined, renderingImages);
    const [module] = await Promise.all([import(/* @vite-ignore */ book.template.script), loadStyles(book.template.css), laidOut()]);
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
    // A fork may take an ID of its own and name the template the book was made from as `basedOn` (API-003).
    if (template.id !== book.project.template.id && template.basedOn?.id !== book.project.template.id) {
      throw new DeclarationError('The template ID does not match project.json.', [{ path: 'id',
        message: 'The template declares ID ' + template.id + ', but project.json uses ' + book.project.template.id + '.' }]);
    }
    const format = resolveFormat(template.format);
    const query = new URLSearchParams(location.search);
    step('template');
    if (book.mode === 'edit') {
      const focus = () => post({ type: 'editor-focus', text: document.activeElement instanceof HTMLElement &&
        (document.activeElement.isContentEditable || document.activeElement.matches('textarea, input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="color"]):not([type="button"])')) });
      document.addEventListener('focusin', focus); document.addEventListener('focusout', focus); window.addEventListener('focus', focus);
      setTimeout(focus, 0);
    }
    if (book.mode === 'edit' && query.get('view') === 'editor') {
      renderEditor(root, book, template, query.get('spread') ?? '', query.has('editor') ? { editor: query.get('editor')! } : { element: query.get('element') ?? '' },
        query.has('readonly'), query.get('presentation') === 'inline' ? 'inline' : 'dialog', query.get('page') === 'left' ? 'left' : query.get('page') === 'right' ? 'right' : undefined);
      return;
    }
    if (book.mode === 'edit' && query.get('view') === 'layout-picker') {
      renderLayoutPicker(root, book, template, query.get('spread') ?? '', query.get('family') ?? '', query.has('readonly'),
        query.get('page') === 'right' ? 'right' : query.get('page') === 'left' ? 'left' : undefined);
      return;
    }
    // A book's exterior cover renders on its own.
    if (['cover', 'cover-check', 'cover-artwork'].includes(query.get('view') ?? '')) {
      const sequence = pageSequence(book.project.spreads.map((spread) => layoutFootprint(spread, template.spreads)), template.format);
      await renderPhysicalCover(root, book, template, info, sequence, query, () => (guards?.calls ?? []).map(({ api }) => impureMessage(api)));
      return;
    }
    const present = query.get('view') === 'present';
    const proof: ProofOptions | undefined = book.mode === 'export' && query.get('view') === 'proof'
      ? { perPage: Math.max(1, Math.min(24, Number(query.get('per')) || 1)), title: query.get('title') ?? '', date: query.get('date') ?? '' } : undefined;
    const proofScale = proof && proofLayoutFor(format, proof.perPage).layout.scale;
    const edit = book.mode === 'edit' && !present;
    const check = !edit && query.get('view') === 'check';
    const artwork = !edit && query.get('view') === 'artwork' ? parsePreviewRequest(JSON.parse(query.get('request') ?? 'null')) : undefined;
    const inspect = !edit && query.has('inspect') ? inspectionSchema.parse(JSON.parse(query.get('inspect')!)) : undefined;
    // The editor renders the whole book twice: as scrolling spreads and as sidebar thumbnails.
    const view: BookView = present ? 'present' : query.get('view') === 'thumbs' ? 'thumbs' : query.get('view') === 'layouts' ? 'layouts' : 'book';
    const lazy = edit && (view === 'book' || view === 'thumbs');
    const textEditor = edit && query.get('view') === 'inline-text';
    // Pictures drawn by <RenderedImage>: at the screen's resolution in the editor (smaller for thumbnails), cheaply
    // in the Book check, and at the format's target resolution for export (ADR 0006).
    const target = template.format.output.resolution?.target ?? 300;
    const startOf = (book: RenderProject) => book.project.spreads.find(({ id }) => id === query.get('spread'))?.id ?? book.project.spreads[0]?.id ?? '';
    // What each revision of the book needs before it renders: photo URLs for this view, and the picture settings.
    const prepare = (book: RenderProject) => {
      if (present) book.mode = 'export';
      if (edit && view !== 'book') {
        for (const photo of Object.values(book.photos)) photo.src = photo.src.replace(/\/photo\/([\w-]+)$/, '/thumb/$1');
      }
      if (present) for (const photo of Object.values(book.photos)) photo.src = photo.src.replace('/photo/', '/proof-photo/');
      // The proof's photos are never print sized: a photo box asks for the size it shows on the sheet (exportSource,
      // loadProofPhotos), and template code that uses a photo's src as it is gets one as wide as a whole spread there.
      if (proofScale) {
        book.proofScale = proofScale;
        const widest = format.trim.width * (format.facingPages ? 2 : 1);
        for (const photo of Object.values(book.photos)) {
          photo.src = presentationPhotoSource(photo.src.replace('/photo/', '/proof-photo/'), proofPhotoPixels(widest, proofScale), false);
        }
      }
      if (edit) book.view = frameView(view);
      // The proof draws pictures at the editor's pixel ratios, so the pictures it drew already serve (proof-sheet).
      configureRenderedImages(proofScale ? { mode: 'preview', pixelRatio: proofPixelRatio(proofScale), concurrency: 3,
        timeoutMs: pictureTimeoutMs.preview, previewCache: location.pathname + '/picture/', wallClock: true } : present ? { mode: 'preview', pixelRatio: window.devicePixelRatio || 1, concurrency: 3, timeoutMs: pictureTimeoutMs.preview,
        activeSpreads: new Set([startOf(book)]),
        // The editor's cached pictures: a map drawn in the book view shows in the presentation at once (vector
        // pictures are shared across pixel ratios).
        previewCache: location.pathname + '/picture/' } : edit ? { mode: 'preview', pixelRatio: view === 'book' ? Math.min(window.devicePixelRatio || 1, 2) : 0.5,
        concurrency: view === 'book' ? 2 : 1, timeoutMs: pictureTimeoutMs.preview,
        // A replacement of the book view or the thumbnails draws the pictures of the spreads on screen first, which the
        // editor names, and the others once it is ready (activateAllRenderedImages). Restoring every map of a long book
        // from the cache, which parses each one's SVG again, held each edit back by a second.
        activeSpreads: (view === 'book' || view === 'thumbs') && onScreen?.spreads ? new Set(onScreen.spreads) : undefined,
        previewCache: location.pathname + '/picture/' }
        : printPictures(check ? 'check' : artwork || inspect ? 'preview' : 'export', target));
      // The picture cache's scope for each template file, and the Inspector's layout previews, which show a stand-in
      // for a picture they would have to draw.
      configureRenderedImages({ pictureScopes: book.template.pictureScopes, templateHash: book.template.hash, standIns: edit && view === 'layouts' });
    };
    prepare(book);
    if (edit && view === 'layouts') {
      await renderLayouts(root, book, template, info, query.get('spread') ?? '',
        query.get('page') === 'right' ? 'right' : query.get('page') === 'left' ? 'left' : undefined);
      return;
    }
    const { spreads } = book.project;
    const sequence = pageSequence(spreads.map((spread) => layoutFootprint(spread, template.spreads)), template.format);
    const { chains, positions } = textAssignments(book, template);
    const presentationStart = startOf(book);
    const activeChains = [...chains];
    const visible = spreads.map((spread, i) => ({ spread, i })).filter(({ spread }) => !textEditor || spread.id === query.get('spread'));
    const where = spreads.map((spread, i) => {
      return pagesText(sequence.spreads[i].page) + ' · ' + (sheetLayoutLabel(template.spreads, spread) ?? spread.definition);
    });
    if (edit) root.classList.add('if-preview');
    const lookups = new Map<string, AnchorLookup>();
    const index = { ...bookIndex(book, template, sequence), lookups };
    step('index');

    let renderError: unknown;
    const layoutFailures = new Map<string, Failure>();
    const react = createRoot(root, { onUncaughtError: (error) => { renderError = error; } });
    flushSync(() => react.render(visible.map(({ spread, i }) => {
      const view = <SpreadView book={book} spread={spread} template={template} format={format} positions={positions}
        page={sequence.spreads[i].page} index={index} renderPhotos lazyPhotos={lazy || present || !!proof} />;
      return <div className="if-spread-container" data-span={sequence.spreads[i].span} data-spread={spread.id} data-layout={spread.definition} key={spread.id}>
        {edit ? view : <LayoutBoundary spread={spread.id} failures={layoutFailures}>{view}</LayoutBoundary>}
      </div>;
    })));
    step('react');
    if (renderError) throw renderError;
    if (layoutFailures.size) throw new LayoutRenderError(layoutFailures);
    if (textEditor) {
      await document.fonts.ready;
      const spread = visible[0]?.spread;
      const path = query.get('parameter') ?? '';
      const side = query.get('page') === 'left' ? 'left' : query.get('page') === 'right' ? 'right' : undefined;
      const state = scopeSpread(spread, side);
      const field = state && resolveEditPath(info!, state.definition, path, side);
      const nodes = [...root.querySelectorAll<HTMLElement>('[data-edit]')].filter((node) => node.dataset.edit === path && pageOf(node) === side);
      const node = nodes[Number(query.get('occurrence')) || 0];
      if (!spread || !node?.hasAttribute('data-inline-text') || field?.param.type !== 'string' || query.has('readonly') || textEditorOwner(info!, state?.definition ?? '', path)) {
        throw new Error('This text is not available for inline editing. Use its parameter control.');
      }
      inlineTextFrame(root, node, field.param, String(readEdit(book.project, spread, field)), post, editorURL.slice(0, -1));
      return;
    }
    if (proofScale) loadProofPhotos(root, proofScale);
    // A check or export is final only once every asynchronous picture is drawn or has failed; the editor shows
    // them as they arrive.
    const pictureFailures = present || lazy || (edit && view !== 'book') ? [] : await settleRenderedImages();
    // A replacement frame shows unchanged pictures from the cache at once, not a placeholder that redraws them.
    if ((edit && (view === 'thumbs' || view === 'book')) || present || proof) await settleRestoredImages();
    step('pictures');
    // Presentation waits for the visible crop's photos below. SVG photos elsewhere in the book use detached
    // decode proxies that Chromium may never resolve while the candidate frame is hidden.
    // The editor does not wait for drawn pictures restored from its cache, such as a map's shaded relief: their boxes
    // have their size already, and the browser decodes them as they come into view. Decoding every one of a long
    // book's large relief pictures held each edit back by a third of a second.
    // Lazy photos are the photo loader's, after the layout step.
    const images = present ? [] : decodable(root).filter((image) => !(edit && image.closest('.if-rendered-image')) && !(lazy && image.hasAttribute('data-src')));
    const decoded = await settle(images);
    step('decode');
    const message = (text: string): Issue => ({ message: text });
    const located = (spread: string, text: string): Issue => ({ message: text, spread, where: where[spreads.findIndex(({ id }) => id === spread)] });
    // A control the generated controls could hide for good is fine on a spread that also marks it as editable on
    // the page: the marked node is the way to show it again (placeControlWarnings).
    const rendered = [...root.querySelectorAll<HTMLElement>('.if-spread-container[data-spread]')].flatMap((container) => {
      const spread = spreads.find(({ id }) => id === container.dataset.spread);
      return spread ? shownLayoutStates(spread).map(({ page, state }) => ({ spread: spread.id, ...onPage(page), layout: state.definition,
        marked: new Set([...container.querySelectorAll<HTMLElement>('[data-edit]')].filter((node) => pageOf(node) === page)
          .flatMap((node) => node.dataset.edit!.split(' ').filter(Boolean))) })) : [];
    });
    const warnings: Issue[] = [
      ...placeControlWarnings(declaration, rendered).map(({ code, message: text, path, details, suggestion, spread, page }) =>
        ({ ...(spread ? located(spread, text) : message(text)), code, ...onPage(page), details: { ...details, path }, suggestion })),
      ...book.problems.map((text) => ({ ...message(text), code: 'project-input' })),
      ...(book.template.warnings ?? []).map((text) => ({ ...message(text), code: 'template-dependencies',
        suggestion: 'Run npm install in template/, then run the template dependency rebuild script.' })),
      ...parameterWarnings(template.parameters, book.project.params, 'Document').map((text) => ({ ...message(text), code: 'parameter-invalid',
        suggestion: 'Use set_parameter with scope document and an allowed value, or reset_parameter to remove the saved value.' })),
    ];
    // The template's own preview image is checked where the whole book is: the editor's book view, Book check and export.
    if (declared.data.preview && (!edit || view === 'book')) warnings.push(...await templatePreviewWarnings(declared.data.preview, chooseFormat(declared.data).format));
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
    // Declared sites the user has not allowed (yet): a picture that fails to load from them is waiting for permission,
    // not looking at an unreachable server. Only a failing picture reports them; a book that loads nothing from the
    // sites has nothing to wait for.
    const pendingSites = pendingNetwork(declared.data.network, book.network);
    const pictureIssues = (failures: RenderedImageFailure[]): Issue[] => failures.map((failed) => ({
      ...(failed.spread ? located(failed.spread, failed.message) : message(failed.message)), code: 'rendered-image-failed',
      ...(failed.element ? { element: failed.element } : {}), ...onPage(failed.page),
      details: { label: failed.label, timedOut: failed.timedOut ? 1 : 0, ...(pendingSites.length ? { networkPending: pendingSites.join(' ') } : {}) },
      suggestion: pictureFailureSuggestion(failed, { declared: declared.data.network, allowed: book.network,
        online: typeof navigator === 'undefined' ? undefined : navigator.onLine }) }));
    errors.push(...pictureIssues(pictureFailures));
    if (!present && !lazy && !(edit && view !== 'book')) for (const note of renderedImageNotes()) {
      warnings.push({ ...(note.spread ? located(note.spread, note.message) : message(note.message)), code: note.code,
        ...(note.element ? { element: note.element } : {}), ...onPage(note.page), details: { label: note.label, ...note.details },
        suggestion: note.code === 'rendered-image-raster'
          ? 'Return SVG from draw and declare output="vector" on the <RenderedImage>, or declare output="raster" if the picture is imagery such as a satellite photo.'
          : 'Draw the picture at target.width × target.pixelRatio by target.height × target.pixelRatio pixels.' });
    }
    const photoRenderIssues = (failures: PhotoRenderFailure[]): Issue[] => failures.map(({ spread, page, box, message: text }) => ({
      ...located(spread, 'Photo box ' + box + ': its render callback failed: ' + text), code: 'photo-render-failed', ...onPage(page), box,
      suggestion: 'Fix the PhotoBox render callback so it returns markup for every crop and parameter value.' }));
    for (const sheet of spreads) for (const { page, state: spread } of shownLayoutStates(sheet)) {
      const definition = template.spreads[spread.definition];
      if (!definition) continue;
      const scoped = [
        ...fileErrors(book, definition.parameters, spread.params, 'Layout'),
        ...Object.entries(definition.boxes).flatMap(([id, box]) =>
          fileErrors(book, box.parameters, spread.boxes[id]?.params ?? {}, box.label).map((finding) => ({ ...finding, box: id }))),
        ...Object.entries(definition.elements).flatMap(([id, element]) =>
          fileErrors(book, element.parameters, spread.elements[id]?.params ?? {}, element.label).map((finding) => ({ ...finding, element: id }))),
      ];
      errors.push(...scoped.map((finding) => ({ ...located(spread.id, finding.message), ...finding, ...onPage(page) })));
      for (const [box, declaration] of Object.entries(definition.boxes)) {
        const assignment = spread.boxes[box];
        const id = declaration.type === 'photo' ? assignment?.photo : assignment?.text;
        const kind = declaration.type === 'photo' ? 'photo' : 'markdown';
        const state = id ? book.sources?.[kind + ':' + id] : undefined;
        const unavailable = printProblem(state);
        if (unavailable) errors.push({
          ...located(spread.id, unavailable + '. Showing a cached preview; the original is required for print.'),
          code: 'source-unavailable', ...onPage(page), box, source: id || undefined,
          suggestion: state?.previewOnly ? 'Export a proof, or copy the photo into the book on a Mac that can read its original.'
            : state?.state === 'offline' ? 'Retry after opening the photo’s source app or reconnecting its server.' : 'Locate the original or retry after reconnecting its location.',
        });
        if (state?.reshaped) warnings.push({ ...located(spread.id, 'The photo changed its aspect ratio in its source after it was placed. Check how it is cropped.'),
          code: 'source-reshaped', ...onPage(page), box, source: id || undefined });
      }
    }
    for (const [i, result] of decoded.entries()) {
      if (result.status !== 'rejected') continue;
      const source = pictureSource.get(images[i]) ?? images[i];
      const { box, page } = ownerOf(source);
      const spread = source.closest<HTMLElement>('[data-spread]')?.dataset.spread;
      const state = spread ? spreads.find(({ id }) => id === spread) : undefined;
      const photo = state && box ? scopeState(state, page)?.boxes[box]?.photo : undefined;
      errors.push({ ...(spread ? located(spread, '') : {}), message: 'Could not decode photo ' + (images[i].alt || box) + '.',
        code: 'photo-decode-failed', box, ...onPage(page), source: photo,
        suggestion: 'Replace the original with a valid JPEG, PNG or WebP file, or assign another photo.' });
    }
    for (const { spread, page, anchor, found } of lookups.values()) {
      warnings.push(found ? {
        ...located(spread, found + ' spreads declare anchor ' + anchor + '; this spread uses the first.'), code: 'anchor-ambiguous', ...onPage(page),
        details: { anchor, declared: found },
        suggestion: 'Give each anchor a unique ID in the layouts\' anchors(), or list them with ctx.book.anchors(' + JSON.stringify(anchor) + ').',
      } : {
        ...located(spread, 'No spread declares anchor ' + anchor + '.'), code: 'anchor-missing', ...onPage(page), details: { anchor },
        suggestion: 'Insert a spread whose layout declares anchor ' + anchor + ', or change the referenced anchor ID.',
      });
    }
    for (const { id, spread, page, text, url, kept } of index.creditConflicts ?? []) {
      warnings.push({ ...located(spread, 'This spread declares credit ' + id + ' as ' + JSON.stringify(text) + (url ? ' (' + url + ')' : '') +
        ', but an earlier spread declares it as ' + JSON.stringify(kept.text) + (kept.url ? ' (' + kept.url + ')' : '') + '; the book prints the first.'),
        code: 'credit-conflict', ...onPage(page), details: { credit: id, text, kept: kept.text },
        suggestion: 'Give credits with different text or URLs their own IDs in the layouts\' credits().' });
    }
    // A credit the book uses must be printed somewhere: a page marks what it prints with data-credits. Only a render of
    // the whole book can tell.
    if (visible.length === spreads.length) {
      const printed = new Set([...root.querySelectorAll<HTMLElement>('[data-credits]')].flatMap((node) => (node.dataset.credits ?? '').split(/\s+/)));
      for (const credit of index.credits ?? []) {
        if (printed.has(credit.id)) continue;
        // Pages as runs, such as 2–5, 8.
        const runs = credit.pages.reduce<[number, number][]>((list, page) => {
          const last = list[list.length - 1];
          if (last && page === last[1] + 1) last[1] = page; else list.push([page, page]);
          return list;
        }, []).map(([first, last]) => first === last ? String(first) : first + '–' + last).join(', ');
        warnings.push({ ...located(credit.spreads[0], 'The book uses ' + credit.text + ' (' + (credit.pages.length > 1 ? 'pages ' : 'page ') +
          runs + '), but no page prints this credit.'), code: 'credit-unprinted',
          details: { credit: credit.id, text: credit.text, pages: credit.pages.join(' ') },
          suggestion: 'Add a spread whose layout prints the book\'s credits (ctx.book.credits, marked with data-credits), or remove what needs the credit.' });
      }
    }
    for (const family of fontFailures()) {
      errors.push({ ...message('Font ' + family + ' could not be loaded; text using it renders with a fallback font.'), code: 'font-load-failed',
        details: { family }, suggestion: 'Check the @font-face src path in the template CSS and that the font file exists inside template/.' });
    }
    step('findings');
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
    step('validate');
    for (const [source, chain] of activeChains) {
      const first = chain[0];
      if (book.texts[source] === undefined) {
        errors.push({ ...located(first.spread, 'Missing Markdown source ' + source + '.'), code: 'text-source-missing', ...onPage(first.page), box: first.box, source,
          suggestion: 'Restore ' + (book.project.texts[source] ? sourcePath(book.project.texts[source]) : 'the Markdown file') + ', or assign another text to box ' + first.box + '.' });
        continue;
      }
      const header = splitFrontmatter(book.texts[source]).error;
      if (header) {
        const path = book.project.texts[source] ? sourcePath(book.project.texts[source]) : source;
        warnings.push({ ...located(first.spread, 'The header of ' + path + ' cannot be read: ' + header.message + ' (line ' + header.line + ').'),
          code: 'text-frontmatter-invalid', ...onPage(first.page), box: first.box, source, details: { line: header.line, path },
          suggestion: 'Fix the YAML between the opening and closing --- lines of ' + path + '. Until then the layout shows it without its header fields.' });
      }
      // A box drawn over several rectangles flows through each in turn; `groups` tells the flow which belong together.
      let next = 0;
      const stages = chain.flatMap(({ spread, page, box }, index) => {
        const all = validated.get(spread)!.boxes, key = (page ? page + ':' : '') + box, together = aligned(all.get(key)!);
        let group = next++;
        return rectsOf(all, key).map((node) => { const stage = { node, group, index }; if (!together) group = next++; return stage; });
      });
      const boxes = stages.map(({ node }) => node);
      const path = book.project.texts[source] ? sourcePath(book.project.texts[source]) : source;
      // The box a text starts in decides its composition. A later box that names another is styled for a structure
      // the text does not have there.
      const named = (name?: string) => name ? 'composition ' + name : 'no composition';
      for (const other of chain) {
        if (other.composition === first.composition) continue;
        warnings.push({ ...located(other.spread, 'Text from ' + path + ' starts in a box with ' + named(first.composition) + ', but box ' + other.box + ' names ' + named(other.composition) + '. The text keeps the first.'),
          code: 'text-composition-mixed', ...onPage(other.page), box: other.box, source,
          details: { composition: first.composition ?? '', boxComposition: other.composition ?? '', path },
          suggestion: 'Use layouts whose boxes name the same composition for every part of the text, or start the text in the layout whose composition it should have.' });
      }
      let html: string;
      try { html = textHtml(template, book, source, first.composition, first.spread, first.page); } catch (error) {
        errors.push({ ...located(first.spread, 'Composition ' + first.composition + ' could not compose ' + path + ': ' + (error instanceof Error ? error.message : String(error))),
          code: 'text-composition-failed', ...onPage(first.page), box: first.box, source, details: { composition: first.composition ?? '', path },
          suggestion: 'Fix the composition ' + first.composition + ' in the template. Until then the text flows as plain Markdown.' });
        html = markdownToHtml(book.texts[source]);
      }
      const result = flow.run(html, boxes, 'columns', stages.map(({ group }) => group));
      // With alignHeads a rectangle can be too short for the room the opening head takes: it holds no text, and the flow
      // goes on in the next rectangle or box.
      result.results.forEach(({ bandBlocked }, i) => {
        if (!bandBlocked) return;
        const target = chain[stages[i].index];
        const rect = stages.slice(0, i).filter(({ index }) => index === stages[i].index).length + 1;
        warnings.push({ ...located(target.spread, 'Rectangle ' + rect + ' of box ' + target.box + ' is too short for the room the head that opens it takes, so it holds no text from ' + path + '.'),
          code: 'text-band-too-tall', ...onPage(target.page), box: target.box, source, details: { rect, path },
          suggestion: 'Make rectangle ' + rect + ' of box ' + target.box + ' taller than the opening head, shorten the head, or remove alignHeads.' });
      });
      const overflow = result.overflowText.trim();
      // A rectangle left empty by the room it reserves gives its text back to the queue: nothing is lost there.
      if (overflow || result.results.some(({ failed, unresolved, bandBlocked }) => failed || (unresolved && !bandBlocked))) {
        const last = chain.at(-1)!;
        errors.push({ ...located(last.spread, 'Text from ' + (book.project.texts[source] ? sourcePath(book.project.texts[source]) : source) + ' does not fit; add a spread that continues it.'),
          code: 'text-overflow', ...onPage(last.page), box: last.box, source,
          details: { overflowCharacters: overflow.length, boxes: chain.length, path: book.project.texts[source] ? sourcePath(book.project.texts[source]) : '' },
          suggestion: 'Insert a spread after ' + last.spread + ' with a markdown box and assign text ' + source +
            ' to it so the flow continues, or enlarge the boxes, reduce the text size or shorten the text.' });
      } else {
        // The text ends before its last boxes: they are assigned but print nothing, space the book could use.
        const used = chain.map((_, index) => stages.some((stage) => stage.index === index && !!stage.node.textContent?.trim()));
        const ends = used.lastIndexOf(true);
        chain.forEach((target, i) => {
          if (ends < 0 || i <= ends) return;
          const path = book.project.texts[source] ? sourcePath(book.project.texts[source]) : source;
          warnings.push({ ...located(target.spread, 'Text from ' + path + ' ends before box ' + target.box + ', which stays empty.'),
            code: 'text-box-unused', ...onPage(target.page), box: target.box, source,
            details: { part: i + 1, parts: chain.length, path },
            suggestion: 'Remove text ' + source + ' from box ' + target.box + ' on ' + target.spread +
              ' and use the space for something else, such as another layout for that page, or lengthen the text.' });
        });
      }
    }
    // Reported after text flow so impure calls made inside a composition are included alongside layout renders.
    for (const { api, spread, page } of guards?.calls ?? []) {
      errors.push({ ...(spread ? located(spread, impureMessage(api)) : message(impureMessage(api, false))), code: 'render-impure', ...onPage(page),
        details: { api }, suggestion: spread ? impureSuggestion : unlocatedImpureSuggestion });
    }
    step('flow');
    const minimum = template.format.output.minimumTextSize;
    for (const [spread, { sheet }] of present ? [] : validated) {
      const minimumMm = minimum && toMillimeters(minimum);
      const { trim, bleed, safe } = format;
      const pages = sheetPages(format);
      const fontUse = checkFonts(sheet);
      for (const { owner, family, chars } of fontUse.missing) {
        const shown = [...chars].slice(0, 12);
        warnings.push({ ...located(spread, 'The template’s font ' + family + ' cannot set ' + shown.join(' ') + (chars.size > shown.length ? ' …' : '') +
          '; these characters print in a system font.'), code: 'font-coverage', ...owner,
          details: { family, characters: [...chars].join('') },
          suggestion: 'Bundle a font that contains these characters (its @font-face in the template CSS), or leave them out of the text; fonts.settable() does that for text the template draws.' });
      }
      if (fontUse.stroked) {
        warnings.push({ ...located(spread, 'Stroked text (“' + fontUse.stroked.text + '”) prints as a Type 3 font, which PDF preflight rejects.'),
          code: 'text-stroked', ...fontUse.stroked.owner,
          suggestion: 'Draw an outline or halo as filled copies of the text shifted around it, or as a shadow, instead of an SVG stroke or -webkit-text-stroke.' });
      }
      warnings.push(...typographyIssues(sheet, format.spreadWidth, minimumMm, (x) => {
        const page = pages.find(({ trimX }) => x < trimX + trim.width) ?? pages.at(-1)!;
        return { x: page.trimX + page.safeLeft, y: bleed.top + safe.top,
          width: trim.width - page.safeLeft - page.safeRight, height: trim.height - safe.top - safe.bottom };
      }, located(spread, '')));
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
    step('text-checks');
    const sheets = [...validated.values()].map(({ sheet }) => sheet);
    let inspection: ElementInspection | undefined;
    if (inspect) {
      const index = spreads.findIndex(({ id }) => id === inspect.spread);
      if (index < 0) throw new PreviewError('preview-target-not-found', 'Spread ' + inspect.spread + ' does not exist in this book.');
      inspection = inspectElements(sheets[index], spreads[index], template, format, inspect);
    }
    if (edit) {
      const laidOut = [...validated].map(([spread, { sheet }]) => ({ spread, sheet }));
      setGrid = layoutBook(root, laidOut, view, format, grid);
    }
    step('layout');
    if (present) await renderPresentation(root, sheets, spreads, sequence, format, presentationStart, query.has('replacement'));
    else if (lazy) {
      const load = photoLoader(root, () => onScreen);
      let timer: ReturnType<typeof setTimeout> | undefined;
      onScreenChange = () => { timer ??= setTimeout(() => { timer = undefined; load(); }, 16); };
      // Wait for photos near the viewport so replacements show their artwork as soon as they swap in.
      await Promise.allSettled(load().map((img) => img.decode()));
    }
    else if (artwork && 'picker' in artwork.target) {
      if (book.fixture) throw new PreviewError('invalid-preview-request', 'Fixture artwork is only available as a labelled contact sheet.');
      const { frame, metadata } = await renderPickerArtwork(book, template, artwork.target, Math.min(artwork.maxEdge, pickerWidth));
      const sentinel = parseSentinel(query.get('sentinel'));
      frame.dataset.previewArtwork = query.get('sentinel') ?? '';
      if (sentinel) paintSentinel(sentinel, metadata.height);
      window.imageflowPreview = { state: 'ready', metadata };
    } else if (artwork) {
      const { frame, metadata } = renderArtwork(root, sheets, spreads, sequence, format, artwork, book.fixture);
      const sentinel = parseSentinel(query.get('sentinel'));
      frame.dataset.previewArtwork = query.get('sentinel') ?? '';
      if (sentinel) paintSentinel(sentinel, metadata.height);
      await settle(decodable(frame));
      window.imageflowPreview = { state: 'ready', metadata };
    } else if (proof) {
      makeProofPages(root, sheets, sequence, format, spreads, where, errors, proof);
      await Promise.allSettled([...document.querySelectorAll<HTMLElement>('.if-proof-page')].flatMap((page) => decodable(page)).map((img) => img.decode()));
    } else if (!check) {
      makePrintPages(root, sheets, sequence, format);
      await Promise.allSettled([...document.querySelectorAll<HTMLElement>('.if-print-page')].flatMap((page) => decodable(page)).map((img) => img.decode()));
    }
    const units: { side: PrintSide; spread: string; where: string }[] = sequence.spreads.flatMap(({ sides }, i) =>
      sides.map((side) => ({ side, spread: spreads[i].id, where: where[i] })));
    step('output');
    publish({
      state: 'ready', template: info, pages: sequence.count, units, errors, warnings,
      flow: Object.fromEntries(Object.entries(positions).map(([key, { meta: _meta, ...position }]) => [key, position])), anchors: index.anchors,
      ...(inspection ? { inspection } : {}),
    });
    // Then the pictures of the other spreads, out of sight (activeSpreads above).
    if (lazy) setTimeout(activateAllRenderedImages, 0);
    // The editor's book view does not wait for its pictures. It reports them to the live Book check as they start,
    // finish or fail, so a map that failed on the page is never missing from the check.
    if (edit && view === 'book' && window.parent !== window) {
      let queued = false;
      const report = () => {
        if (queued) return;
        queued = true;
        setTimeout(() => {
          queued = false;
          const { pending, failures } = renderedImageState();
          post({ type: 'pictures', pending, errors: [...pictureIssues(failures), ...photoRenderIssues(currentPhotoRenderFailures())] });
        }, 50);
      };
      watchRenderedImages(report);
      watchPhotoRenderFailures(report);
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
