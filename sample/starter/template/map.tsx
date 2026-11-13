// A real map page (ADR 0006). The editor shows a MapLibre map with OpenFreeMap styles: drag, scroll and the
// buttons frame it, and Update print map renders the view at print resolution and saves it into the book with
// saveFile. The page draws that saved image, the GPX track on top as vector lines, and the map's attribution, so
// printing never needs the network.
import React from 'react';
import { file, geometry, imageFile, issue, p } from 'imageflow';
import type { ElementEditorProps, ImageFlowNode, Rect, ResolvedFormat } from 'imageflow';
import type { Map as MapLibreMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

export const mapOrigin = 'https://tiles.openfreemap.org';
const styles = { liberty: 'Liberty', bright: 'Bright', positron: 'Positron' } as const;
type MapStyle = keyof typeof styles;
const styleUrl = (style: MapStyle) => mapOrigin + '/styles/' + style;
export const mapAttribution = '© OpenFreeMap © OpenMapTiles © OpenStreetMap contributors';

export const mapParameters = {
  track: p.file({ label: 'GPX track', accept: ['.gpx'] }),
  style: p.enum({ label: 'Map style', default: 'liberty', options: ['liberty', 'bright', 'positron'], labels: styles }),
  longitude: p.number({ label: 'Longitude', default: 17.75, min: -180, max: 180, step: .00001 }),
  latitude: p.number({ label: 'Latitude', default: 69.35, min: -85, max: 85, step: .00001 }),
  // The MapLibre zoom of the printed map: its width in CSS pixels is the element's width at 96 per inch.
  zoom: p.number({ label: 'Zoom', default: 8.5, min: 0, max: 18, step: .01 }),
  trackColor: p.color({ label: 'Track colour', default: '#c8432b' }),
  trackWidth: p.number({ label: 'Track width', default: 1, min: .3, max: 3, step: .1, unit: 'mm' }),
  // The saved print image and the view it shows; set together by Update print map.
  snapshot: p.file({ label: 'Print map', accept: ['.png', '.jpg'] }),
  snapshotView: p.string({ label: 'Print map view', default: '', maxLength: 200 }),
};
export const mapEditorParameters = ['track', 'style', 'longitude', 'latitude', 'zoom', 'snapshot', 'snapshotView'] as const;
type MapValues = { track: string; style: MapStyle; longitude: number; latitude: number; zoom: number; snapshot: string; snapshotView: string };
export type MapEditorProps = ElementEditorProps<typeof mapParameters, typeof mapEditorParameters[number]>;

const cssPerMm = 96 / 25.4;
// The map's area: the whole spread with its bleed.
export const mapRect = (format: ResolvedFormat) => geometry.spread(format, 'bleed');
// What the print image shows; it is outdated when any of this changes, including the format's size.
const viewKey = (values: MapValues, rect: Rect) => [values.style, values.longitude.toFixed(5), values.latitude.toFixed(5), values.zoom.toFixed(2),
  rect.width.toFixed(1) + 'x' + rect.height.toFixed(1)].join(' ');

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

/** The track in the element's CSS pixels, for the same view the print image shows. */
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

/** The map as the page draws it: the saved print image, the track over it, and the attribution. */
export function MapView({ values, trackColor, trackWidth, rect, mode, Element }: {
  values: MapValues; trackColor: string; trackWidth: number; rect: Rect; mode: 'edit' | 'export';
  Element: (props: { id: 'map'; rect: Rect; className?: string; children?: ImageFlowNode }) => ImageFlowNode;
}) {
  const image = imageFile(values.snapshot);
  const width = rect.width * cssPerMm, height = rect.height * cssPerMm;
  const { points, problem } = readTrack(values.track);
  const findings = [
    problem && issue({ code: 'gpx-invalid', message: problem + ' The track is left out.', element: 'map', parameter: 'track', file: values.track,
      suggestion: 'Assign a GPX file that contains a track or route, or clear the GPX track.' }),
    !image && issue({ code: 'map-not-generated', severity: 'error', message: 'The map has no print image yet.', element: 'map', parameter: 'snapshot',
      suggestion: 'Open the map editor and choose Update print map.' }),
    image && values.snapshotView !== viewKey(values, rect) && issue({ code: 'map-outdated', message: 'The print image shows an earlier view of the map.',
      element: 'map', parameter: 'snapshot', suggestion: 'Open the map editor and choose Update print map.' }),
  ].filter((finding) => !!finding);
  return <Element id="map" className="map" rect={rect}>
    {image ? <img className="map-image" src={image.url} alt="" />
      : mode === 'edit' && <span className="map-empty">Map: click to place it, then choose Update print map</span>}
    {points && <svg className="map-track" viewBox={'0 0 ' + width.toFixed(1) + ' ' + height.toFixed(1)} preserveAspectRatio="none" aria-label="Route">
      <polyline points={projectTrack(points, values, width, height)} style={{ stroke: trackColor, strokeWidth: trackWidth * cssPerMm }} />
    </svg>}
    <span className="map-attribution">{mapAttribution}</span>
    {findings.map((finding, i) => <span key={i} hidden {...finding} />)}
  </Element>;
}

type MapLibre = typeof import('maplibre-gl');
// MapLibre is loaded only when an editor opens, so book pages never evaluate it. Its package is CommonJS, so the
// bundle exposes it as the default export.
const loadMapLibre = () => import('maplibre-gl').then((module) => ((module as { default?: MapLibre }).default ?? module) as MapLibre);

/** Renders the view off screen at the print size and resolution and returns it as an image. */
async function printImage(maplibregl: MapLibre, values: MapValues, rect: Rect, dpi: number) {
  const width = Math.round(rect.width * cssPerMm), height = Math.round(rect.height * cssPerMm);
  const holder = document.createElement('div');
  holder.style.cssText = 'position:fixed;left:-20000px;top:0;width:' + width + 'px;height:' + height + 'px;';
  document.body.append(holder);
  const map = new maplibregl.Map({
    container: holder, style: styleUrl(values.style), center: [values.longitude, values.latitude], zoom: values.zoom,
    interactive: false, attributionControl: false, fadeDuration: 0, pixelRatio: dpi / 96, maxCanvasSize: [16384, 16384],
    canvasContextAttributes: { preserveDrawingBuffer: true },
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The map did not finish loading within a minute.')), 60_000);
      map.once('idle', () => { clearTimeout(timer); resolve(); });
      map.on('error', (event) => { if (!map.loaded()) { clearTimeout(timer); reject(event.error ?? new Error('The map could not load.')); } });
    });
    const canvas = map.getCanvas();
    let blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    let name = 'map.png';
    // Very large maps are saved as JPEG to stay well inside the book's file size limit.
    if (blob && blob.size > 40_000_000) {
      blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', .92));
      name = 'map.jpg';
    }
    if (!blob) throw new Error('The map image could not be created.');
    return { blob, name, pixels: canvas.width + ' × ' + canvas.height };
  } finally {
    map.remove();
    holder.remove();
  }
}

