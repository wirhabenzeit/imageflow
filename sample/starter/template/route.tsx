// The route inset of the Panorama layout: the track of a GPX file, drawn without a basemap, so export stays offline.
// Its editor chooses the file and frames part of the route.
import { Element, file, issue, p } from 'imageflow';
import type { ElementEditorProps, Rect, RenderView } from 'imageflow';

// Track points of a GPX file as [longitude, latitude]. ImageFlow only checks the extension; the content is ours.
function gpxPoints(text: string) {
  const xml = new DOMParser().parseFromString(text, 'application/xml');
  if (xml.querySelector('parsererror')) throw new Error('is not valid GPX');
  const points = Array.from(xml.querySelectorAll('trkpt, rtept')).map((node) => [Number(node.getAttribute('lon')), Number(node.getAttribute('lat'))]);
  if (points.length < 2 || points.some((point) => point.some((value) => !Number.isFinite(value)))) throw new Error('has no track');
  return points;
}

// The track as an SVG polyline in a 100 × 100 square (5 units of margin), north up, longitude scaled by latitude.
function routeLine(text: string) {
  const points = gpxPoints(text);
  const scale = Math.cos(points.reduce((sum, [, lat]) => sum + lat, 0) / points.length * Math.PI / 180);
  const xs = points.map(([lon]) => lon * scale);
  const ys = points.map(([, lat]) => -lat);
  const [minX, minY] = [Math.min(...xs), Math.min(...ys)];
  const size = Math.max(Math.max(...xs) - minX, Math.max(...ys) - minY) || 1;
  const offset = [(size - (Math.max(...xs) - minX)) / 2, (size - (Math.max(...ys) - minY)) / 2];
  return xs.map((x, i) => ((x - minX + offset[0]) / size * 90 + 5).toFixed(2) + ',' + ((ys[i] - minY + offset[1]) / size * 90 + 5).toFixed(2)).join(' ');
}

// The part of the route square the inset shows: `zoom` 1 is the whole route, centred on (centerX, centerY) in 0–1.
// The window is kept inside the square, so the centre is clamped the same way everywhere.
type Viewport = { centerX: number; centerY: number; zoom: number };
const maxRouteZoom = 8;
function routeWindow({ centerX, centerY, zoom }: Viewport) {
  const z = Math.min(maxRouteZoom, Math.max(1, zoom));
  const size = 1 / z;
  const clamp = (value: number) => Math.min(1 - size / 2, Math.max(size / 2, value));
  const round = (value: number) => Math.round(value * 10000) / 10000;
  return { centerX: round(clamp(centerX)), centerY: round(clamp(centerY)), zoom: round(z), size };
}
const viewBox = (viewport: Viewport) => {
  const { centerX, centerY, size } = routeWindow(viewport);
  return [(centerX - size / 2) * 100, (centerY - size / 2) * 100, size * 100, size * 100].map((value) => value.toFixed(3)).join(' ');
};

// An optional route inset: the track of the assigned GPX file, drawn without a basemap and framed by its viewport.
// Without a file it is an empty frame on the editing canvas (so it can be clicked) and nothing in thumbnails, layout
// previews or the printed book.
export function RouteMap({ track, viewport, view, rect }: { track: string; viewport: Viewport; view: RenderView; rect: Rect }) {
  const source = file(track);
  let line = '';
  let problem = '';
  if (source) {
    try {
      line = routeLine(source.text);
    } catch (error) {
      problem = source.name + ' ' + (error instanceof Error ? error.message : 'could not be read') + '; the route is left out.';
    }
  }
  // The Book check reports an unreadable track on the route element and its file parameter.
  const finding = problem ? issue({ code: 'gpx-invalid', message: problem, element: 'route', parameter: 'track', file: track,
    suggestion: 'Assign a GPX file that contains a track or route, or clear the GPX track.' }) : {};
  // The printed book leaves an unavailable route out, but still reports why.
  if (!line && view !== 'canvas') return problem ? <span hidden {...finding} /> : null;
  return <Element id="route" className={line ? 'route-map' : 'route-map empty'} rect={rect}>
    {line
      ? <svg viewBox={viewBox(viewport)} aria-label="Route"><polyline points={line} /></svg>
      : <span {...finding}>{problem ? 'Route unavailable' : 'Route map: add a GPX track'}</span>}
  </Element>;
}

