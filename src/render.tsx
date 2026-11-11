import React from 'react';
import * as jsx from 'react/jsx-runtime';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { editorURL } from './desktop';
import { bookLayout } from './desktop';
import type { BookGeometry, BookView, Issue, Rect, RenderStatus, TemplateInfo } from './desktop';
import { cssMM, pageSequence, resolveFormat, toMillimeters } from './format';
import type { PrintSide, ResolvedFormat } from './format';
import { parseDocument } from './project';
import type { RenderProject, SpreadState, Values } from './project';
import { markdownToHtml } from './markdown';
import { parameterWarnings, resolveParams } from './parameters';
import type { Parameters } from './parameters';
import { flow } from './text-flow';
import { bookIndex, chooseFormat, runtime, setTemplateAssets, setTemplateFiles, SpreadView, templateInfo, templateIssueSchema, templateSchema } from './template';
import type { AnchorLookup } from './template';
import type { FlowPosition, Template } from './template';
import { resolveEditPath } from './editing';
import { declaredInTemplate, layoutChoices } from './layouts';
import { parsePreviewRequest, PreviewError } from './preview';
import type { PreviewMetadata, PagePreviewMetadata } from './preview';
import { inspectionSchema } from './inspection';
import type { ElementInspection, ElementMeasurement } from './inspection';
import { contactSheetLayout } from './authoring-artwork';
import './render.css';

const post = (data: unknown) => window.parent.postMessage(data, editorURL.slice(0, -1));
function publish(status: RenderStatus) {
  window.imageflowRenderStatus = status;
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
    const title = book.project.texts[source]?.split('/').pop();
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
      const x = (rect.left - bounds.left) * mmPerPixel - bleed.outside;
      const y = (rect.top - bounds.top) * mmPerPixel - bleed.top;
      const w = rect.width * mmPerPixel;
      const h = rect.height * mmPerPixel;
      const right = x + w / 2 >= trim.width;
      const leftSafe = right ? trim.width + safe.binding : safe.outside;
      const rightSafe = right ? trim.width * 2 - safe.outside : trim.width - safe.binding;
      const overshootMm = Math.max(leftSafe - x, x + w - rightSafe, safe.top - y, y + h - (trim.height - safe.bottom));
      if (overshootMm > .2 && (!outside || overshootMm > outside.overshootMm)) outside = { overshootMm, owner: ownerOf(parent) };
    }
  }
  return { small, outside };
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

// Stacks every sheet in a column, scaled to the frame width, and reports where sheets and boxes landed.
function layoutBook(root: HTMLElement, sheets: { spread: string; sheet: HTMLElement }[], view: BookView) {
  const { pad, gap, columns = 1, columnGap = 0 } = bookLayout[view];
  root.style.setProperty('--if-pad', pad + 'px');
  root.style.setProperty('--if-gap', gap + 'px');
  root.style.setProperty('--if-columns', String(columns));
  root.style.setProperty('--if-column-gap', columnGap + 'px');
  const relative = (node: Element): Rect => {
    const { x, y, width, height } = node.getBoundingClientRect();
    return { x: x + scrollX, y: y + scrollY, width, height };
  };
  let width = -1;
  function fit() {
    if (root.clientWidth === width) return;
    width = root.clientWidth;
    for (const { sheet } of sheets) {
      const column = (width - pad * 2 - columnGap * (columns - 1)) / columns;
      const scale = Math.max(0.01, Math.min(column / sheet.offsetWidth, 1));
      const slot = sheet.parentElement!;
      slot.style.width = sheet.offsetWidth * scale + 'px';
      slot.style.height = sheet.offsetHeight * scale + 'px';
      sheet.style.setProperty('--if-zoom', String(scale));
    }
    const geometry: BookGeometry = {
      type: 'geometry', height: Math.ceil(root.getBoundingClientRect().height),
      sheets: sheets.map(({ spread, sheet }) => ({ spread, ...relative(sheet) })),
      boxes: sheets.flatMap(({ spread, sheet }) => {
        const scale = Number(sheet.style.getPropertyValue('--if-zoom')) || 1;
        return [...sheet.querySelectorAll<HTMLElement>('[data-box], [data-element]')].map((box) => {
          const rect = relative(box);
          const sized = Math.abs(rect.width - box.offsetWidth * scale) < 1.5 && Math.abs(rect.height - box.offsetHeight * scale) < 1.5;
          return {
            spread, id: (box.dataset.box ?? box.dataset.element)!, upright: sized && upright(box, sheet),
            type: (box.dataset.boxType ?? 'element') as BookGeometry['boxes'][number]['type'], ...rect,
          };
        });
      }),
      targets: sheets.flatMap(({ spread, sheet }) => [...sheet.querySelectorAll<HTMLElement>('[data-edit]')].map((node) => ({
        spread, edits: node.dataset.edit!.split(' ').filter(Boolean), ...relative(node),
      }))),
    };
    post(geometry);
  }
  root.classList.add('if-book', 'if-view-' + view);
  fit();
  new ResizeObserver(fit).observe(root);
}

