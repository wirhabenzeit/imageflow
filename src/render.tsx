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
import { chooseFormat, runtime, setTemplateAssets, setTemplateFiles, SpreadView, templateInfo, templateSchema } from './template';
import type { FlowPosition, Template } from './template';
import { resolveEditPath } from './editing';
import { declaredInTemplate, layoutChoices } from './layouts';
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
function fileErrors(book: RenderProject, schema: Parameters, values: Values, scope: string) {
  return Object.entries(schema).flatMap(([id, param]) => {
    const value = values[id];
    if (param.type !== 'file' || typeof value !== 'string' || !value) return [];
    const where = scope + ' · ' + param.label + ': ';
    const path = book.project.files[value];
    const found = book.files[value];
    if (!path || !found) return [where + 'the assigned file is no longer in the project. Choose it again.'];
    if (found.problem) return [where + found.problem];
    if (!param.accept.includes(found.extension)) {
      return [where + found.name + ' is not a ' + param.accept.join(' or ') + ' file. Choose another file.'];
    }
    return [];
  });
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
  // State the current layout does not show stays with the spread for other layouts; only state that no layout of
  // the template declares is reported.
  const declared = declaredInTemplate(template.spreads);
  const undeclared = (scope: string, parameters: Parameters, values: Values) =>
    Object.fromEntries(Object.entries(values).filter(([id]) => Object.hasOwn(parameters, id) || !declared.param(scope, id)));
  warn(parameterWarnings(definition.parameters, undeclared('', definition.parameters, spread.params), 'Layout'));
  for (const [id, state] of Object.entries(spread.boxes)) {
    const box = Object.hasOwn(definition.boxes, id) ? definition.boxes[id] : undefined;
    const kind = state.photo ? 'photo' : state.text ? 'text' : undefined;
    if (kind && !declared.box(id, kind)) {
      warn(['Content saved for box ' + id + ' fits no box of this template.']);
      continue;
    }
    if (box && kind && (kind === 'photo') !== (box.type === 'photo')) continue;
    const parameters = box?.parameters ?? {};
    warn(parameterWarnings(parameters, undeclared('box ' + id, parameters, state.params), box?.label ?? 'Box ' + id));
  }
  for (const [id, state] of Object.entries(spread.elements)) {
    const element = Object.hasOwn(definition.elements, id) ? definition.elements[id] : undefined;
    if (!element && !declared.element(id)) {
      warn(['Settings saved for element ' + id + ' fit no element of this template.']);
      continue;
    }
    const parameters = element?.parameters ?? {};
    warn(parameterWarnings(parameters, undeclared('element ' + id, parameters, state.params), element?.label ?? id));
  }
  // Templates report problems with their input, such as a file they cannot parse, on the node concerned.
  warn([...sheet.querySelectorAll<HTMLElement>('[data-issue]')].map((node) => node.dataset.issue!).filter(Boolean));
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
  // A preview is the spread itself in another layout: switching only changes which of its content is shown.
  const previews = layoutChoices(template.spreads, spreads[index].definition).map((definition) => ({
    definition, span: template.spreads[definition].span, spread: { ...spreads[index], definition, id: definition },
  }));
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

    let renderError: unknown;
    const react = createRoot(root, { onUncaughtError: (error) => { renderError = error; } });
    flushSync(() => react.render(visible.map(({ spread, i }) => (
      <div className="if-spread-container" data-span={sequence.spreads[i].span} data-spread={spread.id} key={spread.id}>
        <SpreadView book={book} spread={spread} template={template} format={format} positions={positions}
          page={sequence.spreads[i].page} renderPhotos lazyPhotos={lazy} />
      </div>
    ))));
    if (renderError) throw renderError;
    const images = [...root.querySelectorAll<HTMLImageElement>('img[src]')];
    const decoded = await settle(images);
    const message = (text: string): Issue => ({ message: text });
    const located = (spread: string, text: string): Issue => ({ message: text, spread, where: where[spreads.findIndex(({ id }) => id === spread)] });
    const warnings = [...book.problems, ...parameterWarnings(template.parameters, book.project.params, 'Document')].map(message);
    const errors = sequence.issues.map(message);
    // The preview falls back to the default format, but printing at a size nobody chose is blocked.
    if (template.unknownChoice) {
      errors.push(message('The template no longer offers the format ' + book.project.format + ' saved with this book. The preview uses ' +
        template.format.label + '; choose a format in Book settings.'));
    }
    errors.push(...fileErrors(book, template.parameters, book.project.params, 'Document').map(message));
    for (const spread of spreads) {
      const definition = template.spreads[spread.definition];
      if (!definition) continue;
      const scoped = [
        ...fileErrors(book, definition.parameters, spread.params, 'Layout'),
        ...Object.entries(definition.boxes).flatMap(([id, box]) => fileErrors(book, box.parameters, spread.boxes[id]?.params ?? {}, box.label)),
        ...Object.entries(definition.elements).flatMap(([id, element]) =>
          fileErrors(book, element.parameters, spread.elements[id]?.params ?? {}, element.label)),
      ];
      errors.push(...scoped.map((text) => located(spread.id, text)));
    }
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
    if (lazy) {
      const load = photoLoader(root, () => onScreen);
      let timer: ReturnType<typeof setTimeout> | undefined;
      onScreenChange = () => { timer ??= setTimeout(() => { timer = undefined; load(); }, 16); };
      // Report ready once the photos on screen are decoded, so swapping in this frame shows them.
      await Promise.allSettled(load().map((img) => img.decode()));
    }
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
