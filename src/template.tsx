import { createContext, useContext, useLayoutEffect, useRef } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { z } from 'zod';
import { cssMM, formatSchema, inch, mm, pt } from './format';
import type { PrintFormat, ResolvedFormat, Span } from './format';
import { identifier } from './project';
import type { Photo, RenderProject, SpreadState, Values } from './project';
import { centered, getCrop } from './spread';
import { p, parametersSchema, resolveParams } from './parameters';
import type { Parameters } from './parameters';
import type { BoxDefinition, SpreadDefinition, TemplateInfo } from './desktop';

export { inch, mm, p, pt };
export type { PrintFormat, ResolvedFormat, Span } from './format';
export type { Parameter, Parameters } from './parameters';

export type RenderContext = {
  params: Values;
  document: Values;
  boxes: Record<string, { params: Values; photo?: Photo | null; text?: FlowPosition | null }>;
  elements: Record<string, { params: Values }>;
  page: { left?: number; right?: number };
  format: ResolvedFormat;
  mode: RenderProject['mode'];
};

export type FlowPosition = { part: number; parts: number; title?: string };
const elements = z.record(identifier, z.object({ label: z.string().min(1), parameters: parametersSchema })).default({});
const box = z.object({
  type: z.enum(['photo', 'markdown']), label: z.string().min(1), parameters: parametersSchema, flowOrder: z.int().positive().optional(),
});

const definition = z.object({
  label: z.string().min(1),
  span: z.enum(['spread', 'left', 'right']).default('spread'),
  parameters: parametersSchema,
  boxes: z.record(identifier, box).default({}),
  elements,
  render: z.custom<(context: RenderContext) => ReactNode>((value) => typeof value === 'function', 'Expected a render function.'),
}).refine(({ boxes }) => {
  const order = Object.values(boxes).filter(({ type }) => type === 'markdown').map(({ flowOrder }) => flowOrder);
  return order.length < 2 || (!order.includes(undefined) && new Set(order).size === order.length);
}, 'Markdown boxes need unique flowOrder values.');

export const templateSchema = z.object({
  id: identifier,
  version: z.string().min(1),
  contract: z.literal(1),
  format: formatSchema,
  parameters: parametersSchema,
  spreads: z.record(identifier, definition).refine((spreads) => Object.keys(spreads).length > 0, 'Declare a spread.'),
});
export type Template = z.infer<typeof templateSchema>;
export type TemplateDeclaration = {
  id: string; version: string; contract: 1; format: PrintFormat; parameters?: Parameters;
  spreads: Record<string, Omit<SpreadDefinition, 'span' | 'parameters' | 'boxes' | 'elements'> & {
    span?: Span; parameters?: Parameters;
    boxes?: Record<string, Omit<BoxDefinition, 'parameters'> & { parameters?: Parameters }>;
    elements?: Record<string, { label: string; parameters?: Parameters }>;
    render(context: RenderContext): ReactNode;
  }>;
};
export const defineTemplate = <T extends TemplateDeclaration>(template: T) => template;

export function templateInfo(template: Template): TemplateInfo {
  return {
    format: template.format, version: template.version, parameters: template.parameters,
    spreads: Object.fromEntries(Object.entries(template.spreads).map(([id, { render: _render, ...info }]) => [id, info])),
  };
}

const SpreadData = createContext<{
  book: RenderProject; spread: SpreadState; format: ResolvedFormat; renderPhotos: boolean;
} | null>(null);

function useSpread() {
  const value = useContext(SpreadData);
  if (!value) throw new Error('Spread components must be rendered by ImageFlow.');
  return value;
}

type Styling = { className?: string; style?: CSSProperties };

export function Spread({ className, style, children }: Styling & { children?: ReactNode }) {
  const { format } = useSpread();
  const { trim, bleed, safe } = format;
  const geometry = {
    '--trim-width': cssMM(trim.width), '--trim-height': cssMM(trim.height),
    '--bleed-top': cssMM(bleed.top), '--bleed-bottom': cssMM(bleed.bottom), '--bleed-outside': cssMM(bleed.outside),
    '--safe-top': cssMM(safe.top), '--safe-bottom': cssMM(safe.bottom),
    '--safe-outside': cssMM(safe.outside), '--safe-binding': cssMM(safe.binding),
  } as CSSProperties;
  return (
    <div className="if-sheet" style={{ width: cssMM(format.spreadWidth), height: cssMM(format.height) }}>
      <div className={['if-spread', className].filter(Boolean).join(' ')} style={{ ...style, ...geometry }}>
        {children}
      </div>
    </div>
  );
}

// Pixel width the export needs for a photo drawn `cssWidth` CSS pixels wide (uncropped), capped at the format's
// maximum resolution. Rounded up to 16 px so nearby placements share a cached rendition.
const exportCap = 300;
function exportSource(photo: Photo & { src: string }, cssWidth: number, format: ResolvedFormat) {
  const ppi = format.resolution?.maximum ?? exportCap;
  const width = Math.ceil(cssWidth / 96 * ppi / 16) * 16;
  return width < photo.width ? photo.src + '/' + width : photo.src;
}

