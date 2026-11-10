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
import type { RenderProject, SpreadState } from './project';
import { markdownToHtml } from './markdown';
import { parameterWarnings } from './parameters';
import { flow } from './text-flow';
import { runtime, setTemplateAssets, SpreadView, templateInfo, templateSchema } from './template';
import type { FlowPosition, Template } from './template';
import { resolveEditPath, switchDefinition } from './editing';
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

function validateSpread(container: HTMLElement, spread: SpreadState, template: Template, where: string, warnings: Issue[], errors: Issue[]) {
  const sheet = container.firstElementChild;
  if (!(sheet instanceof HTMLElement) || !sheet.matches('.if-sheet') || container.childElementCount !== 1) {
    throw new Error('Spread ' + spread.id + ' must render one <Spread> at its root.');
  }
  const definition = template.spreads[spread.definition];
  const remaining = new Set(Object.keys(definition.boxes));
  const elements = new Set(Object.keys(definition.elements));
  const bounds = sheet.getBoundingClientRect();
  const resolution = template.format.output.resolution;
  const issue = (message: string): Issue => ({ message, spread: spread.id, where });
  const warn = (messages: string[]) => warnings.push(...messages.map(issue));
  warn(parameterWarnings(definition.parameters, spread.params, 'Layout'));
  for (const [id, state] of Object.entries(spread.boxes)) {
    const box = definition.boxes[id];
    if (!box || (state.photo && box.type !== 'photo') || (state.text && box.type !== 'markdown')) {
      warn(['Content saved for box ' + id + ' has no matching box in this layout.']);
      continue;
    }
    warn(parameterWarnings(box.parameters, state.params, box.label));
  }
  for (const [id, state] of Object.entries(spread.elements)) {
    warn(parameterWarnings(definition.elements[id]?.parameters ?? {}, state.params, definition.elements[id]?.label ?? id));
  }
  const unknown = new Set([...sheet.querySelectorAll<HTMLElement>('[data-edit]')]
    .flatMap((node) => node.dataset.edit!.split(' ').filter(Boolean))
    .filter((path) => !resolveEditPath(template, spread.definition, path)));
  if (unknown.size) warn(['The layout marks unknown parameters as editable: ' + [...unknown].join(', ') + '.']);
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
        errors.push(issue(definition.boxes[id].label + ' is missing photo ' + assignment.photo + '.'));
      }
      if (resolution && Number.isFinite(ppi) && ppi < resolution.minimum) {
        errors.push(issue(definition.boxes[id].label + ' is ' + Math.round(ppi) + ' ppi (minimum ' + resolution.minimum + ').'));
      }
    }
    const rect = box.getBoundingClientRect();
    if (rect.left < bounds.left - 1 || rect.top < bounds.top - 1 ||
        rect.right > bounds.right + 1 || rect.bottom > bounds.bottom + 1) {
      errors.push(issue((definition.boxes[id]?.label ?? definition.elements[id]?.label ?? id) + ' extends outside the bleed.'));
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
  let small = false;
  let outside = false;
  for (let node = text.nextNode(); node; node = text.nextNode()) {
    const parent = node.parentElement;
    if (!node.textContent?.trim() || !parent || parent.closest('.if-placeholder, svg')) continue;
    if (minimum && parseFloat(getComputedStyle(parent).fontSize) * mmPerPixel < minimum) small = true;
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
      if (x < leftSafe - .2 || x + w > rightSafe + .2 || y < safe.top - .2 || y + h > trim.height - safe.bottom + .2) outside = true;
    }
  }
  return { small, outside };
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
          const upright = Math.abs(rect.width - box.offsetWidth * scale) < 1.5 && Math.abs(rect.height - box.offsetHeight * scale) < 1.5;
          return {
            spread, id: (box.dataset.box ?? box.dataset.element)!, upright,
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

function makePrintPages(root: HTMLElement, sheets: HTMLElement[], sequence: ReturnType<typeof pageSequence>, format: ResolvedFormat) {
  const style = document.createElement('style');
  const { outputWidth, height, trim, bleed } = format;
  style.textContent = '@page { size: ' + cssMM(outputWidth) + ' ' + cssMM(height) + '; margin: 0; }';
  document.head.append(style);
  const pages = document.createDocumentFragment();
  for (const [index, sheet] of sheets.entries()) {
    for (const side of sequence.spreads[index].sides) {
      const offset = side === 'right' ? trim.width + bleed.outside - bleed.binding : 0;
      const page = document.createElement('div');
      page.className = 'if-print-page';
      page.style.width = cssMM(outputWidth);
      page.style.height = cssMM(height);
      const clone = sheet.cloneNode(true) as HTMLElement;
      clone.style.left = cssMM(-offset);
      page.append(clone);
      pages.append(page);
    }
  }
  root.hidden = true;
  document.body.append(pages);
}

// Waits for fonts and photos so measurements and text flow see final metrics.
async function settle(images: HTMLImageElement[]) {
  const [, decoded] = await Promise.all([
    Promise.all([...document.fonts].map((font) => font.load())),
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
  const previews = Object.entries(template.spreads).map(([definition, { span }]) => {
    const spread = structuredClone(spreads[index]);
    switchDefinition(spread, definition, info);
    return { definition, span, spread: { ...spread, id: definition } };
  });
  root.className = 'if-preview';
  let renderError: unknown;
  const react = createRoot(root, { onUncaughtError: (error) => { renderError = error; } });
  flushSync(() => react.render(previews.map(({ definition, span, spread }) => (
    <div className="if-spread-container" data-span={span} data-spread={definition} key={definition}>
      <SpreadView book={book} spread={spread} template={template} format={format} positions={{}}
        page={sequence.spreads[index].page} renderPhotos />
    </div>
  ))));
  if (renderError) throw renderError;
  await settle([...root.querySelectorAll('img')]);
  const containers = root.querySelectorAll<HTMLElement>('.if-spread-container');
  const sheets = previews.map(({ definition, spread }, n) => {
    const { sheet, boxes } = validateSpread(containers[n], spread, template, definition, [], []);
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
  publish({ state: 'ready', template: info, pages: sequence.count, units: [], errors: [], warnings: [], flow: {} });
}

export async function startRender(root: HTMLElement) {
  let info: TemplateInfo | undefined;
  try {
    const response = await fetch(location.pathname + '/data');
    if (!response.ok) throw new Error('Could not load the project. Reload and try again.');
    const book: RenderProject = await response.json();
    document.title = book.project.title;
    const base = document.createElement('base');
    base.href = new URL('./', book.template.script).href;
    document.head.append(base);
    setTemplateAssets(book.template.assets);
    Object.assign(globalThis, { ImageFlowRuntime: runtime, ImageFlowReact: React, ImageFlowJSX: jsx });
    const [module] = await Promise.all([import(/* @vite-ignore */ book.template.script), loadStyles(book.template.css)]);
    const template = parseDocument(templateSchema, module.default, 'Template');
    info = templateInfo(template);
    if (template.id !== book.project.template.id) throw new Error('The template ID does not match project.json.');
    const format = resolveFormat(template.format);
    const query = new URLSearchParams(location.search);
    const { spreads } = book.project;
    const sequence = pageSequence(spreads.map((spread) => template.spreads[spread.definition]?.span ?? 'spread'), template.format);
    const { chains, positions } = textAssignments(book, template);
    const edit = book.mode === 'edit';
    // The editor renders the whole book twice: as scrolling spreads and as sidebar thumbnails.
    const view: BookView = query.get('view') === 'thumbs' ? 'thumbs' : query.get('view') === 'layouts' ? 'layouts' : 'book';
    if (edit && view !== 'book') {
      for (const photo of Object.values(book.photos)) photo.src = photo.src.replace(/\/photo\/([\w-]+)$/, '/thumb/$1');
    }
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

    let renderError: unknown;
    const react = createRoot(root, { onUncaughtError: (error) => { renderError = error; } });
    flushSync(() => react.render(visible.map(({ spread, i }) => (
      <div className="if-spread-container" data-span={sequence.spreads[i].span} data-spread={spread.id} key={spread.id}>
        <SpreadView book={book} spread={spread} template={template} format={format} positions={positions}
          page={sequence.spreads[i].page} renderPhotos />
      </div>
    ))));
    if (renderError) throw renderError;
    const images = [...root.querySelectorAll('img')];
    const decoded = await settle(images);
    const message = (text: string): Issue => ({ message: text });
    const located = (spread: string, text: string): Issue => ({ message: text, spread, where: where[spreads.findIndex(({ id }) => id === spread)] });
    const warnings = [...book.problems, ...parameterWarnings(template.parameters, book.project.params, 'Document')].map(message);
    const errors = sequence.issues.map(message);
    for (const [i, result] of decoded.entries()) {
      if (result.status === 'rejected') errors.push(message('Could not decode photo ' + (images[i].alt || images[i].closest('[data-box]')?.getAttribute('data-box')) + '.'));
    }
    const containers = root.querySelectorAll<HTMLElement>('.if-spread-container');
    const layouts = new Map(visible.map(({ spread, i }, n) => [
      spread.id, validateSpread(containers[n], spread, template, where[i], warnings, errors),
    ]));
    for (const [source, chain] of activeChains) {
      const first = chain[0];
      if (book.texts[source] === undefined) {
        errors.push(located(first.spread, 'Missing Markdown source ' + source + '.'));
        continue;
      }
      const boxes = chain.map(({ spread, box }) => layouts.get(spread)!.boxes.get(box)!);
      const result = flow.run(markdownToHtml(book.texts[source]), boxes, 'columns');
      if (result.overflowText.trim() || result.results.some(({ failed, unresolved }) => failed || unresolved)) {
        const last = chain.at(-1)!;
        errors.push(located(last.spread, 'Text from ' + (book.project.texts[source] ?? source) + ' does not fit; add a spread that continues it.'));
      }
    }
    const minimum = template.format.output.minimumTextSize;
    for (const [spread, { sheet }] of layouts) {
      const typography = checkTypography(sheet, format, minimum && toMillimeters(minimum));
      if (typography.small) warnings.push(located(spread, 'Text is smaller than the format minimum.'));
      if (typography.outside) warnings.push(located(spread, 'Text extends outside the safe area.'));
    }
    const sheets = [...layouts.values()].map(({ sheet }) => sheet);
    if (edit) layoutBook(root, [...layouts].map(([spread, { sheet }]) => ({ spread, sheet })), view);
    else {
      makePrintPages(root, sheets, sequence, format);
      await Promise.allSettled([...document.querySelectorAll<HTMLImageElement>('.if-print-page img')].map((img) => img.decode()));
    }
    const units: { side: PrintSide; spread: string; where: string }[] = sequence.spreads.flatMap(({ sides }, i) =>
      sides.map((side) => ({ side, spread: spreads[i].id, where: where[i] })));
    publish({
      state: 'ready', template: info, pages: sequence.count, units, errors, warnings, flow: positions,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The template could not be rendered.';
    root.hidden = true;
    publish({ state: 'error', message, template: info });
  }
}