export function MapEditor({ values, set, readOnly, Control, saveFile, format }: MapEditorProps) {
  const holder = React.useRef<HTMLDivElement>(null);
  const map = React.useRef<MapLibreMap>(undefined);
  const latest = React.useRef(values);
  latest.current = values;
  const [state, setState] = React.useState<{ busy?: boolean; note?: string; error?: string }>({});
  const rect = mapRect(format);
  const printWidth = rect.width * cssPerMm;
  const { points, problem } = readTrack(values.track);
  // The editor map is smaller than the print, so it shows the same area at a lower zoom.
  const editorZoom = (zoom: number) => zoom - Math.log2(printWidth / (holder.current?.clientWidth || printWidth));

  React.useEffect(() => {
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
          zoom: round(Math.min(18, Math.max(0, created.getZoom() + Math.log2(printWidth / created.getContainer().clientWidth))), 2) });
      });
      created.on('error', (event) => {
        if (!created.isStyleLoaded()) setState({ error: 'The map could not load (' + (event.error?.message ?? 'no connection') + '). It needs ' +
          mapOrigin + ': close the editor, open it again and choose Allow when asked.' });
      });
      created.on('style.load', () => drawTrack(created));
      map.current = created;
    }, (error: unknown) => setState({ error: 'The map library could not load: ' + String(error) }));
    return () => { removed = true; map.current?.remove(); map.current = undefined; };
  }, []);

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
  const update = async () => {
    setState({ busy: true, note: 'Rendering the print map…' });
    try {
      const view = latest.current;
      const dpi = format.resolution?.target ?? 300;
      const { blob, name, pixels } = await printImage(await loadMapLibre(), view, rect, dpi);
      const id = await saveFile(blob, { name });
      if (!id) throw new Error('The book did not save the map.');
      set({ snapshot: id, snapshotView: viewKey(view, rect) });
      setState({ note: 'Print map updated: ' + pixels + ' pixels at ' + dpi + ' ppi.' });
    } catch (error) {
      setState({ error: error instanceof Error ? error.message : String(error) });
    }
  };
  const outdated = values.snapshotView !== viewKey(values, rect);
  return <div className="map-editor">
    <Control parameter="track" />
    {problem && <p className="map-editor-note error">{problem}</p>}
    <div className="map-editor-styles" role="radiogroup" aria-label="Map style">
      {(Object.keys(styles) as MapStyle[]).map((style) => <button key={style} type="button" role="radio" aria-checked={values.style === style}
        disabled={readOnly} onClick={() => set({ style })}>{styles[style]}</button>)}
      <button type="button" disabled={readOnly || !points} onClick={fitTrack}>Fit track</button>
    </div>
    <div ref={holder} className="map-editor-map" role="application" aria-label="Map view"
      style={{ aspectRatio: (rect.width / rect.height).toFixed(4) }} />
    <div className="map-editor-actions">
      <button type="button" className="primary" disabled={readOnly || state.busy} onClick={() => void update()}>Update print map</button>
      <span className={'map-editor-note' + (state.error ? ' error' : '')} role="status">
        {state.error ?? state.note ?? (outdated ? 'The printed map does not show this view yet.' : 'The printed map shows this view.')}
      </span>
    </div>
    <p className="map-editor-note">{mapAttribution}</p>
  </div>;
}
