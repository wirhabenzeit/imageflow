// A MapLibre map as SVG, for print. MapLibre loads the style and tiles and places the labels off screen; the features
// it drew are then written out as SVG: fills and lines as paths in the style's colours and widths, labels as text that
// the page's own fonts set. A PDF gets paths and text instead of pixels, so a map is sharp at any zoom, small, and its
// labels match the book.
//
// Drawn: background, fill, fill-extrusion (flat), line (dashes, caps, joins, gap width) and symbol text, at points and
// along lines. Left out: icons (shields, POI symbols, arrows), patterns, raster and hillshade layers, line offsets and
// blur. Halos are filled copies of a label shifted around it, never a stroke: Chromium prints stroked text as a Type 3
// font, which print preflight rejects. The copies are <text> elements of their own, not <use>, so the page's CSS (such
// as a label font's class) styles them like the label.
//
// Only the base map is drawn here. What a book adds on top (tracks, its own markers and names, insets) belongs to the
// template, drawn with `projector` from the same view, so it stays as customisable as the rest of the page.
import type { Map as MapLibreMap, MapGeoJSONFeature, MapOptions, StyleSpecification } from 'maplibre-gl';

/** What the map shows: its centre and MapLibre zoom, and its size in CSS pixels (96 per inch). */
export type MapView = { longitude: number; latitude: number; zoom: number; width: number; height: number };
/** How a label is set: a class the page's CSS styles, or a family, weight and style written onto the text. */
export type LabelFont = { className?: string; family?: string; weight?: number; style?: 'normal' | 'italic' };
/** A style layer, for choosing which ones to draw. */
export type LayerInfo = { id: string; type: string; sourceLayer?: string };
export type SvgOptions = {
  /** The font of the labels in a MapLibre font stack, such as ['Noto Sans Italic']. Default: inherit the page's. */
  font?: (stack: string[]) => LabelFont;
  /** A label as the page's fonts can set it (see `fonts.settable` in ImageFlow); empty leaves it out. */
  text?: (label: string, stack: string[]) => string;
  /**
   * The colour to write for a paint property, given the colour the style evaluates to, as `rgba(…)`. Return it
   * unchanged, another colour, or a CSS value such as `var(--map-water, rgba(…))`: the SVG is part of the page, so the
   * page's CSS can then recolour the map, for a colour theme say, without drawing it again.
   */
  color?: (color: string, use: { layer: LayerInfo; property: string }) => string;
  /** Whether to draw a style layer; all by default. */
  layers?: (layer: LayerInfo) => boolean;
  /** Places, as [longitude, latitude], where the template draws its own markers: labels within `radius` CSS pixels are left out. */
  avoid?: { at: [number, number]; radius: number }[];
  /** A class for the <svg> element. */
  className?: string;
};
/** The MapLibre module, as `import('maplibre-gl')` gives it. */
export type MapLibreModule = { Map: new (options: MapOptions) => MapLibreMap };
export type DrawOptions = SvgOptions & {
  maplibre: MapLibreModule;
  style: string | StyleSpecification;
  view: MapView;
  /** Stops loading; the promise rejects. */
  signal?: AbortSignal;
};

// Web Mercator, as MapLibre uses it: x and y in 0–1 across the world, and 512 CSS pixels per world at zoom 0.
const mercator = (longitude: number, latitude: number): [number, number] => {
  const sin = Math.sin(Math.max(-85.05113, Math.min(85.05113, latitude)) * Math.PI / 180);
  return [(longitude + 180) / 360, .5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)];
};

/** Longitude and latitude to the view's CSS pixels, as the drawn map places them. Pure, so a layout can use it. */
export function projector(view: MapView) {
  const world = 512 * 2 ** view.zoom;
  const [cx, cy] = mercator(view.longitude, view.latitude);
  return ([longitude, latitude]: readonly number[]): [number, number] => {
    const [x, y] = mercator(longitude, latitude);
    return [(x - cx) * world + view.width / 2, (y - cy) * world + view.height / 2];
  };
}

/**
 * Loads `style` off screen at the view and draws it as SVG markup once every tile has loaded. A style or tile that
 * fails to load rejects, so a print never has holes in it.
 */
