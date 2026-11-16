// A real map page (ADR 0006). The page draws the map with MapLibre GL from OpenFreeMap tiles through <RenderedImage>,
// as vectors (the maplibre-svg package in packages/): paths, and labels in the book's fonts, so the PDF is sharp at any
// zoom. The styles are in map-styles.ts. What the book adds, the GPX tracks, lies on top as vector lines drawn with
// the same projection. The map's data is credited on the book's last page (the layouts' `credits`). Only the map's
// settings are saved in the book; the editor frames the view by dragging and zooming. Export needs the internet, and a later export may
// look different if the map provider changes its maps or styles.
import React from 'react';
import { file, fonts, geometry, issue, p, RenderedImage } from 'imageflow';
import type { ElementEditorProps, ImageFlowNode, Rect, ResolvedFormat } from 'imageflow';
import type { Map as MapLibreMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { drawMapSvg, projector } from 'maplibre-svg';
import type { MapView as View } from 'maplibre-svg';
import { mapColor, mapOrigin, mapStyle, mapStyles, mapThemeColors, prepareMapLibre } from './map-styles';
import type { ColourTheme, MapStyle } from './map-styles';

export { mapOrigin };

export const mapParameters = {
  // Each track is drawn in its own colour; the label names it in the list.
  tracks: p.list({
    label: 'Tracks',
    item: {
      track: p.file({ label: 'GPX track', accept: ['.gpx'] }),
      colour: p.color({ label: 'Colour', default: '#c8432b' }),
      label: p.string({ label: 'Label', default: '', maxLength: 60, placeholder: 'Day 1' }),
    },
    max: 12,
  }),
  style: p.enum({ label: 'Map style', default: 'book', options: mapStyles }),
  longitude: p.number({ label: 'Longitude', default: 17.75, min: -180, max: 180, step: .00001 }),
  latitude: p.number({ label: 'Latitude', default: 69.35, min: -85, max: 85, step: .00001 }),
  // The MapLibre zoom of the printed map: its width in CSS pixels is the element's width at 96 per inch.
  zoom: p.number({ label: 'Zoom', default: 8.5, min: 0, max: 18, step: .01 }),
  trackWidth: p.number({ label: 'Track width', default: 1, min: .3, max: 3, step: .1, unit: 'mm' }),
};
// A map inside the page, such as beside a story: the same settings, drawn in the page's own colours by default.
export const insetMapParameters = { ...mapParameters, style: p.enum({ label: 'Map style', default: 'lines', options: mapStyles }) };
// The editor owns the view; the tracks, style and line width are the element's generated controls.
export const mapEditorParameters = ['longitude', 'latitude', 'zoom'] as const;
type Track = { id: string; track: string; colour: string; label: string };
type MapValues = { tracks: Track[]; style: MapStyle; longitude: number; latitude: number; zoom: number };
export type MapEditorProps = ElementEditorProps<typeof mapParameters, typeof mapEditorParameters[number]>;

const cssPerMm = 96 / 25.4;
// The map's area: the whole spread with its bleed.
export const mapRect = (format: ResolvedFormat) => geometry.spread(format, 'bleed');

// Track points of a GPX file as [longitude, latitude].
export function trackPoints(text: string) {
  const xml = new DOMParser().parseFromString(text, 'application/xml');
  if (xml.querySelector('parsererror')) throw new Error('is not valid GPX');
  const points = Array.from(xml.querySelectorAll('trkpt, rtept')).map((node) => [Number(node.getAttribute('lon')), Number(node.getAttribute('lat'))]);
  if (points.length < 2 || points.some((point) => point.some((value) => !Number.isFinite(value)))) throw new Error('has no track');
  return points;
}

/** The track in the element's CSS pixels, projected as the drawn map is. */
const projectTrack = (points: number[][], project: ReturnType<typeof projector>) =>
  points.map((point) => project(point).map((value) => value.toFixed(1)).join(',')).join(' ');

function readTrack(id: string) {
  const source = file(id);
  if (!source) return { points: undefined, problem: '' };
  try { return { points: trackPoints(source.text), problem: '' }; }
  catch (error) { return { points: undefined, problem: source.name + ' ' + (error instanceof Error ? error.message : 'could not be read') + '.' }; }
}
/** Every track with its points, or why it cannot be drawn. */
const readTracks = (tracks: Track[]) => tracks.map((track) => ({ ...track, ...readTrack(track.track) }));
/** The longitude/latitude bounds of all drawable tracks, or undefined when there are none. */
function trackBounds(tracks: ReturnType<typeof readTracks>): [[number, number], [number, number]] | undefined {
  const points = tracks.flatMap(({ points }) => points ?? []);
  if (!points.length) return undefined;
  const lngs = points.map(([lng]) => lng), lats = points.map(([, lat]) => lat);
  return [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]];
}