export function PhotoBox({ id, className, style }: Styling & { id: string }) {
  const { spread, book, format, renderPhotos } = useSpread();
  const box = spread.boxes[id];
  const photo = box?.photo ? book.photos[box.photo] : undefined;
  const placement = box?.crop ?? centered;
  const frame = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);

  useLayoutEffect(() => {
    const element = frame.current;
    const img = image.current;
    if (!element || !photo) return;
    function cropPhoto() {
      if (!element || !photo) return;
      const { width, height } = getComputedStyle(element);
      const w = parseFloat(width);
      const h = parseFloat(height);
      if (!(w > 0 && h > 0)) return;
      const crop = getCrop(photo, placement, w / h);
      element.dataset.ppi = String(Math.min(photo.width * crop.width / w, photo.height * crop.height / h) * 96);
      if (!img) return;
      if (book.mode !== 'edit' && !img.getAttribute('src')) img.src = exportSource(photo, w / crop.width, format);
      img.style.width = 100 / crop.width + '%';
      img.style.height = 100 / crop.height + '%';
      img.style.left = -100 * crop.x / crop.width + '%';
      img.style.top = -100 * crop.y / crop.height + '%';
    }
    const observer = new ResizeObserver(cropPhoto);
    cropPhoto();
    observer.observe(element);
    return () => observer.disconnect();
  }, [photo, placement, renderPhotos]);

  return (
    <div ref={frame} data-box={id} data-box-type="photo" data-empty={photo ? undefined : ''}
      className={['if-photo', className].filter(Boolean).join(' ')} style={style}>
      {photo && renderPhotos &&
        <img ref={image} src={book.mode === 'edit' ? photo.src : undefined} alt={photo.altText ?? photo.title ?? ''} />}
      {!photo && book.mode === 'edit' && <span className="if-placeholder">{box?.photo ? 'Missing photo' : 'Drop a photo'}</span>}
    </div>
  );
}

export function MarkdownBox({ id, className, style }: Styling & { id: string }) {
  const { spread, book } = useSpread();
  const text = spread.boxes[id]?.text;
  return (
    <div data-box={id} data-box-type="markdown" data-empty={text !== undefined && book.texts[text] !== undefined ? undefined : ''}
      className={['if-markdown', className].filter(Boolean).join(' ')} style={style}>
      {book.mode === 'edit' && (!text || book.texts[text] === undefined) &&
        <span className="if-placeholder">{text ? 'Missing Markdown' : 'Drop a Markdown file'}</span>}
    </div>
  );
}

export function Element({ id, className, style, children }: Styling & { id: string; children?: ReactNode }) {
  return <div data-element={id} className={className} style={style}>{children}</div>;
}

let assets: Record<string, string> = {};
export function setTemplateAssets(next: Record<string, string>) {
  assets = next;
}
export function asset(path: string) {
  const url = assets['assets/' + path];
  if (!url) throw new Error('Missing template asset: ' + path);
  return url;
}

// Returns an identity helper for spread declarations. It exists for TypeScript: `spread({...})` infers each
// spread's parameters, boxes, and elements, and types its render context with the given document parameters.
export const spreadFor = (_document: Parameters) => <T,>(definition: T) => definition;

export const runtime = { defineTemplate, spreadFor, p, mm, pt, inch, Spread, PhotoBox, MarkdownBox, Element, asset };

export function SpreadView({ book, template, format, spread, page, positions, renderPhotos }: {
  book: RenderProject; template: Template; format: ResolvedFormat; spread: SpreadState;
  page: RenderContext['page']; positions: Record<string, FlowPosition>; renderPhotos: boolean;
}) {
  const definition = template.spreads[spread.definition];
  if (!definition) throw new Error('Spread ' + spread.id + ' uses an unknown definition: ' + spread.definition + '.');
  const boxes = Object.fromEntries(Object.entries(definition.boxes).map(([id, box]) => {
    const assigned = spread.boxes[id];
    const params = resolveParams(box.parameters, assigned?.params ?? {});
    if (box.type === 'photo') {
      const photo = assigned?.photo ? book.photos[assigned.photo] : null;
      if (!photo) return [id, { params, photo: null }];
      const { src: _src, ...metadata } = photo;
      return [id, { params, photo: metadata }];
    }
    return [id, { params, text: positions[spread.id + ':' + id] ?? null }];
  }));
  const elements = Object.fromEntries(Object.entries(definition.elements).map(([id, element]) => [
    id, { params: resolveParams(element.parameters, spread.elements[id]?.params ?? {}) },
  ]));
  const content = definition.render({
    params: resolveParams(definition.parameters, spread.params),
    document: resolveParams(template.parameters, book.project.params),
    boxes, elements, page, format, mode: book.mode,
  });
  return <SpreadData.Provider value={{ book, spread, format, renderPhotos }}>{content}</SpreadData.Provider>;
}