// Both PDF pages and artwork captures start from a fully flowed sheet and use the same bleed offsets.
function sheetCrop(format: ResolvedFormat, side: PrintSide, bounds: PreviewMetadata['bounds']) {
  const { trim, bleed, pageWidth, spreadWidth, height } = format;
  const widthMm = side === 'spread' ? spreadWidth : pageWidth;
  const rightOffset = trim.width + bleed.outside;
  if (bounds === 'bleed') return { x: side === 'right' ? rightOffset - bleed.binding : 0, y: 0, widthMm, heightMm: height };
  return {
    x: side === 'right' ? rightOffset : bleed.outside, y: bleed.top,
    widthMm: trim.width * (side === 'spread' ? 2 : 1), heightMm: trim.height,
  };
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

function artworkTarget(spreads: SpreadState[], sequence: ReturnType<typeof pageSequence>, target: Exclude<ReturnType<typeof parsePreviewRequest>['target'], { spreads: string[] }>) {
  if ('page' in target) {
    const index = sequence.spreads.findIndex(({ page }) => page.left === target.page || page.right === target.page);
    if (index < 0) throw new PreviewError('preview-target-not-found', 'Page ' + target.page + ' does not exist in this book.');
    const side = sequence.spreads[index].page.left === target.page ? 'left' : 'right';
    return { index, side, page: { [side]: target.page }, spread: spreads[index].id } as const;
  }
  const index = spreads.findIndex(({ id }) => id === target.spread);
  if (index < 0) throw new PreviewError('preview-target-not-found', 'Spread ' + target.spread + ' does not exist in this book.');
  const { span, page } = sequence.spreads[index];
  const side = ('side' in target ? target.side : undefined) ?? span;
  if (side === 'spread') return { index, side, page, spread: target.spread };
  const number = page[side];
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

function renderArtwork(root: HTMLElement, sheets: HTMLElement[], spreads: SpreadState[], sequence: ReturnType<typeof pageSequence>,
  format: ResolvedFormat, artwork: ReturnType<typeof parsePreviewRequest>) {
  const { bounds, maxEdge } = artwork;
  if ('spreads' in artwork.target) {
    const targets = artwork.target.spreads.map((spread) => artworkTarget(spreads, sequence, { spread }));
    const crops = targets.map(({ side }) => sheetCrop(format, side, bounds));
    const grid = contactSheetLayout(crops, maxEdge, artwork.target.columns);
    const frame = document.createElement('div');
    frame.className = 'if-artwork';
    Object.assign(frame.style, { width: grid.width + 'px', height: grid.height + 'px', background: '#e9e9e9', overflow: 'hidden' });
    const cells = targets.map(({ index, spread, side, page }, i) => {
      const { x, y, width, height, label: labelRect } = grid.cells[i], crop = crops[i];
      const image = croppedSheet(sheets[index], crop, { width, height });
      Object.assign(image.style, { position: 'absolute', left: x + 'px', top: y + 'px' });
      const label = spread + ' · ' + Object.values(page).join('–');
      const caption = document.createElement('div');
      caption.textContent = label;
      Object.assign(caption.style, { position: 'absolute', left: labelRect.x + 'px', top: labelRect.y + 'px',
        width: labelRect.width + 'px', height: labelRect.height + 'px', font: '11px/16px sans-serif', color: '#111',
        overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', textAlign: 'center' });
      frame.append(image, caption);
      return { x, y, width, height, widthMm: crop.widthMm, heightMm: crop.heightMm, spread, side, page, bounds, label };
    });
    root.hidden = true;
    document.body.append(frame);
    return { frame, metadata: { kind: 'contact-sheet', width: grid.width, height: grid.height, bounds, columns: grid.columns, cells } as PreviewMetadata };
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
  const { widthMm, heightMm } = crop, scale = maxEdge / Math.max(widthMm, heightMm);
  const width = Math.max(1, Math.round(widthMm * scale)), height = Math.max(1, Math.round(heightMm * scale));
  const frame = croppedSheet(sheets[index], crop, { width, height });
  root.hidden = true;
  document.body.append(frame);
  return { frame, metadata: { width, height, widthMm, heightMm, bounds, spread, side, page, ...(detail ? { detail } : {}) } as PreviewMetadata };
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
  const previews = layoutChoices(template.spreads, spreads[index].definition).map((definition) => ({
    definition, span: template.spreads[definition].span, spread: { ...spreads[index], definition, id: definition },
  }));
  // Previews read the anchors of the book as saved, so a contents layout shows the real pages.
  const anchors = bookIndex(book, template, sequence);
  root.className = 'if-preview';
  let renderError: unknown;
  const react = createRoot(root, { onUncaughtError: (error) => { renderError = error; } });
  flushSync(() => react.render(previews.map(({ definition, span, spread }) => (
    <div className="if-spread-container" data-span={span} data-spread={definition} key={definition}>
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
  layoutBook(root, sheets, 'layouts');
  publish({ state: 'ready', template: info, pages: sequence.count, units: [], errors: [], warnings: [], flow: {}, anchors: anchors.anchors });
}

// Loads the photos of spreads within a screen of the visible range and unloads those more than three screens
// away, so memory and the work per edit follow what is on screen rather than the length of the book.
function photoLoader(root: HTMLElement, visible: () => { top: number; bottom: number } | undefined) {
  const containers = [...root.querySelectorAll<HTMLElement>('.if-spread-container')];
  return () => {
    const range = visible() ?? { top: 0, bottom: screen.height };
    const height = Math.max(1, range.bottom - range.top);
    const loading: HTMLImageElement[] = [];
    for (const container of containers) {
      const { top, bottom } = container.getBoundingClientRect();
      const near = bottom > range.top - height && top < range.bottom + height;
      const far = bottom < range.top - 3 * height || top > range.bottom + 3 * height;
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

// Runs a template-supplied element editor. The component edits a draft of the editor's parameters; the frame
// reports the draft, its height, and commit or cancel to the app, which validates and saves. The frame never
// changes project data itself.
function renderEditor(root: HTMLElement, book: RenderProject, template: Template, spreadId: string, elementId: string, readOnly: boolean) {
  const spread = book.project.spreads.find(({ id }) => id === spreadId);
  const element = spread && template.spreads[spread.definition]?.elements[elementId];
  const editor = element?.editor;
  if (!spread || !element || !editor) throw new Error('This element has no editor.');
  const saved = resolveParams(element.parameters, spread.elements[elementId]?.params ?? {});
  const document = resolveParams(template.parameters, book.project.params);
  const format = resolveFormat(template.format);
  const claimed = (values: Values) => Object.fromEntries(editor.parameters.map((key) => [key, values[key]]));
  root.className = 'if-editor';

  // The draft lives outside React so set() followed directly by commit() sends the newest values, before React
  // has rendered them. Every message is posted in order, and commit carries the draft as well.
  let draft: Values = saved;
  let changed = false;
  let failed = false;
  const fail = (error: unknown) => {
    if (failed) return;
    failed = true;
    const reason = error instanceof Error ? error.message : String(error);
    post({ state: 'error', message: 'The editor stopped working: ' + reason });
  };
  const commit = () => { if (!failed) post({ type: 'editor-commit', values: changed ? claimed(draft) : {} }); };
  const cancel = () => post({ type: 'editor-cancel' });
  let update: ((values: Values) => void) | undefined;
  const set = (changes: Values) => {
    if (readOnly || failed) return;
    const allowed = Object.entries(changes).filter(([key]) => editor.parameters.includes(key));
    if (!allowed.length) return;
    draft = { ...draft, ...Object.fromEntries(allowed) };
    changed = true;
    post({ type: 'editor-draft', values: claimed(draft) });
    update?.(draft);
  };

  function Host() {
    const [values, setValues] = React.useState<Values>(draft);
    React.useEffect(() => {
      update = setValues;
      // Effects run only once the component has mounted without throwing.
      post({ type: 'editor-ready' });
      return () => { update = undefined; };
    }, []);
    return React.createElement(editor!.component, { values, set, document, format, readOnly, commit, cancel });
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
  new ResizeObserver(() => post({ type: 'editor-size', height: Math.ceil(root.getBoundingClientRect().height) })).observe(root);
  const react = createRoot(root, { onUncaughtError: fail, onCaughtError: fail });
  flushSync(() => react.render(React.createElement(Host)));
}

export async function startRender(root: HTMLElement) {
  let info: TemplateInfo | undefined;
  // The editor reports which part of the book frame is on screen. Listen before anything slow happens and ask
  // once, because the editor's first report may otherwise arrive before this script runs.
  let onScreen: { top: number; bottom: number } | undefined;
  let onScreenChange: (() => void) | undefined;
  window.addEventListener('message', (event) => {
    if (event.origin !== editorURL.slice(0, -1) || event.data?.type !== 'viewport') return;
    onScreen = { top: Number(event.data.top), bottom: Number(event.data.bottom) };
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
    const [module] = await Promise.all([import(/* @vite-ignore */ book.template.script), loadStyles(book.template.css)]);
    // The project's format choice is resolved first; everything below works with that one format.
    const template = chooseFormat(parseDocument(templateSchema, module.default, 'Template'), book.project.format);
    info = templateInfo(template);
    if (template.id !== book.project.template.id) throw new Error('The template ID does not match project.json.');
    const format = resolveFormat(template.format);
    const query = new URLSearchParams(location.search);
    if (book.mode === 'edit' && query.get('view') === 'editor') {
      renderEditor(root, book, template, query.get('spread') ?? '', query.get('element') ?? '', query.has('readonly'));
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
    if (edit && view === 'layouts') {
      await renderLayouts(root, book, template, info, query.get('spread') ?? '');
      return;
    }
    const activeChains = [...chains];
    const visible = spreads.map((spread, i) => ({ spread, i }));
    const where = spreads.map((spread, i) => {
      const { left, right } = sequence.spreads[i].page;
      const pages = left && right ? 'Pages ' + left + '–' + right : 'Page ' + (left ?? right);
      return pages + ' · ' + (template.spreads[spread.definition]?.label ?? spread.definition);
    });
    if (edit) root.className = 'if-preview';
    const lookups = new Map<string, AnchorLookup>();
    const index = { ...bookIndex(book, template, sequence), lookups };

    let renderError: unknown;
    const react = createRoot(root, { onUncaughtError: (error) => { renderError = error; } });
    flushSync(() => react.render(visible.map(({ spread, i }) => (
      <div className="if-spread-container" data-span={sequence.spreads[i].span} data-spread={spread.id} key={spread.id}>
        <SpreadView book={book} spread={spread} template={template} format={format} positions={positions}
          page={sequence.spreads[i].page} index={index} renderPhotos lazyPhotos={lazy} />
      </div>
    ))));
    if (renderError) throw renderError;
    const images = [...root.querySelectorAll<HTMLImageElement>('img[src]')];
    const decoded = await settle(images);
    const message = (text: string): Issue => ({ message: text });
    const located = (spread: string, text: string): Issue => ({ message: text, spread, where: where[spreads.findIndex(({ id }) => id === spread)] });
    const warnings: Issue[] = [
      ...book.problems.map((text) => ({ ...message(text), code: 'project-input' })),
      ...parameterWarnings(template.parameters, book.project.params, 'Document').map((text) => ({ ...message(text), code: 'parameter-invalid',
        suggestion: 'Use set_parameter with scope document and an allowed value, or reset_parameter to restore the default.' })),
    ];
    const errors: Issue[] = sequence.issues.map((text) => ({ ...message(text), code: 'page-sequence',
      suggestion: 'Insert, remove or move spreads, or switch layouts, so the page sequence fits the format.' }));
    // The preview falls back to the default format, but printing at a size nobody chose is blocked.
    if (template.unknownChoice) {
      errors.push({ ...message('The template no longer offers the format ' + book.project.format + ' saved with this book. The preview uses ' +
        template.format.label + '; choose a format in Book settings.'), code: 'format-unavailable',
      details: { saved: book.project.format ?? '', used: template.format.label },
      suggestion: 'Use select_format with one of the template formats, or declare format ' + book.project.format + ' again in the template.' });
    }
    errors.push(...fileErrors(book, template.parameters, book.project.params, 'Document'));
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
    const layouts = new Map(visible.map(({ spread, i }, n) => [
      spread.id, validateSpread(containers[n], spread, template, format, where[i], warnings, errors),
    ]));
    for (const [source, chain] of activeChains) {
      const first = chain[0];
      if (book.texts[source] === undefined) {
        errors.push({ ...located(first.spread, 'Missing Markdown source ' + source + '.'), code: 'text-source-missing', box: first.box, source,
          suggestion: 'Restore ' + (book.project.texts[source] ?? 'the Markdown file') + ', or assign another text to box ' + first.box + '.' });
        continue;
      }
      const boxes = chain.map(({ spread, box }) => layouts.get(spread)!.boxes.get(box)!);
      const result = flow.run(markdownToHtml(book.texts[source]), boxes, 'columns');
      const overflow = result.overflowText.trim();
      if (overflow || result.results.some(({ failed, unresolved }) => failed || unresolved)) {
        const last = chain.at(-1)!;
        errors.push({ ...located(last.spread, 'Text from ' + (book.project.texts[source] ?? source) + ' does not fit; add a spread that continues it.'),
          code: 'text-overflow', box: last.box, source,
          details: { overflowCharacters: overflow.length, boxes: chain.length, path: book.project.texts[source] ?? '' },
          suggestion: 'Insert a spread after ' + last.spread + ' with a markdown box and assign text ' + source +
            ' to it so the flow continues, or enlarge the boxes, reduce the text size or shorten the text.' });
      }
    }
    const minimum = template.format.output.minimumTextSize;
    for (const [spread, { sheet }] of layouts) {
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
    }
    const sheets = [...layouts.values()].map(({ sheet }) => sheet);
    let inspection: ElementInspection | undefined;
    if (inspect) {
      const index = spreads.findIndex(({ id }) => id === inspect.spread);
      if (index < 0) throw new PreviewError('preview-target-not-found', 'Spread ' + inspect.spread + ' does not exist in this book.');
      inspection = inspectElements(sheets[index], spreads[index], template, format, inspect);
    }
    if (edit) layoutBook(root, [...layouts].map(([spread, { sheet }]) => ({ spread, sheet })), view);
    if (lazy) {
      const load = photoLoader(root, () => onScreen);
      let timer: ReturnType<typeof setTimeout> | undefined;
      onScreenChange = () => { timer ??= setTimeout(() => { timer = undefined; load(); }, 16); };
      // Report ready once the photos on screen are decoded, so swapping in this frame shows them.
      await Promise.allSettled(load().map((img) => img.decode()));
    }
    else if (artwork) {
      const { frame, metadata } = renderArtwork(root, sheets, spreads, sequence, format, artwork);
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
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The template could not be rendered.';
    if (error instanceof PreviewError) window.imageflowPreview = { state: 'error', code: error.code };
    root.hidden = true;
    publish({ state: 'error', message, template: info });
  }
}
