// Web Mercator, as MapLibre uses it: x and y in 0–1 across the world, and 512 CSS pixels per world at zoom 0.
const mercator = (longitude, latitude) => {
    const sin = Math.sin(Math.max(-85.05113, Math.min(85.05113, latitude)) * Math.PI / 180);
    return [(longitude + 180) / 360, .5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)];
};
/** Longitude and latitude to the view's CSS pixels, as the drawn map places them. Pure, so a layout can use it. */
export function projector(view) {
    const world = 512 * 2 ** view.zoom;
    const [cx, cy] = mercator(view.longitude, view.latitude);
    return ([longitude, latitude]) => {
        const [x, y] = mercator(longitude, latitude);
        return [(x - cx) * world + view.width / 2, (y - cy) * world + view.height / 2];
    };
}
/**
 * Loads `style` off screen at the view and draws it as SVG markup once every tile has loaded. A style or tile that
 * fails to load rejects, so a print never has holes in it.
 */
export async function drawMapSvg({ maplibre, style, view, signal, ...options }) {
    signal?.throwIfAborted();
    const holder = document.createElement('div');
    holder.style.cssText = 'position:fixed;left:-20000px;top:0;width:' + view.width + 'px;height:' + view.height + 'px;';
    document.body.append(holder);
    // Only the features it places are read back, so it draws at one pixel per CSS pixel.
    const map = new maplibre.Map({ container: holder, style, center: [view.longitude, view.latitude], zoom: view.zoom,
        interactive: false, attributionControl: false, fadeDuration: 0, pixelRatio: 1 });
    let abort;
    try {
        await new Promise((resolve, reject) => {
            abort = () => reject(signal?.reason ?? new Error('stopped'));
            signal?.addEventListener('abort', abort, { once: true });
            map.on('error', (event) => reject(new Error(event.error?.message ?? 'a map resource did not load')));
            map.once('idle', () => resolve());
        });
        return mapToSvg(map, view, options);
    }
    finally {
        if (abort)
            signal?.removeEventListener('abort', abort);
        map.remove();
        holder.remove();
    }
}
const round = (value) => Math.round(value * 10) / 10;
// A colour as an SVG paint attribute; a CSS value such as var() only works as a style property.
const plainColor = (color) => /^[#\w(][\w\s#.,%()-]*$/.test(color) && !/\bvar\(/.test(color);
const paintAttribute = (name, color) => plainColor(color)
    ? ' ' + name + '="' + color + '"' : ' style="' + name + ':' + escape(color) + '"';
// An area's fill, with a hairline of the same colour around it: where tiles cut an area, its parts meet edge to edge,
// and PDF viewers can show a seam there. Inside the layer's group, the overlap does not change the colour.
const areaPaint = (color) => plainColor(color) ? ' fill="' + color + '" stroke="' + color + '" stroke-width=".5" stroke-linejoin="round"'
    : ' style="fill:' + escape(color) + ';stroke:' + escape(color) + '" stroke-width=".5" stroke-linejoin="round"';
const escape = (text) => text.replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]);
// A constant property, or its value for this feature.
function value(property, feature) {
    const possibly = property;
    if (possibly && typeof possibly === 'object' && 'evaluate' in possibly && typeof possibly.evaluate === 'function') {
        const tile = feature?._vectorTileFeature;
        return possibly.evaluate({ type: tile?.type, id: feature?.id, properties: feature?.properties ?? {} }, {});
    }
    return possibly;
}
const color = (input) => {
    const parsed = input;
    return parsed && parsed.a > 0 ? parsed.toString() : undefined;
};
// Data-driven paint is evaluated per feature; constants once per layer.
const constant = (property) => !(property && typeof property === 'object' && 'evaluate' in property && property.value?.kind !== 'constant');
const length = (line) => line.reduce((sum, point, i) => i ? sum + Math.hypot(point[0] - line[i - 1][0], point[1] - line[i - 1][1]) : 0, 0);
/** Draws a MapLibre map that has finished loading (`idle`) as SVG markup of the view. */
export function mapToSvg(map, view, options = {}) {
    const { width, height, zoom } = view;
    const world = 512 * 2 ** zoom;
    const [cx, cy] = mercator(view.longitude, view.latitude);
    // Tile coordinates to the view's CSS pixels.
    const project = (feature) => {
        const scale = 2 ** feature._z, extent = feature._vectorTileFeature.extent;
        return (point) => [
            ((feature._x + point.x / extent) / scale - cx) * world + width / 2,
            ((feature._y + point.y / extent) / scale - cy) * world + height / 2
        ];
    };
    // Rings or lines in pixels, without points closer than a quarter pixel: tiles carry far more detail than print needs.
    const rings = (feature) => {
        const to = project(feature);
        return feature._vectorTileFeature.loadGeometry().map((ring) => {
            const out = [];
            for (const point of ring) {
                const next = to(point), last = out[out.length - 1];
                if (!last || Math.abs(next[0] - last[0]) + Math.abs(next[1] - last[1]) > .25)
                    out.push(next);
            }
            return out;
        });
    };
    // The outline of an area, for a line layer on polygons such as a coastline: without the edges where a tile cut the
    // area, at its edge or in the buffer around it. MapLibre hides those by drawing each tile only inside its square;
    // here every segment between two points that are not strictly inside the tile is left out, since the neighbouring
    // tile draws that stretch of the outline itself.
    const outlines = (feature) => {
        const to = project(feature), extent = feature._vectorTileFeature.extent;
        const inside = (point) => point.x > 0 && point.y > 0 && point.x < extent && point.y < extent;
        const runs = [];
        for (const ring of feature._vectorTileFeature.loadGeometry()) {
            let run = [];
            for (let i = 0; i < ring.length; i++) {
                const point = ring[i], previous = ring[i - 1];
                if (previous && !inside(previous) && !inside(point)) {
                    if (run.length > 1)
                        runs.push(run);
                    run = [];
                }
                const next = to(point), last = run[run.length - 1];
                if (!last || Math.abs(next[0] - last[0]) + Math.abs(next[1] - last[1]) > .25)
                    run.push(next);
            }
            if (run.length > 1)
                runs.push(run);
        }
        return runs;
    };
    const margin = 50;
    const visible = (lines) => lines.some((line) => line.some(([x, y]) => x > -margin && y > -margin && x < width + margin && y < height + margin));
    const pathOf = (lines, closed) => lines.filter((line) => line.length > (closed ? 2 : 1))
        .map((line) => 'M' + line.map(([x, y]) => round(x) + ' ' + round(y)).join('L') + (closed ? 'Z' : '')).join('');
    const style = map.getStyle();
    const features = new Map();
    for (const feature of map.queryRenderedFeatures()) {
        if (!feature._vectorTileFeature?.loadGeometry)
            continue;
        const list = features.get(feature.layer.id);
        if (list)
            list.push(feature);
        else
            features.set(feature.layer.id, [feature]);
    }
    const place = projector(view);
    const avoided = (options.avoid ?? []).map(({ at, radius }) => ({ at: place(at), radius }));
    const labels = new Labels(options, width, height, avoided);
    const body = [];
    for (const spec of style.layers) {
        const layer = map.getLayer(spec.id);
        if (!layer || layer.isHidden(zoom))
            continue;
        if (options.layers && !options.layers({ id: spec.id, type: spec.type, ...('source-layer' in spec && spec['source-layer'] ? { sourceLayer: spec['source-layer'] } : {}) }))
            continue;
        const { paint, layout } = layer;
        const info = { id: spec.id, type: spec.type, ...('source-layer' in spec && spec['source-layer'] ? { sourceLayer: spec['source-layer'] } : {}) };
        const recolour = (property, value) => options.color ? options.color(value, { layer: info, property }) : value;
        const declared = spec;
        if (layer.type === 'background') {
            const fill = color(paint.get('background-color'));
            if (fill && !('background-pattern' in (declared.paint ?? {}))) {
                const opacity = value(paint.get('background-opacity'), undefined);
                body.push('<rect width="' + round(width) + '" height="' + round(height) + '"' + paintAttribute('fill', recolour('background-color', fill)) + (opacity < 1 ? ' opacity="' + opacity + '"' : '') + '/>');
            }
            continue;
        }
        const list = features.get(spec.id);
        if (!list?.length)
            continue;
        if (layer.type === 'fill' || layer.type === 'fill-extrusion') {
            const prefix = layer.type === 'fill' ? 'fill' : 'fill-extrusion';
            if ('fill-pattern' in (declared.paint ?? {}) || 'fill-extrusion-pattern' in (declared.paint ?? {}))
                continue;
            const opacityProperty = paint.get(prefix + '-opacity');
            // Features overlap where tiles meet; one opacity on the whole layer keeps the overlaps invisible.
            const groupOpacity = constant(opacityProperty) ? value(opacityProperty, undefined) : 1;
            const paths = new Map();
            for (const feature of list) {
                const evaluated = color(value(paint.get(prefix + '-color'), feature));
                if (!evaluated)
                    continue;
                const fill = recolour(prefix + '-color', evaluated);
                const opacity = constant(opacityProperty) ? 1 : value(opacityProperty, feature);
                const lines = rings(feature);
                if (!visible(lines))
                    continue;
                const key = fill + '|' + opacity;
                const d = pathOf(lines, true);
                if (d)
                    (paths.get(key) ?? paths.set(key, []).get(key)).push(d);
            }
            if (!paths.size)
                continue;
            body.push('<g data-layer="' + escape(spec.id) + '"' + (groupOpacity < 1 ? ' opacity="' + groupOpacity + '"' : '') + '>' +
                [...paths].map(([key, d]) => {
                    const [fill, opacity] = key.split('|');
                    return '<path' + areaPaint(fill) + (opacity !== '1' ? ' fill-opacity="' + opacity + '" stroke-opacity="' + opacity + '"' : '') + ' d="' + d.join('') + '"/>';
                }).join('') + '</g>');
        }
        else if (layer.type === 'line') {
            if ('line-pattern' in (declared.paint ?? {}))
                continue;
            const opacityProperty = paint.get('line-opacity');
            const groupOpacity = constant(opacityProperty) ? value(opacityProperty, undefined) : 1;
            const cap = value(layout.get('line-cap'), undefined), join = value(layout.get('line-join'), undefined);
            const paths = new Map();
            for (const feature of list) {
                const evaluated = color(value(paint.get('line-color'), feature));
                const stroke = evaluated && recolour('line-color', evaluated);
                const lineWidth = value(paint.get('line-width'), feature), gap = value(paint.get('line-gap-width'), feature) || 0;
                if (!stroke || !(lineWidth > 0))
                    continue;
                // A gap width draws the line on both sides of a gap; drawing it whole is close enough under the line on top.
                const strokeWidth = gap > 0 ? gap + 2 * lineWidth : lineWidth;
                const dashes = value(paint.get('line-dasharray'), feature);
                const opacity = constant(opacityProperty) ? 1 : value(opacityProperty, feature);
                const lines = feature._vectorTileFeature.type === 3 ? outlines(feature) : rings(feature);
                if (!visible(lines))
                    continue;
                const key = [stroke, Math.round(strokeWidth * 100) / 100, dashes?.length ? dashes.map((dash) => round(dash * lineWidth)).join(' ') : '', opacity].join('|');
                const d = pathOf(lines, false);
                if (d)
                    (paths.get(key) ?? paths.set(key, []).get(key)).push(d);
            }
            if (!paths.size)
                continue;
            body.push('<g data-layer="' + escape(spec.id) + '" fill="none" stroke-linecap="' + (cap ?? 'butt') + '" stroke-linejoin="' + (join ?? 'miter') + '"' +
                (groupOpacity < 1 ? ' opacity="' + groupOpacity + '"' : '') + '>' +
                [...paths].map(([key, d]) => {
                    const [stroke, strokeWidth, dashes, opacity] = key.split('|');
                    return '<path' + paintAttribute('stroke', stroke) + ' stroke-width="' + strokeWidth + '"' + (dashes ? ' stroke-dasharray="' + dashes + '"' : '') +
                        (opacity !== '1' ? ' stroke-opacity="' + opacity + '"' : '') + ' d="' + d.join('') + '"/>';
                }).join('') + '</g>');
        }
        else if (layer.type === 'symbol') {
            // Shields are text inside an icon; without the icon the number would float on its own.
            if ('icon-text-fit' in (declared.layout ?? {}) && value(layout.get('icon-text-fit'), undefined) !== 'none')
                continue;
            for (const feature of list)
                labels.add(feature, layer, rings(feature), recolour);
        }
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + round(width) + ' ' + round(height) + '"' +
        (options.className ? ' class="' + escape(options.className) + '"' : '') + '>' + body.join('') + '<g data-layer="labels">' + labels.svg.join('') + '</g></svg>';
}
class Labels {
    options;
    width;
    height;
    avoided;
    svg = [];
    placed = [];
    ids = 0;
    constructor(options, width, height, avoided) {
        this.options = options;
        this.width = width;
        this.height = height;
        this.avoided = avoided;
    }
    add(feature, layer, lines, recolour) {
        const { layout, paint } = layer;
        const { width, height, options } = this;
        const field = value(layout.get('text-field'), feature);
        const stack = value(layout.get('text-font'), feature) ?? [];
        const transform = value(layout.get('text-transform'), feature);
        const raw = String(field ?? '');
        let text = (options.text ? options.text(raw, stack) : raw).split('\n').map((line) => line.trim()).filter(Boolean).join('\n');
        if (transform === 'uppercase')
            text = text.toUpperCase();
        else if (transform === 'lowercase')
            text = text.toLowerCase();
        if (!text)
            return;
        const size = value(layout.get('text-size'), feature);
        const fill = recolour('text-color', color(value(paint.get('text-color'), feature)) ?? 'rgba(0,0,0,1)');
        const haloColor = color(value(paint.get('text-halo-color'), feature));
        const halo = haloColor && recolour('text-halo-color', haloColor);
        const haloWidth = value(paint.get('text-halo-width'), feature) || 0;
        const opacity = value(paint.get('text-opacity'), feature);
        const spacing = value(layout.get('text-letter-spacing'), feature) || 0;
        const font = options.font?.(stack) ?? {};
        const attributes = (font.className ? ' class="' + escape(font.className) + '"' : '') +
            (font.family ? ' font-family="' + escape(font.family) + '"' : '') + (font.weight ? ' font-weight="' + font.weight + '"' : '') +
            (font.style ? ' font-style="' + font.style + '"' : '') + ' font-size="' + round(size) + '"' + (spacing ? ' letter-spacing="' + round(spacing * size) + '"' : '');
        // MapLibre already left out the labels that collide; this drops the copies tiles share at their edges, and labels
        // where the template draws its own markers.
        const blocked = (x, y, distance) => this.placed.some((other) => other.text === text && Math.hypot(other.x - x, other.y - y) < distance)
            || this.avoided.some(({ at, radius }) => Math.hypot(at[0] - x, at[1] - y) < radius);
        const placement = value(layout.get('symbol-placement'), feature);
        if (placement !== 'point' && feature._vectorTileFeature.type === 2) {
            // Along the longest visible stretch of the line, upright, centred.
            let best = [];
            for (const line of lines) {
                let run = [];
                for (const point of [...line, [Infinity, Infinity]]) {
                    if (point[0] >= 0 && point[1] >= 0 && point[0] <= width && point[1] <= height) {
                        run.push(point);
                        continue;
                    }
                    if (length(run) > length(best))
                        best = run;
                    run = [];
                }
            }
            const textWidth = text.length * size * .55 + text.length * spacing * size;
            if (length(best) < textWidth * 1.2)
                return;
            if (best[best.length - 1][0] < best[0][0])
                best = [...best].reverse();
            const middle = best[Math.floor(best.length / 2)];
            if (blocked(middle[0], middle[1], 250))
                return;
            this.placed.push({ text, x: middle[0], y: middle[1] });
            const id = 'map-label-' + ++this.ids;
            this.svg.push('<path id="' + id + '" fill="none" d="M' + best.map(([x, y]) => round(x) + ' ' + round(y)).join('L') + '"/>' +
                this.draw('<text' + attributes + ' dy="' + round(size * .35) + '"><textPath href="#' + id + '" startOffset="50%" text-anchor="middle">' +
                    escape(text.replace(/\n/g, ' ')) + '</textPath></text>', fill, halo, haloWidth, opacity));
            return;
        }
        // A point, or the middle of a polygon's outline box.
        const all = lines.flat();
        if (!all.length)
            return;
        const xs = all.map(([x]) => x), ys = all.map(([, y]) => y);
        let [x, y] = feature._vectorTileFeature.type === 1 ? all[0] : [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
        if (x < 0 || y < 0 || x > width || y > height || blocked(x, y, 120))
            return;
        this.placed.push({ text, x, y });
        const offset = value(layout.get('text-offset'), feature) ?? [0, 0];
        x += offset[0] * size;
        y += offset[1] * size;
        const anchor = value(layout.get('text-anchor'), feature) ?? 'center';
        const lineHeight = (value(layout.get('text-line-height'), feature) || 1.2) * size;
        const maxWidth = (value(layout.get('text-max-width'), feature) || 10) * size;
        const rows = text.split('\n').flatMap((line) => wrap(line, maxWidth, size));
        const block = rows.length * lineHeight;
        const top = anchor.startsWith('top') ? y : anchor.startsWith('bottom') ? y - block : y - block / 2;
        const textAnchor = anchor.endsWith('left') ? 'start' : anchor.endsWith('right') ? 'end' : 'middle';
        this.svg.push(this.draw('<text' + attributes + ' text-anchor="' + textAnchor + '">' + rows.map((row, i) => '<tspan x="' + round(x) + '" y="' + round(top + i * lineHeight + lineHeight / 2 + size * .35) + '">' + escape(row) + '</tspan>').join('') + '</text>', fill, halo, haloWidth, opacity));
    }
    // The halo copies of the label, shifted around it, then the label itself.
    draw(element, fill, halo, haloWidth, opacity) {
        const copies = halo && haloWidth > 0 ? Math.max(8, Math.ceil(haloWidth * 6)) : 0;
        const shifted = Array.from({ length: copies }, (_, i) => {
            const angle = i / copies * 2 * Math.PI;
            return '<g transform="translate(' + Math.round(Math.cos(angle) * haloWidth * 100) / 100 + ' ' + Math.round(Math.sin(angle) * haloWidth * 100) / 100 + ')">' + element + '</g>';
        }).join('');
        return '<g' + (opacity < 1 ? ' opacity="' + opacity + '"' : '') + '>' +
            (shifted ? '<g' + paintAttribute('fill', halo) + ' aria-hidden="true">' + shifted + '</g>' : '') + '<g' + paintAttribute('fill', fill) + '>' + element + '</g></g>';
    }
}
// MapLibre breaks labels wider than text-max-width at spaces; this estimates the width from the character count.
function wrap(line, maxWidth, size) {
    const rows = [];
    for (const word of line.split(' ')) {
        const last = rows[rows.length - 1];
        if (last !== undefined && (last.length + 1 + word.length) * size * .55 <= maxWidth)
            rows[rows.length - 1] = last + ' ' + word;
        else
            rows.push(word);
    }
    return rows;
}
