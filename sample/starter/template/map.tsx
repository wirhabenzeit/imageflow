// A real map page (ADR 0006). The page draws the map live with MapLibre GL and OpenFreeMap styles through
// <RenderedImage>: at screen resolution in the editor, and again at the format's target resolution when the book is
// exported. The GPX tracks lie on top as vector lines, with the map's attribution. Only the map's settings are saved
// in the book; the editor frames the view by dragging and zooming. Export needs the internet, and a later export may
// look different if the map provider changes its maps or styles.
import React from 'react';
import { file, geometry, issue, p, RenderedImage } from 'imageflow';
import type { ElementEditorProps, ImageFlowNode, Rect, RenderTarget, ResolvedFormat } from 'imageflow';
import type { Map as MapLibreMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

export const mapOrigin = 'https://tiles.openfreemap.org';
const styles = { liberty: 'Liberty', bright: 'Bright', positron: 'Positron' } as const;
type MapStyle = keyof typeof styles;
const styleUrl = (style: MapStyle) => mapOrigin + '/styles/' + style;
export const mapAttribution = '© OpenFreeMap © OpenMapTiles © OpenStreetMap contributors';

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
  style: p.enum({ label: 'Map style', default: 'liberty', options: styles }),
  longitude: p.number({ label: 'Longitude', default: 17.75, min: -180, max: 180, step: .00001 }),
  latitude: p.number({ label: 'Latitude', default: 69.35, min: -85, max: 85, step: .00001 }),
  // The MapLibre zoom of the printed map: its width in CSS pixels is the element's width at 96 per inch.
  zoom: p.number({ label: 'Zoom', default: 8.5, min: 0, max: 18, step: .01 }),
  trackWidth: p.number({ label: 'Track width', default: 1, min: .3, max: 3, step: .1, unit: 'mm' }),
  // Before Tracks, a map had one GPX track with one colour. Books saved then keep them; the map draws that track as its
  // first while Tracks is empty, and the Book check offers to move it into Tracks. They have no controls.
  track: p.file({ label: 'Earlier GPX track', accept: ['.gpx'] }),
  trackColor: p.color({ label: 'Earlier track colour', default: '#c8432b' }),
};
export const mapControls = ['tracks', 'style', 'trackWidth'] as const;
// The editor owns the view; the tracks, style and line width are the element's generated controls.
export const mapEditorParameters = ['longitude', 'latitude', 'zoom'] as const;
type Track = { id: string; track: string; colour: string; label: string };
type MapValues = { tracks: Track[]; track: string; trackColor: string; style: MapStyle; longitude: number; latitude: number; zoom: number };

/** The tracks the map draws: Tracks, or the single track of a book saved before Tracks existed. */
export function mapTracks(values: Pick<MapValues, 'tracks' | 'track' | 'trackColor'>): Track[] {
  if (values.tracks.length || !values.track) return values.tracks;
  return [{ id: 'earlier-track', track: values.track, colour: values.trackColor, label: '' }];
}
export type MapEditorProps = ElementEditorProps<typeof mapParameters, typeof mapEditorParameters[number]>;

const cssPerMm = 96 / 25.4;
// The map's area: the whole spread with its bleed.
export const mapRect = (format: ResolvedFormat) => geometry.spread(format, 'bleed');

// Web Mercator, as MapLibre uses it: x and y in 0–1 across the world, and 512 CSS pixels per world at zoom 0.
const mercator = ([longitude, latitude]: number[]) => {
  const sin = Math.sin(Math.max(-85.05113, Math.min(85.05113, latitude)) * Math.PI / 180);
  return [(longitude + 180) / 360, .5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)];
};

// Track points of a GPX file as [longitude, latitude].
export function trackPoints(text: string) {
  const xml = new DOMParser().parseFromString(text, 'application/xml');
  if (xml.querySelector('parsererror')) throw new Error('is not valid GPX');
  const points = Array.from(xml.querySelectorAll('trkpt, rtept')).map((node) => [Number(node.getAttribute('lon')), Number(node.getAttribute('lat'))]);
  if (points.length < 2 || points.some((point) => point.some((value) => !Number.isFinite(value)))) throw new Error('has no track');
  return points;
}

/** The track in the element's CSS pixels, for the same view the map shows. */
function projectTrack(points: number[][], values: Pick<MapValues, 'longitude' | 'latitude' | 'zoom'>, width: number, height: number) {
  const world = 512 * 2 ** values.zoom;
  const [cx, cy] = mercator([values.longitude, values.latitude]);
  return points.map((point) => {
    const [x, y] = mercator(point);
    return ((x - cx) * world + width / 2).toFixed(1) + ',' + ((y - cy) * world + height / 2).toFixed(1);
  }).join(' ');
}

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
const loadMapLibre = () => import('maplibre-gl').then((module) => ((module as { default?: MapLibre }).default ?? module) as MapLibre);

/**
 * Draws the view off screen at the element's size and the target's resolution, once every tile and the style have
 * loaded. A style or tile that fails to load fails the whole map, so a print never has holes in it.
 */
