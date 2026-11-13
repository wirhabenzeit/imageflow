// A real map page (ADR 0006). The page draws the map live with MapLibre GL and OpenFreeMap styles through
// <RenderedImage>: at screen resolution in the editor, and again at the format's target resolution when the book is
// exported. The GPX track lies on top as vector lines, with the map's attribution. Only the map's settings are saved
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
  track: p.file({ label: 'GPX track', accept: ['.gpx'] }),
  style: p.enum({ label: 'Map style', default: 'liberty', options: styles }),
  longitude: p.number({ label: 'Longitude', default: 17.75, min: -180, max: 180, step: .00001 }),
  latitude: p.number({ label: 'Latitude', default: 69.35, min: -85, max: 85, step: .00001 }),
  // The MapLibre zoom of the printed map: its width in CSS pixels is the element's width at 96 per inch.
  zoom: p.number({ label: 'Zoom', default: 8.5, min: 0, max: 18, step: .01 }),
  trackColor: p.color({ label: 'Track colour', default: '#c8432b' }),
  trackWidth: p.number({ label: 'Track width', default: 1, min: .3, max: 3, step: .1, unit: 'mm' }),
};
export const mapEditorParameters = ['track', 'style', 'longitude', 'latitude', 'zoom'] as const;
type MapValues = { track: string; style: MapStyle; longitude: number; latitude: number; zoom: number };
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
function projectTrack(points: number[][], values: MapValues, width: number, height: number) {
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

/** The map as the page draws it: the map picture, the track over it, and the attribution. */
export function MapView({ values, trackColor, trackWidth, rect, Element }: {
  values: MapValues; trackColor: string; trackWidth: number; rect: Rect;
  Element: (props: { id: 'map'; rect: Rect; className?: string; children?: ImageFlowNode }) => ImageFlowNode;
}) {
  const width = rect.width * cssPerMm, height = rect.height * cssPerMm;
  const { points, problem } = readTrack(values.track);
  const view = { style: values.style, longitude: values.longitude, latitude: values.latitude, zoom: values.zoom };
  return <Element id="map" className="map" rect={rect}>
    <RenderedImage className="map-image" label="Map" inputs={{ ...view, width: rect.width, height: rect.height }} draw={(target) => drawMap(view, target)} />
    {points && <svg className="map-track" viewBox={'0 0 ' + width.toFixed(1) + ' ' + height.toFixed(1)} preserveAspectRatio="none" aria-label="Route">
      <polyline points={projectTrack(points, values, width, height)} style={{ stroke: trackColor, strokeWidth: trackWidth * cssPerMm }} />
    </svg>}
    <span className="map-attribution">{mapAttribution}</span>
    {problem && <span hidden {...issue({ code: 'gpx-invalid', message: problem + ' The track is left out.', element: 'map', parameter: 'track',
      file: values.track, suggestion: 'Assign a GPX file that contains a track or route, or clear the GPX track.' })} />}
  </Element>;
}

export function MapEditor({ values, set, readOnly, Control, context }: MapEditorProps) {
  const holder = React.useRef<HTMLDivElement>(null);
  const map = React.useRef<MapLibreMap>(undefined);
  const latest = React.useRef(values);
  latest.current = values;
  const [state, setState] = React.useState<{ error?: string }>({});
  const measured = context.elements.map.rect;
  // Keep an existing map stable while the book redraws, but never invent its first output size.
  const lastRect = React.useRef(measured);
  if (measured) lastRect.current = measured;
  const rect = measured ?? lastRect.current;
  const printWidth = (rect?.width ?? 0) * cssPerMm;
  const width = React.useRef(printWidth);
  width.current = printWidth;
  const { points, problem } = readTrack(values.track);
  // The editor map is smaller than the print, so it shows the same area at a lower zoom.
  const editorZoom = (zoom: number) => zoom - Math.log2(width.current / (holder.current?.clientWidth || width.current));

  React.useEffect(() => {
    if (!rect) return;
    let removed = false;
    void loadMapLibre().then((maplibregl) => {
      if (removed || !holder.current) return;
      const view = latest.current;
      const created = new maplibregl.Map({
        container: holder.current, style: styleUrl(view.style), center: [view.longitude, view.latitude], zoom: editorZoom(view.zoom),
        interactive: !readOnly, attributionControl: { compact: true }, dragRotate: false, pitchWithRotate: false, touchPitch: false,
      });
      created.touchZoomRotate.disableRotation();
      created.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
      created.on('moveend', (event) => {
        // Only the user's own moves change the saved view.
        if (!('originalEvent' in event) || !event.originalEvent || readOnly) return;
        const center = created.getCenter();
        const round = (value: number, digits: number) => Number(value.toFixed(digits));
        set({ longitude: round(center.lng, 5), latitude: round(center.lat, 5),
          zoom: round(Math.min(18, Math.max(0, created.getZoom() + Math.log2(width.current / created.getContainer().clientWidth))), 2) });
      });
      created.on('error', (event) => {
        if (!created.isStyleLoaded()) setState({ error: 'The map could not load (' + (event.error?.message ?? 'no connection') + '). It needs ' +
          mapOrigin + ': close the editor, open it again and choose Allow when asked.' });
      });
      created.on('style.load', () => drawTrack(created));
      map.current = created;
    }, (error: unknown) => setState({ error: 'The map library could not load: ' + String(error) }));
    return () => { removed = true; map.current?.remove(); map.current = undefined; };
  }, [!!rect, readOnly]);
  React.useEffect(() => {
    const current = map.current;
    if (!current || !rect) return;
    current.resize();
    current.jumpTo({ center: [latest.current.longitude, latest.current.latitude], zoom: editorZoom(latest.current.zoom) });
  }, [rect?.width, rect?.height]);

  // The track as a line on the editor map; redrawn when the style or the track changes.
  const drawTrack = (target: MapLibreMap) => {
    const { points: current } = readTrack(latest.current.track);
    const data = { type: 'Feature' as const, properties: {}, geometry: { type: 'LineString' as const, coordinates: current ?? [] } };
    const source = target.getSource('track') as { setData?: (value: typeof data) => void } | undefined;
    if (source?.setData) { source.setData(data); return; }
    target.addSource('track', { type: 'geojson', data });
    target.addLayer({ id: 'track', type: 'line', source: 'track', layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#c8432b', 'line-width': 3 } });
  };
  React.useEffect(() => { if (map.current?.isStyleLoaded()) drawTrack(map.current); }, [values.track]);
  React.useEffect(() => { map.current?.setStyle(styleUrl(values.style)); }, [values.style]);

  const fitTrack = () => {
    if (!points || !map.current) return;
    const lngs = points.map(([lng]) => lng), lats = points.map(([, lat]) => lat);
    map.current.fitBounds([[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]], { padding: 40, animate: false });
    const center = map.current.getCenter();
    set({ longitude: Number(center.lng.toFixed(5)), latitude: Number(center.lat.toFixed(5)),
      zoom: Number(Math.min(18, map.current.getZoom() + Math.log2(printWidth / map.current.getContainer().clientWidth)).toFixed(2)) });
  };
  return <div className="map-editor">
    <Control parameter="track" />
    {problem && <p className="map-editor-note error">{problem}</p>}
    <div className="map-editor-styles" role="radiogroup" aria-label="Map style">
      {(Object.keys(styles) as MapStyle[]).map((style) => <button key={style} type="button" role="radio" aria-checked={values.style === style}
        disabled={readOnly} onClick={() => set({ style })}>{styles[style]}</button>)}
      <button type="button" disabled={readOnly || !points} onClick={fitTrack}>Fit track</button>
    </div>
    <div ref={holder} className="map-editor-map" role="application" aria-label="Map view"
      data-output-width={measured?.width} data-output-height={measured?.height}
      style={rect ? { aspectRatio: (rect.width / rect.height).toFixed(4) } : undefined} />
    <p className={'map-editor-note' + (state.error ? ' error' : '')} role="status">
      {state.error ?? (!measured ? 'Waiting for the page layout…' : 'Drag and zoom to frame the page. The page draws this view, and export draws it again at print resolution.')}
    </p>
    <p className="map-editor-note">{mapAttribution}</p>
  </div>;
}