// The route map's own editor: choose or import the GPX track with ImageFlow's file control, then drag to move,
// scroll or use the buttons to zoom, so the inset can show part of the route. Choosing the track and framing it is
// one task, so one editor owns all four parameters and applies changes while it stays open.
export const routeParameters = {
  track: p.file({ label: 'GPX track', accept: ['.gpx'] }),
  centerX: p.number({ label: 'Horizontal', default: .5, min: 0, max: 1, step: .01,
    description: 'Centre of the shown part of the route, across: 0 is the west edge of the route, 1 the east edge. Only takes effect when zoomed in (zoom above 1).' }),
  centerY: p.number({ label: 'Vertical', default: .5, min: 0, max: 1, step: .01,
    description: 'Centre of the shown part of the route, down: 0 is the north edge of the route, 1 the south edge. Only takes effect when zoomed in (zoom above 1).' }),
  zoom: p.number({ label: 'Zoom', default: 1, min: 1, max: maxRouteZoom, step: .1,
    description: 'Higher values zoom in. 1 shows the whole route; 2 shows half its width. To zoom out a bit, lower it.' }),
};
// Typed from the element's declaration: `set` and `Control` accept only these four parameters, with their value types.
type RouteEditorProps = ElementEditorProps<typeof routeParameters, 'track' | 'centerX' | 'centerY' | 'zoom'>;
let routeDrag: { x: number; y: number; start: Viewport; width: number } | undefined;
export function RouteEditor({ values, set, readOnly, Control }: RouteEditorProps) {
  const viewport = routeWindow(values);
  const source = file(values.track);
  let line = '';
  let problem = source ? '' : 'Choose a GPX track to draw the route.';
  if (source) {
    try {
      line = routeLine(source.text);
    } catch (error) {
      problem = source.name + ' ' + (error instanceof Error ? error.message : 'could not be read') + '.';
    }
  }
  const move = (next: Viewport) => {
    const { centerX, centerY, zoom } = routeWindow(next);
    set({ centerX, centerY, zoom });
  };
  const zoomBy = (factor: number) => move({ ...viewport, zoom: viewport.zoom * factor });
  const pan = (dx: number, dy: number) => move({ ...viewport, centerX: viewport.centerX + dx * viewport.size, centerY: viewport.centerY + dy * viewport.size });
  const track = <Control parameter="track" />;
  const editable = !readOnly && !!line;
  return <div className="route-editor">
    {track}
    <div className="route-editor-nav">
      <button type="button" aria-label="Zoom out" disabled={!editable || viewport.zoom <= 1} onClick={() => zoomBy(1 / 1.5)}>−</button>
      <button type="button" aria-label="Zoom in" disabled={!editable || viewport.zoom >= maxRouteZoom} onClick={() => zoomBy(1.5)}>+</button>
      <button type="button" disabled={!editable || viewport.zoom === 1} onClick={() => move({ centerX: .5, centerY: .5, zoom: 1 })}>Whole route</button>
      <span>{viewport.zoom > 1 ? 'Zoom ' + viewport.zoom.toFixed(1) + '×' : ''}</span>
    </div>
    <div className="route-editor-frame" role="application" aria-label="Route viewport" tabIndex={editable ? 0 : -1}
      onPointerDown={(event: PointerEvent) => {
        const frame = event.currentTarget as HTMLElement;
        if (!editable) return;
        frame.setPointerCapture(event.pointerId);
        routeDrag = { x: event.clientX, y: event.clientY, start: viewport, width: frame.clientWidth };
      }}
      onPointerMove={(event: PointerEvent) => {
        if (!routeDrag) return;
        const size = routeWindow(routeDrag.start).size;
        move({ ...routeDrag.start, centerX: routeDrag.start.centerX - (event.clientX - routeDrag.x) / routeDrag.width * size,
          centerY: routeDrag.start.centerY - (event.clientY - routeDrag.y) / routeDrag.width * size });
      }}
      onPointerUp={() => { routeDrag = undefined; }} onPointerCancel={() => { routeDrag = undefined; }}
      onWheel={(event: WheelEvent) => { if (editable) zoomBy(Math.exp(-event.deltaY * .002)); }}
      onKeyDown={(event: KeyboardEvent) => {
        const steps: Record<string, [number, number]> = { ArrowLeft: [-.1, 0], ArrowRight: [.1, 0], ArrowUp: [0, -.1], ArrowDown: [0, .1] };
        const step = Object.hasOwn(steps, event.key) ? steps[event.key] : undefined;
        if (!editable || !step) return;
        event.preventDefault();
        pan(step[0], step[1]);
      }}>
      <svg viewBox={viewBox(viewport)} aria-hidden="true"><polyline points={line} /></svg>
    </div>
    <p className="route-editor-note" role="status">{problem}</p>
  </div>;
}