async function drawMap(view: { style: MapStyle; longitude: number; latitude: number; zoom: number }, target: RenderTarget) {
  const maplibregl = await loadMapLibre();
  target.signal.throwIfAborted();
  const holder = document.createElement('div');
  holder.style.cssText = 'position:fixed;left:-20000px;top:0;width:' + target.width + 'px;height:' + target.height + 'px;';
  document.body.append(holder);
  const map = new maplibregl.Map({
    container: holder, style: styleUrl(view.style), center: [view.longitude, view.latitude], zoom: view.zoom,
    interactive: false, attributionControl: false, fadeDuration: 0, pixelRatio: target.pixelRatio, maxCanvasSize: [16384, 16384],
    canvasContextAttributes: { preserveDrawingBuffer: true },
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(new Error('stopped'));
      target.signal.addEventListener('abort', abort, { once: true });
      map.on('error', (event) => reject(new Error((event.error?.message ?? 'a map resource did not load') + ' (' + mapOrigin + ')')));
      map.once('idle', () => { target.signal.removeEventListener('abort', abort); resolve(); });
    });
    return map.getCanvas();
  } finally {
    // The canvas is encoded before the map goes; removing it after a tick keeps the drawing buffer until then.
    setTimeout(() => { map.remove(); holder.remove(); }, 0);
  }
}

/** The map as the page draws it: the map picture, the tracks over it in list order, and the attribution. */
export function MapView({ values, trackWidth, rect, Element }: {
  values: MapValues; trackWidth: number; rect: Rect;
  Element: (props: { id: 'map'; rect: Rect; className?: string; children?: ImageFlowNode }) => ImageFlowNode;
}) {
  const width = rect.width * cssPerMm, height = rect.height * cssPerMm;
  const earlier = !values.tracks.length && !!values.track;
  const tracks = readTracks(mapTracks(values));
  const view = { style: values.style, longitude: values.longitude, latitude: values.latitude, zoom: values.zoom };
  return <Element id="map" className="map" rect={rect}>
    <RenderedImage className="map-image" label="Map" inputs={{ ...view, width: rect.width, height: rect.height }} draw={(target) => drawMap(view, target)} />
    {tracks.some(({ points }) => points) && <svg className="map-track" viewBox={'0 0 ' + width.toFixed(1) + ' ' + height.toFixed(1)} preserveAspectRatio="none" aria-label="Route">
      {tracks.map(({ id, points, colour, label }) => points && <polyline key={id} points={projectTrack(points, values, width, height)}
        style={{ stroke: colour, strokeWidth: trackWidth * cssPerMm }}>{label && <title>{label}</title>}</polyline>)}
    </svg>}
    <span className="map-attribution">{mapAttribution}</span>
    {tracks.map(({ id, problem, track, label }, index) => problem && <span key={id} hidden {...issue({ code: 'gpx-invalid',
      message: (earlier ? '' : 'Track ' + (index + 1) + (label ? ' (' + label + ')' : '') + ': ') + problem + ' The track is left out.',
      element: 'map', parameter: earlier ? 'track' : 'tracks', file: track,
      suggestion: earlier ? 'Assign a GPX file that contains a track or route, or clear the GPX track.'
        : 'Assign a GPX file that contains a track or route to item ' + id + ' of tracks, or remove the item with remove_list_item.' })} />)}
    {earlier && <span hidden {...issue({ code: 'earlier-track', severity: 'warning', element: 'map', parameter: 'track', file: values.track,
      message: 'This map has a GPX track from before Tracks. It is drawn while Tracks is empty; add it to Tracks to give it a label or draw more tracks.',
      suggestion: 'insert_list_item into tracks with { track: "' + values.track + '", colour: "' + values.trackColor + '" }, then reset_parameter track and trackColor.' })} />}
  </Element>;
}

// The map's editor frames the view on the page itself (`presentation: 'inline'`): it is the element, at its printed
// size, so dragging and zooming show the composition as printed, with the track and attribution where the page draws
// them. It owns only the view; the tracks, style and line width are generated controls in the editor's toolbar, where
// the list of tracks is a "Tracks (n)" button opening the list. In the
// panel (the fallback, or when moved there) the same map is shown at the page's aspect ratio.
export function MapEditor({ values, set, readOnly, context, presentation, waitUntil, children }: MapEditorProps & { children?: ImageFlowNode }) {
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
  const tracks = readTracks(mapTracks(values));
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
    const current = readTracks(mapTracks(latest.current)).filter(({ points }) => points);
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
    const bounds = trackBounds(readTracks(mapTracks(latest.current)));
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
          container: holder.current, style: styleUrl(view.style), center: [view.longitude, view.latitude], zoom: editorZoom(view.zoom),
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
      created.once('idle', drawn);
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
  React.useEffect(() => { if (map.current?.isStyleLoaded()) drawTrack(map.current); }, [JSON.stringify(mapTracks(values)), values.trackWidth]);
  React.useEffect(() => { map.current?.setStyle(styleUrl(values.style)); }, [values.style]);
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
    {inline && <>{children}<span className="map-attribution">{mapAttribution}</span></>}
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