type MapLibre = typeof import('maplibre-gl');
// MapLibre is evaluated only when a map is drawn, so other pages never load it. Its package is CommonJS, so the
// bundle exposes it as the default export.
const loadMapLibre = () => import('maplibre-gl').then((module) => {
  const maplibre = ((module as { default?: MapLibre }).default ?? module) as MapLibre;
  // Contour tiles come from a protocol of maplibre-contour (map-styles.ts).
  prepareMapLibre(maplibre as unknown as Parameters<typeof prepareMapLibre>[0]);
  return maplibre;
});

// The map's labels in the book's fonts. Each role of the styles' font stacks gets a class the stylesheet sets
// (.map-label-place and so on, in styles.css), and the font that class names, so labels keep only what it can set.
const labelFonts = {
  place: { className: 'map-label-place', font: { family: 'Field Serif', weight: 600, style: 'normal' } },
  water: { className: 'map-label-water', font: { family: 'Field Serif', weight: 400, style: 'italic' } },
  plain: { className: 'map-label', font: { family: 'Field Sans', weight: 500, style: 'normal' } },
} as const;
const labelRole = (stack: string[]) => {
  const name = stack.join(' ');
  return labelFonts[/italic/i.test(name) ? 'water' : /bold/i.test(name) ? 'place' : 'plain'];
};

/**
 * The map as SVG markup (`output="vector"`), drawn off screen once every tile and the style have loaded. A style or
 * tile that fails to load fails the whole map, so a print never has holes in it. Labels keep what the book's fonts can
 * set (fonts.settable): the fonts cover Latin and Cyrillic, letters lose marks the fonts lack (ş → s), and characters
 * they have no glyphs for, such as a Chinese or Arabic line of a name, are left out.
 */
async function drawMap(style: MapStyle, view: View, signal: AbortSignal) {
  try {
    return await drawMapSvg({ maplibre: await loadMapLibre(), style: mapStyle(style), view, signal,
      // The Book style's colours as CSS variables, which the map element sets from the colour theme.
      color: mapColor(style),
      font: (stack) => ({ className: labelRole(stack).className }),
      text: (label, stack) => fonts.settable(label, labelRole(stack).font) });
  } catch (error) {
    throw new Error((error instanceof Error ? error.message : String(error)) + ' (' + mapOrigin + ')');
  }
}

/** The map as the page draws it: the map picture and the tracks over it in list order. */
export function MapView({ values, trackWidth, rect, theme, className, Element }: {
  values: MapValues; trackWidth: number; rect: Rect;
  // `map-inset` for a map inside the page's margins.
  className?: string;
  // The book's colour theme, which the Book style follows.
  theme: ColourTheme;
  Element: (props: { id: 'map'; rect: Rect; className?: string; children?: ImageFlowNode }) => ImageFlowNode;
}) {
  const width = rect.width * cssPerMm, height = rect.height * cssPerMm;
  const tracks = readTracks(values.tracks);
  const view = { longitude: values.longitude, latitude: values.latitude, zoom: values.zoom };
  // The drawn map and the tracks share one projection of the element's printed size.
  const project = projector({ ...view, width, height });
  return <Element id="map" className={'map' + (className ? ' ' + className : '')} rect={rect}>
    {/* The theme reaches the drawn map only through these CSS variables, so a theme change does not draw it again. */}
    <RenderedImage className="map-image" label="Map" output="vector" style={mapThemeColors(values.style, theme)} inputs={{ style: values.style, ...view, width: rect.width, height: rect.height }}
      draw={(target) => drawMap(values.style, { ...view, width: target.width, height: target.height }, target.signal)} />
    {tracks.some(({ points }) => points) && <svg className="map-track" viewBox={'0 0 ' + width.toFixed(1) + ' ' + height.toFixed(1)} preserveAspectRatio="none" aria-label="Route">
      {tracks.map(({ id, points, colour, label }) => points && <polyline key={id} points={projectTrack(points, project)}
        style={{ stroke: colour, strokeWidth: trackWidth * cssPerMm }}>{label && <title>{label}</title>}</polyline>)}
    </svg>}
    {tracks.map(({ id, problem, track, label }, index) => problem && <span key={id} hidden {...issue({ code: 'gpx-invalid',
      message: 'Track ' + (index + 1) + (label ? ' (' + label + ')' : '') + ': ' + problem + ' The track is left out.',
      element: 'map', parameter: 'tracks', file: track,
      suggestion: 'Assign a GPX file that contains a track or route to item ' + id + ' of tracks, or remove the item with remove_list_item.' })} />)}
  </Element>;
}