export async function drawMapSvg({ maplibre, style, view, signal, ...options }: DrawOptions): Promise<string> {
  signal?.throwIfAborted();
  const holder = document.createElement('div');
  holder.style.cssText = 'position:fixed;left:-20000px;top:0;width:' + view.width + 'px;height:' + view.height + 'px;';
  document.body.append(holder);
  // Only the features it places are read back, so it draws at one pixel per CSS pixel.
  const map = new maplibre.Map({ container: holder, style, center: [view.longitude, view.latitude], zoom: view.zoom,
    interactive: false, attributionControl: false, fadeDuration: 0, pixelRatio: 1 });
  let abort: (() => void) | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      abort = () => reject(signal?.reason ?? new Error('stopped'));
      signal?.addEventListener('abort', abort, { once: true });
      map.on('error', (event) => reject(new Error(event.error?.message ?? 'a map resource did not load')));
      map.once('idle', () => resolve());
    });
    return mapToSvg(map, view, options);
  } finally {
    if (abort) signal?.removeEventListener('abort', abort);
    map.remove();
    holder.remove();
  }
}

type Point = { x: number; y: number };
type TileFeature = { type: 1 | 2 | 3; extent: number; properties: Record<string, unknown>; id?: number | string; loadGeometry(): Point[][] };
type Feature = MapGeoJSONFeature & { _x: number; _y: number; _z: number; _vectorTileFeature: TileFeature };
// The evaluated paint and layout of a style layer: a property is a constant, or a value per feature.
type Possibly = { get(name: string): unknown };
type Layer = { id: string; type: string; paint: Possibly; layout: Possibly; isHidden(zoom: number): boolean };
type Color = { toString(): string; a: number };
type Line = [number, number][];

const round = (value: number) => Math.round(value * 10) / 10;
// A colour as an SVG paint attribute; a CSS value such as var() only works as a style property.
const plainColor = (color: string) => /^[#\w(][\w\s#.,%()-]*$/.test(color) && !/\bvar\(/.test(color);
const paintAttribute = (name: 'fill' | 'stroke', color: string) => plainColor(color)
  ? ' ' + name + '="' + color + '"' : ' style="' + name + ':' + escape(color) + '"';
// An area's fill, with a hairline of the same colour around it: where tiles cut an area, its parts meet edge to edge,
// and PDF viewers can show a seam there. Inside the layer's group, the overlap does not change the colour.
const areaPaint = (color: string) => plainColor(color) ? ' fill="' + color + '" stroke="' + color + '" stroke-width=".5" stroke-linejoin="round"'
  : ' style="fill:' + escape(color) + ';stroke:' + escape(color) + '" stroke-width=".5" stroke-linejoin="round"';
const escape = (text: string) => text.replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]!);

// A constant property, or its value for this feature.
function value<T>(property: unknown, feature: Feature | undefined): T {
  const possibly = property as { evaluate?: (feature: unknown, state: object) => T } | T;
  if (possibly && typeof possibly === 'object' && 'evaluate' in possibly && typeof possibly.evaluate === 'function') {
    const tile = feature?._vectorTileFeature;
    return possibly.evaluate({ type: tile?.type, id: feature?.id, properties: feature?.properties ?? {} }, {});
  }
  return possibly as T;
}
const color = (input: unknown) => {
  const parsed = input as Color | undefined;
  return parsed && parsed.a > 0 ? parsed.toString() : undefined;
};
// Data-driven paint is evaluated per feature; constants once per layer.
const constant = (property: unknown) => !(property && typeof property === 'object' && 'evaluate' in property && (property as { value?: { kind?: string } }).value?.kind !== 'constant');
const length = (line: Line) => line.reduce((sum, point, i) => i ? sum + Math.hypot(point[0] - line[i - 1][0], point[1] - line[i - 1][1]) : 0, 0);

