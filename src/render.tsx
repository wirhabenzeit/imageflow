import React from 'react';
import * as jsx from 'react/jsx-runtime';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { editorURL } from './desktop';
import type { RenderStatus, TemplateInfo } from './desktop';
import { cssMM, pageSequence, resolveFormat, toMillimeters } from './format';
import type { PrintSide, ResolvedFormat } from './format';
import { parseDocument } from './project';
import type { RenderProject, SpreadState } from './project';
import { markdownToHtml } from './markdown';
import { parameterWarnings } from './parameters';
import { flow } from './text-flow';
import { runtime, setTemplateAssets, SpreadView, templateInfo, templateSchema } from './template';
import type { FlowPosition, Template } from './template';
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

function validateSpread(container: HTMLElement, spread: SpreadState, template: Template, warnings: string[], errors: string[]) {
  const sheet = container.firstElementChild;
  if (!(sheet instanceof HTMLElement) || !sheet.matches('.if-sheet') || container.childElementCount !== 1) {
    throw new Error('Spread ' + spread.id + ' must render one <Spread> at its root.');
  }
  const definition = template.spreads[spread.definition];
  const remaining = new Set(Object.keys(definition.boxes));
  const elements = new Set(Object.keys(definition.elements));
  const bounds = sheet.getBoundingClientRect();
  const location = 'Spread ' + spread.id;
  const resolution = template.format.output.resolution;
  warnings.push(...parameterWarnings(definition.parameters, spread.params, location));
  for (const [id, state] of Object.entries(spread.boxes)) {
    const box = definition.boxes[id];
    if (!box || (state.photo && box.type !== 'photo') || (state.text && box.type !== 'markdown')) {
      warnings.push(location + ' has an unmapped assignment for ' + id + '.');
      continue;
    }
    warnings.push(...parameterWarnings(box.parameters, state.params, location + ' · ' + box.label));
  }
  for (const [id, state] of Object.entries(spread.elements)) {
    warnings.push(...parameterWarnings(definition.elements[id]?.parameters ?? {}, state.params, location + ' · ' + id));
  }
  const boxes = new Map<string, HTMLElement>();
  for (const box of sheet.querySelectorAll<HTMLElement>('[data-box], [data-element]')) {
    const id = box.dataset.box ?? box.dataset.element!;
    if (box.dataset.element !== undefined) {
      if (!elements.delete(id)) throw new Error(location + ' renders an unknown or duplicate element: ' + id + '.');
    } else {
      if (!remaining.delete(id) || definition.boxes[id].type !== box.dataset.boxType) {
        throw new Error(location + ' renders an unknown, duplicate, or incompatible box: ' + id + '.');
      }
      if (!box.clientWidth || !box.clientHeight) throw new Error(location + ' · ' + id + ' has no area.');
      boxes.set(id, box);
      const assignment = spread.boxes[id];
      const ppi = Number(box.dataset.ppi);
      if (assignment?.photo && box.hasAttribute('data-empty')) {
        errors.push(location + ' · ' + definition.boxes[id].label + ' is missing photo ' + assignment.photo + '.');
      }
      if (resolution && Number.isFinite(ppi) && ppi < resolution.minimum) {
        errors.push(location + ' · ' + definition.boxes[id].label + ' is ' + Math.round(ppi) + ' ppi (minimum ' + resolution.minimum + ').');
      }
      if (resolution && ppi > resolution.maximum) {
        warnings.push(location + ' · ' + definition.boxes[id].label + ' is ' + Math.round(ppi) + ' ppi (target ' + resolution.target + ').');
      }
    }
    const rect = box.getBoundingClientRect();
    if (rect.left < bounds.left - 1 || rect.top < bounds.top - 1 ||
        rect.right > bounds.right + 1 || rect.bottom > bounds.bottom + 1) {
      errors.push(location + ' · ' + id + ' extends outside the bleed.');
    }
  }
  if (remaining.size) throw new Error(location + ' is missing boxes: ' + [...remaining].join(', ') + '.');
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

function previewSheet(sheet: HTMLElement, viewport: HTMLElement, span: string) {
  function fit() {
    const gutter = 36;
    const scale = Math.max(0.01, Math.min(
      (viewport.clientWidth - gutter) / sheet.offsetWidth,
      (viewport.clientHeight - gutter) / sheet.offsetHeight, 1,
    ));
    sheet.style.setProperty('--if-zoom', String(scale));
    const rect = (node: Element) => {
      const { x, y, width, height } = node.getBoundingClientRect();
      return { x, y, width, height };
    };
    post({
      type: 'geometry', sheet: rect(sheet), span,
      boxes: [...sheet.querySelectorAll<HTMLElement>('[data-box], [data-element]')].map((box) => ({
        id: box.dataset.box ?? box.dataset.element, type: box.dataset.boxType ?? 'element', ...rect(box),
      })),
    });
  }
  sheet.classList.add('if-fit');
  fit();
  new ResizeObserver(fit).observe(viewport);
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
    const index = Number(new URLSearchParams(location.search).get('spread') ?? '0');
    const { spreads } = book.project;
    if (!Number.isSafeInteger(index) || index < 0 || index >= spreads.length) throw new Error('Spread does not exist.');
    const sequence = pageSequence(spreads.map((spread) => template.spreads[spread.definition]?.span ?? 'spread'), template.format);
    const { chains, positions } = textAssignments(book, template);
    const edit = book.mode === 'edit';
    const selected = spreads[index].id;
    const activeChains = [...chains].filter(([, chain]) => !edit || chain.some(({ spread }) => spread === selected));
    const measured = new Set([selected, ...activeChains.flatMap(([, chain]) => chain.map(({ spread }) => spread))]);
    const visible = spreads.map((spread, i) => ({ spread, i })).filter(({ spread }) => !edit || measured.has(spread.id));
    if (edit) root.className = 'if-preview';

    let renderError: unknown;
    const react = createRoot(root, { onUncaughtError: (error) => { renderError = error; } });
    flushSync(() => react.render(visible.map(({ spread, i }) => (
      <div className={edit && i !== index ? 'if-spread-container if-measure' : 'if-spread-container'}
        data-span={sequence.spreads[i].span} key={spread.id}>
        <SpreadView book={book} spread={spread} template={template} format={format} positions={positions}
          page={sequence.spreads[i].page} renderPhotos={!edit || i === index} />
      </div>
    ))));
    if (renderError) throw renderError;
    const images = [...root.querySelectorAll('img')];
    const [_, decoded] = await Promise.all([
      Promise.all([...document.fonts].map((font) => font.load())),
      Promise.allSettled(images.map((img) => img.decode())),
    ]);
    await document.fonts.ready;
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const warnings = [...book.problems, ...parameterWarnings(template.parameters, book.project.params, 'Document')];
    const errors = [...sequence.issues];
    for (const [i, result] of decoded.entries()) {
      if (result.status === 'rejected') errors.push('Could not decode photo ' + (images[i].alt || images[i].closest('[data-box]')?.getAttribute('data-box')) + '.');
    }
    const containers = root.querySelectorAll<HTMLElement>('.if-spread-container');
    const layouts = new Map(visible.map(({ spread }, i) => [
      spread.id, validateSpread(containers[i], spread, template, warnings, errors),
    ]));
    for (const [source, chain] of activeChains) {
      const first = chain[0];
      if (book.texts[source] === undefined) {
        errors.push('Spread ' + first.spread + ' is missing Markdown source ' + source + '.');
        continue;
      }
      const boxes = chain.map(({ spread, box }) => layouts.get(spread)!.boxes.get(box)!);
      const result = flow.run(markdownToHtml(book.texts[source]), boxes, 'columns');
      if (result.overflowText.trim() || result.results.some(({ failed, unresolved }) => failed || unresolved)) {
        const last = chain.at(-1)!;
        errors.push('Unplaced Markdown in ' + source + ' after spread ' + last.spread + ' · ' + last.box + '.');
      }
    }
    const minimum = template.format.output.minimumTextSize;
    for (const [spread, { sheet }] of layouts) {
      const typography = checkTypography(sheet, format, minimum && toMillimeters(minimum));
      if (typography.small) warnings.push('Spread ' + spread + ' contains text smaller than the format minimum.');
      if (typography.outside) warnings.push('Spread ' + spread + ' contains text outside the safe area.');
    }
    const sheets = [...layouts.values()].map(({ sheet }) => sheet);
    if (edit) previewSheet(layouts.get(selected)!.sheet, root, sequence.spreads[index].span);
    else {
      makePrintPages(root, sheets, sequence, format);
      await Promise.allSettled([...document.querySelectorAll<HTMLImageElement>('.if-print-page img')].map((img) => img.decode()));
    }
    const units: { side: PrintSide; spread: string }[] = sequence.spreads.flatMap(({ sides }, i) =>
      sides.map((side) => ({ side, spread: spreads[i].id })));
    publish({
      state: 'ready', template: info, pages: sequence.count, units, errors, warnings, flow: positions,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The template could not be rendered.';
    root.hidden = true;
    publish({ state: 'error', message, template: info });
  }
}