// The map's editor frames the view on the page itself (`presentation: 'inline'`): it is the element, at its printed
// size, so dragging and zooming show the composition as printed, with the track and title where the page draws
// them. It owns only the view; the tracks, style and line width are generated controls in the editor's toolbar, where
// the list of tracks is a "Tracks (n)" button opening the list. In the
// panel (the fallback, or when moved there) the same map is shown at the page's aspect ratio.
export function MapEditor({ values, set, readOnly, context, document, presentation, waitUntil, children }: MapEditorProps & { children?: ImageFlowNode }) {
  // The live map shows the Book style in the book's colour theme.
  const theme: ColourTheme = (document as { theme?: string }).theme === 'dark' ? 'dark' : 'light';
  const holder = React.useRef<HTMLDivElement>(null);
  const map = React.useRef<MapLibreMap>(undefined);
  const latest = React.useRef(values);
  latest.current = values;
  const [error, setError] = React.useState('');
  const inline = presentation === 'inline';
  const measured = context.elements.map.rect;
  // Keep an existing map stable while the book redraws, but never invent its first output size.
  const lastRect = React.useRef(measured);
  if (measured) lastRect.current = measured;
  const rect = measured ?? lastRect.current;
  const printWidth = (rect?.width ?? 0) * cssPerMm;
  const width = React.useRef(printWidth);
  width.current = printWidth;
  const tracks = readTracks(values.tracks);
  const drawable = tracks.some(({ points }) => points);
  const problem = tracks.map(({ problem }) => problem).filter(Boolean).join(' ');
  // The editor map's CSS pixels per printed CSS pixel: 1 inline, where the frame has the printed size; less in the panel.
  const ratio = () => (holder.current?.clientWidth || width.current) / (width.current || 1);
  // A smaller editor map shows the same area at a lower zoom.
  const editorZoom = (zoom: number) => zoom + Math.log2(ratio());
  const savedView = (target: MapLibreMap) => {
    const center = target.getCenter();
    const round = (value: number, digits: number) => Number(value.toFixed(digits));
    return { longitude: round(center.lng, 5), latitude: round(center.lat, 5), zoom: round(Math.min(18, Math.max(0, target.getZoom() - Math.log2(ratio()))), 2) };
  };

  // The tracks as lines on the editor map, each in its colour, at the page's width; redrawn when they or the style change.
  const drawTrack = (target: MapLibreMap) => {
    const current = readTracks(latest.current.tracks).filter(({ points }) => points);
    const data = { type: 'FeatureCollection' as const, features: current.map(({ points, colour }) => ({ type: 'Feature' as const, properties: { colour },
      geometry: { type: 'LineString' as const, coordinates: points! } })) };
    const paint = { 'line-color': ['get', 'colour'] as unknown as string, 'line-width': latest.current.trackWidth * cssPerMm * ratio() };
    const source = target.getSource('track') as { setData?: (value: typeof data) => void } | undefined;
    if (source?.setData) {
      source.setData(data);
      for (const [key, value] of Object.entries(paint)) target.setPaintProperty('track', key, value);
      return;
    }
    target.addSource('track', { type: 'geojson', data });
    target.addLayer({ id: 'track', type: 'line', source: 'track', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint });
  };
  // Fits every track at once.
  const fitTrack = () => {
    const bounds = trackBounds(readTracks(latest.current.tracks));
    const target = map.current;
    if (!bounds || !target) return;
    target.fitBounds(bounds, { padding: 40 * ratio(), animate: false });
    set(savedView(target));
  };
  const latestFit = React.useRef(fitTrack);
  latestFit.current = fitTrack;

  // On the page, the printed map stays until this one has drawn its first view (or failed), so nothing flickers. The
  // wait is registered while mounting, before the map's measured rectangle arrives.
  const firstView = React.useRef<() => void>(() => {});
  React.useEffect(() => { waitUntil(new Promise<void>((resolve) => { firstView.current = resolve; })); }, []);
  React.useEffect(() => {
    if (!rect) return;
    let removed = false;
    const drawn = () => firstView.current();
    void loadMapLibre().then((maplibregl) => {
      if (removed || !holder.current) return drawn();
      const view = latest.current;
      let created: MapLibreMap;
      try {
        created = new maplibregl.Map({
          container: holder.current, style: mapStyle(view.style, theme), center: [view.longitude, view.latitude], zoom: editorZoom(view.zoom),
          interactive: !readOnly, attributionControl: inline ? false : { compact: true }, dragRotate: false, pitchWithRotate: false, touchPitch: false,
        });
      } catch (failure) {
        // Such as no WebGL: the page keeps showing its drawn map, and the problem shows over it.
        setError('The map cannot be shown here: ' + (failure instanceof Error ? failure.message : String((failure as { message?: string })?.message ?? failure)));
        return drawn();
      }
      created.touchZoomRotate.disableRotation();
      created.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
      if (!readOnly) created.addControl(fitControl(() => latestFit.current()), 'top-right');
      // Only the user's own moves change the saved view: a drag, the wheel, a pinch or the zoom buttons, not the moves
      // the editor makes itself (following a resize). Scroll zoom starts and ends without an input event of its own.
      let input = false;
      for (const name of ['wheel', 'mousedown', 'touchstart', 'dblclick'] as const) created.on(name, () => { input = true; });
      created.on('movestart', (event) => { if ('originalEvent' in event && event.originalEvent) input = true; });
      created.on('moveend', () => {
        if (!input || readOnly) return;
        input = false;
        set(savedView(created));
      });
      // Shown once every tile has drawn, or soon after the style and the first tiles, whichever comes first: on a
      // dense map the last tiles may take seconds, and they fill in while the user is already framing the view.
      created.once('idle', drawn);
      created.once('load', () => setTimeout(drawn, 600));
      created.on('error', (event) => {
        drawn();
        if (!created.isStyleLoaded()) setError('The map could not load (' + (event.error?.message ?? 'no connection') + '). It needs ' + mapOrigin + '.');
      });
      created.on('style.load', () => { setError(''); drawTrack(created); });
      map.current = created;
    }, (failure: unknown) => { drawn(); setError('The map library could not load: ' + String(failure)); });
    return () => { removed = true; map.current?.remove(); map.current = undefined; };
  }, [!!rect, readOnly]);
  React.useEffect(() => {
    const current = map.current;
    if (!current || !rect) return;
    current.resize();
    current.jumpTo({ center: [latest.current.longitude, latest.current.latitude], zoom: editorZoom(latest.current.zoom) });
  }, [rect?.width, rect?.height]);
  React.useEffect(() => { if (map.current?.isStyleLoaded()) drawTrack(map.current); }, [JSON.stringify(values.tracks), values.trackWidth]);
  React.useEffect(() => { map.current?.setStyle(mapStyle(values.style, theme)); }, [values.style, theme]);
  React.useEffect(() => {
    const button = holder.current?.querySelector<HTMLButtonElement>('.map-fit-track');
    if (button) button.disabled = !drawable;
  });

  // A problem is drawn over the map, so it never moves the map or the page around it.
  const message = error || problem;
  return <div className={'map-editor' + (inline ? ' map-editor-inline' : '')}>
    <div ref={holder} className="map-editor-map" role="application" aria-label="Map view"
      data-output-x={measured?.x} data-output-y={measured?.y} data-output-width={measured?.width} data-output-height={measured?.height}
      style={!inline && rect ? { aspectRatio: (rect.width / rect.height).toFixed(4) } : undefined} />
    {inline && children}
    {message && <p className="map-editor-problem" role="alert">{message}</p>}
  </div>;
}

// A map control, in the style of MapLibre's zoom buttons, that frames every track.
function fitControl(fit: () => void) {
  let container: HTMLElement | undefined;
  return {
    onAdd() {
      container = document.createElement('div');
      container.className = 'maplibregl-ctrl maplibregl-ctrl-group';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'map-fit-track';
      button.title = 'Fit tracks';
      button.setAttribute('aria-label', 'Fit tracks');
      button.innerHTML = '<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true"><path d="M4 8V4h4M12 4h4v4M16 12v4h-4M8 16H4v-4" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';
      button.addEventListener('click', fit);
      container.append(button);
      return container;
    },
    onRemove() { container?.remove(); },
  };
}