/** Draws a MapLibre map that has finished loading (`idle`) as SVG markup of the view. */
export function mapToSvg(map: MapLibreMap, view: MapView, options: SvgOptions = {}) {
  const { width, height, zoom } = view;
  const world = 512 * 2 ** zoom;
  const [cx, cy] = mercator(view.longitude, view.latitude);
  // Tile coordinates to the view's CSS pixels.
  const project = (feature: Feature) => {
    const scale = 2 ** feature._z, extent = feature._vectorTileFeature.extent;
    return (point: Point): [number, number] => [
      ((feature._x + point.x / extent) / scale - cx) * world + width / 2,
      ((feature._y + point.y / extent) / scale - cy) * world + height / 2];
  };
  // Rings or lines in pixels, without points closer than a quarter pixel: tiles carry far more detail than print needs.
  const rings = (feature: Feature): Line[] => {
    const to = project(feature);
    return feature._vectorTileFeature.loadGeometry().map((ring) => {
      const out: Line = [];
      for (const point of ring) {
        const next = to(point), last = out[out.length - 1];
        if (!last || Math.abs(next[0] - last[0]) + Math.abs(next[1] - last[1]) > .25) out.push(next);
      }
      return out;
    });
  };
  // The outline of an area, for a line layer on polygons such as a coastline: without the edges where a tile cut the
  // area, at its edge or in the buffer around it. MapLibre hides those by drawing each tile only inside its square;
  // here every segment between two points that are not strictly inside the tile is left out, since the neighbouring
  // tile draws that stretch of the outline itself.
  const outlines = (feature: Feature): Line[] => {
    const to = project(feature), extent = feature._vectorTileFeature.extent;
    const inside = (point: Point) => point.x > 0 && point.y > 0 && point.x < extent && point.y < extent;
    const runs: Line[] = [];
    for (const ring of feature._vectorTileFeature.loadGeometry()) {
      let run: Line = [];
      for (let i = 0; i < ring.length; i++) {
        const point = ring[i], previous = ring[i - 1];
        if (previous && !inside(previous) && !inside(point)) {
          if (run.length > 1) runs.push(run);
          run = [];
        }
        const next = to(point), last = run[run.length - 1];
        if (!last || Math.abs(next[0] - last[0]) + Math.abs(next[1] - last[1]) > .25) run.push(next);
      }
      if (run.length > 1) runs.push(run);
    }
    return runs;
  };
  const margin = 50;
  const visible = (lines: Line[]) => lines.some((line) => line.some(([x, y]) => x > -margin && y > -margin && x < width + margin && y < height + margin));
  const pathOf = (lines: Line[], closed: boolean) => lines.filter((line) => line.length > (closed ? 2 : 1))
    .map((line) => 'M' + line.map(([x, y]) => round(x) + ' ' + round(y)).join('L') + (closed ? 'Z' : '')).join('');

  const style = map.getStyle();
  const features = new Map<string, Feature[]>();
  for (const feature of map.queryRenderedFeatures() as Feature[]) {
    if (!feature._vectorTileFeature?.loadGeometry) continue;
    const list = features.get(feature.layer.id);
    if (list) list.push(feature); else features.set(feature.layer.id, [feature]);
  }
  const place = projector(view);
  const avoided = (options.avoid ?? []).map(({ at, radius }) => ({ at: place(at), radius }));
  const labels = new Labels(options, width, height, avoided);

  const body: string[] = [];
  for (const spec of style.layers) {
    const layer = map.getLayer(spec.id) as unknown as Layer | undefined;
    if (!layer || layer.isHidden(zoom)) continue;
    if (options.layers && !options.layers({ id: spec.id, type: spec.type, ...('source-layer' in spec && spec['source-layer'] ? { sourceLayer: spec['source-layer'] } : {}) })) continue;
    const { paint, layout } = layer;
    const info: LayerInfo = { id: spec.id, type: spec.type, ...('source-layer' in spec && spec['source-layer'] ? { sourceLayer: spec['source-layer'] } : {}) };
    const recolour = (property: string, value: string) => options.color ? options.color(value, { layer: info, property }) : value;
    const declared = (spec as { paint?: Record<string, unknown>; layout?: Record<string, unknown> });
    if (layer.type === 'background') {
      const fill = color(paint.get('background-color'));
      if (fill && !('background-pattern' in (declared.paint ?? {}))) {
        const opacity = value<number>(paint.get('background-opacity'), undefined);
        body.push('<rect width="' + round(width) + '" height="' + round(height) + '"' + paintAttribute('fill', recolour('background-color', fill)) + (opacity < 1 ? ' opacity="' + opacity + '"' : '') + '/>');
      }
      continue;
    }
    // A symbol layer may label the features of another layer (metadata "maplibre-svg:features-of"): MapLibre places few
    // labels along winding lines such as contours, and only placed symbols are queryable, so the lines themselves are
    // labelled here, along their longest visible stretch.
    const borrowed = (spec as { metadata?: Record<string, unknown> }).metadata?.['maplibre-svg:features-of'];
    const list = layer.type === 'symbol' && typeof borrowed === 'string' ? features.get(borrowed) : features.get(spec.id);
    if (!list?.length) continue;
    if (layer.type === 'fill' || layer.type === 'fill-extrusion') {
      const prefix = layer.type === 'fill' ? 'fill' : 'fill-extrusion';
      if ('fill-pattern' in (declared.paint ?? {}) || 'fill-extrusion-pattern' in (declared.paint ?? {})) continue;
      const opacityProperty = paint.get(prefix + '-opacity');
      // Features overlap where tiles meet; one opacity on the whole layer keeps the overlaps invisible.
      const groupOpacity = constant(opacityProperty) ? value<number>(opacityProperty, undefined) : 1;
      const paths = new Map<string, string[]>();
      for (const feature of list) {
        const evaluated = color(value(paint.get(prefix + '-color'), feature));
        if (!evaluated) continue;
        const fill = recolour(prefix + '-color', evaluated);
        const opacity = constant(opacityProperty) ? 1 : value<number>(opacityProperty, feature);
        const lines = rings(feature);
        if (!visible(lines)) continue;
        const key = fill + '|' + opacity;
        const d = pathOf(lines, true);
        if (d) (paths.get(key) ?? paths.set(key, []).get(key)!).push(d);
      }
      if (!paths.size) continue;
      body.push('<g data-layer="' + escape(spec.id) + '"' + (groupOpacity < 1 ? ' opacity="' + groupOpacity + '"' : '') + '>' +
        [...paths].map(([key, d]) => {
          const [fill, opacity] = key.split('|');
          return '<path' + areaPaint(fill) + (opacity !== '1' ? ' fill-opacity="' + opacity + '" stroke-opacity="' + opacity + '"' : '') + ' d="' + d.join('') + '"/>';
        }).join('') + '</g>');
    } else if (layer.type === 'line') {
      if ('line-pattern' in (declared.paint ?? {})) continue;
      const opacityProperty = paint.get('line-opacity');
      const groupOpacity = constant(opacityProperty) ? value<number>(opacityProperty, undefined) : 1;
      const cap = value<string>(layout.get('line-cap'), undefined), join = value<string>(layout.get('line-join'), undefined);
      const paths = new Map<string, string[]>();
      for (const feature of list) {
        const evaluated = color(value(paint.get('line-color'), feature));
        const stroke = evaluated && recolour('line-color', evaluated);
        const lineWidth = value<number>(paint.get('line-width'), feature), gap = value<number>(paint.get('line-gap-width'), feature) || 0;
        if (!stroke || !(lineWidth > 0)) continue;
        // A gap width draws the line on both sides of a gap; drawing it whole is close enough under the line on top.
        const strokeWidth = gap > 0 ? gap + 2 * lineWidth : lineWidth;
        const dashes = value<number[] | undefined>(paint.get('line-dasharray'), feature);
        const opacity = constant(opacityProperty) ? 1 : value<number>(opacityProperty, feature);
        const lines = feature._vectorTileFeature.type === 3 ? outlines(feature) : rings(feature);
        if (!visible(lines)) continue;
        const key = [stroke, Math.round(strokeWidth * 100) / 100, dashes?.length ? dashes.map((dash) => round(dash * lineWidth)).join(' ') : '', opacity].join('|');
        const d = pathOf(lines, false);
        if (d) (paths.get(key) ?? paths.set(key, []).get(key)!).push(d);
      }
      if (!paths.size) continue;
      body.push('<g data-layer="' + escape(spec.id) + '" fill="none" stroke-linecap="' + (cap ?? 'butt') + '" stroke-linejoin="' + (join ?? 'miter') + '"' +
        (groupOpacity < 1 ? ' opacity="' + groupOpacity + '"' : '') + '>' +
        [...paths].map(([key, d]) => {
          const [stroke, strokeWidth, dashes, opacity] = key.split('|');
          return '<path' + paintAttribute('stroke', stroke) + ' stroke-width="' + strokeWidth + '"' + (dashes ? ' stroke-dasharray="' + dashes + '"' : '') +
            (opacity !== '1' ? ' stroke-opacity="' + opacity + '"' : '') + ' d="' + d.join('') + '"/>';
        }).join('') + '</g>');
    } else if (layer.type === 'symbol') {
      // Shields are text inside an icon; without the icon the number would float on its own.
      if ('icon-text-fit' in (declared.layout ?? {}) && value<string>(layout.get('icon-text-fit'), undefined) !== 'none') continue;
      for (const feature of list) labels.add(feature, layer, rings(feature), recolour);
    }
  }
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + round(width) + ' ' + round(height) + '"' +
    (options.className ? ' class="' + escape(options.className) + '"' : '') + '>' + body.join('') + '<g data-layer="labels">' + labels.svg.join('') + '</g></svg>';
}

class Labels {
  svg: string[] = [];
  private placed: { text: string; x: number; y: number }[] = [];
  private ids = 0;
  constructor(private options: SvgOptions, private width: number, private height: number, private avoided: { at: [number, number]; radius: number }[]) {}

  add(feature: Feature, layer: Layer, lines: Line[], recolour: (property: string, value: string) => string) {
    const { layout, paint } = layer;
    const { width, height, options } = this;
    const field = value<{ toString(): string } | string | undefined>(layout.get('text-field'), feature);
    const stack = value<string[]>(layout.get('text-font'), feature) ?? [];
    const transform = value<string>(layout.get('text-transform'), feature);
    const raw = String(field ?? '');
    let text = (options.text ? options.text(raw, stack) : raw).split('\n').map((line) => line.trim()).filter(Boolean).join('\n');
    if (transform === 'uppercase') text = text.toUpperCase();
    else if (transform === 'lowercase') text = text.toLowerCase();
    if (!text) return;
    const size = value<number>(layout.get('text-size'), feature);
    const fill = recolour('text-color', color(value(paint.get('text-color'), feature)) ?? 'rgba(0,0,0,1)');
    const haloColor = color(value(paint.get('text-halo-color'), feature));
    const halo = haloColor && recolour('text-halo-color', haloColor);
    const haloWidth = value<number>(paint.get('text-halo-width'), feature) || 0;
    const opacity = value<number>(paint.get('text-opacity'), feature);
    const spacing = value<number>(layout.get('text-letter-spacing'), feature) || 0;
    const font = options.font?.(stack) ?? {};
    const attributes = (font.className ? ' class="' + escape(font.className) + '"' : '') +
      (font.family ? ' font-family="' + escape(font.family) + '"' : '') + (font.weight ? ' font-weight="' + font.weight + '"' : '') +
      (font.style ? ' font-style="' + font.style + '"' : '') + ' font-size="' + round(size) + '"' + (spacing ? ' letter-spacing="' + round(spacing * size) + '"' : '');
    // MapLibre already left out the labels that collide; this drops the copies tiles share at their edges, and labels
    // where the template draws its own markers.
    const blocked = (x: number, y: number, distance: number) => this.placed.some((other) => other.text === text && Math.hypot(other.x - x, other.y - y) < distance)
      || this.avoided.some(({ at, radius }) => Math.hypot(at[0] - x, at[1] - y) < radius);
    const placement = value<string>(layout.get('symbol-placement'), feature);
    if (placement !== 'point' && feature._vectorTileFeature.type === 2) {
      // Along the longest visible stretch of the line, upright, centred.
      let best: Line = [];
      for (const line of lines) {
        let run: Line = [];
        for (const point of [...line, [Infinity, Infinity] as [number, number]]) {
          if (point[0] >= 0 && point[1] >= 0 && point[0] <= width && point[1] <= height) { run.push(point); continue; }
          if (length(run) > length(best)) best = run;
          run = [];
        }
      }
      const textWidth = text.length * size * .55 + text.length * spacing * size;
      if (length(best) < textWidth * 1.2) return;
      // Set the text on the straightest stretch near the middle that it fits, not along every bend: on a winding line,
      // such as a contour, text that follows the line is unreadable. A stretch counts as straight when its chord is at
      // least nine tenths of its length.
      const stretch = straightStretch(best, textWidth * 1.3, .9);
      if (!stretch) return;
      best = stretch;
      if (best[best.length - 1][0] < best[0][0]) best = [...best].reverse();
      const middle = best[Math.floor(best.length / 2)];
      if (blocked(middle[0], middle[1], 250)) return;
      this.placed.push({ text, x: middle[0], y: middle[1] });
      const id = 'map-label-' + ++this.ids;
      this.svg.push('<path id="' + id + '" fill="none" d="M' + best.map(([x, y]) => round(x) + ' ' + round(y)).join('L') + '"/>' +
        this.draw('<text' + attributes + ' dy="' + round(size * .35) + '"><textPath href="#' + id + '" startOffset="50%" text-anchor="middle">' +
          escape(text.replace(/\n/g, ' ')) + '</textPath></text>', fill, halo, haloWidth, opacity));
      return;
    }
    // A point, or the middle of a polygon's outline box.
    const all = lines.flat();
    if (!all.length) return;
    const xs = all.map(([x]) => x), ys = all.map(([, y]) => y);
    let [x, y] = feature._vectorTileFeature.type === 1 ? all[0] : [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
    if (x < 0 || y < 0 || x > width || y > height || blocked(x, y, 120)) return;
    this.placed.push({ text, x, y });
    const offset = value<number[]>(layout.get('text-offset'), feature) ?? [0, 0];
    x += offset[0] * size; y += offset[1] * size;
    const anchor = value<string>(layout.get('text-anchor'), feature) ?? 'center';
    const lineHeight = (value<number>(layout.get('text-line-height'), feature) || 1.2) * size;
    const maxWidth = (value<number>(layout.get('text-max-width'), feature) || 10) * size;
    const rows = text.split('\n').flatMap((line) => wrap(line, maxWidth, size));
    const block = rows.length * lineHeight;
    const top = anchor.startsWith('top') ? y : anchor.startsWith('bottom') ? y - block : y - block / 2;
    const textAnchor = anchor.endsWith('left') ? 'start' : anchor.endsWith('right') ? 'end' : 'middle';
    // A label the map's edge would cut is left out, as MapLibre does at the viewport.
    // Generous: the page may set the label in a wider font than the style names.
    const textWidth = Math.max(...rows.map((row) => row.length)) * size * .7;
    const left = textAnchor === 'start' ? x : textAnchor === 'end' ? x - textWidth : x - textWidth / 2;
    if (left < 0 || left + textWidth > width || top < 0 || top + block > height) return;
    this.svg.push(this.draw('<text' + attributes + ' text-anchor="' + textAnchor + '">' + rows.map((row, i) =>
      '<tspan x="' + round(x) + '" y="' + round(top + i * lineHeight + lineHeight / 2 + size * .35) + '">' + escape(row) + '</tspan>').join('') + '</text>',
      fill, halo, haloWidth, opacity));
  }

  // The halo copies of the label, shifted around it, then the label itself.
  private draw(element: string, fill: string, halo: string | undefined, haloWidth: number, opacity: number) {
    const copies = halo && haloWidth > 0 ? Math.max(8, Math.ceil(haloWidth * 6)) : 0;
    const shifted = Array.from({ length: copies }, (_, i) => {
      const angle = i / copies * 2 * Math.PI;
      return '<g transform="translate(' + Math.round(Math.cos(angle) * haloWidth * 100) / 100 + ' ' + Math.round(Math.sin(angle) * haloWidth * 100) / 100 + ')">' + element + '</g>';
    }).join('');
    return '<g' + (opacity < 1 ? ' opacity="' + opacity + '"' : '') + '>' +
      (shifted ? '<g' + paintAttribute('fill', halo!) + ' aria-hidden="true">' + shifted + '</g>' : '') + '<g' + paintAttribute('fill', fill) + '>' + element + '</g></g>';
  }
}

// The stretch of a line nearest its middle that is at least `need` long and whose chord is at least `straightness` of
// its length, or nothing when the line has no such stretch.
function straightStretch(line: Line, need: number, straightness: number): Line | undefined {
  const along = [0];
  for (let i = 1; i < line.length; i++) along.push(along[i - 1] + Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]));
  const total = along[along.length - 1];
  let found: { stretch: Line; offset: number } | undefined;
  for (let start = 0; start < line.length - 1; start++) {
    let end = start + 1;
    while (end < line.length - 1 && along[end] - along[start] < need) end++;
    if (along[end] - along[start] < need) break;
    const chord = Math.hypot(line[end][0] - line[start][0], line[end][1] - line[start][1]);
    if (chord < (along[end] - along[start]) * straightness) continue;
    const offset = Math.abs((along[start] + along[end]) / 2 - total / 2);
    if (!found || offset < found.offset) found = { stretch: line.slice(start, end + 1), offset };
  }
  return found?.stretch;
}

// MapLibre breaks labels wider than text-max-width at spaces; this estimates the width from the character count.
function wrap(line: string, maxWidth: number, size: number) {
  const rows: string[] = [];
  for (const word of line.split(' ')) {
    const last = rows[rows.length - 1];
    if (last !== undefined && (last.length + 1 + word.length) * size * .55 <= maxWidth) rows[rows.length - 1] = last + ' ' + word;
    else rows.push(word);
  }
  return rows;
}
