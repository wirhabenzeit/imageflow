// The starter's map styles. The book styles are drawn for print from OpenFreeMap's OpenMapTiles vector tiles: one set
// of layers, quieter than a navigation map (no icons, few roads at low zooms, place names set in the book's fonts), in
// four palettes. The standard styles are OpenFreeMap's own. All of them render to SVG through maplibre-svg; MapLibre
// needs the styles' glyphs only to place labels, which the page then sets in its own fonts.
//
// The Book style follows the book's colour theme: its SVG names each colour by its role in the palette, as a CSS
// variable (var(--map-water, …)), and the map element sets the variables from the theme's palette, Paper in the light
// theme and Night in the dark one. Changing the theme recolours the drawn map without drawing it again.
import type { StyleSpecification } from 'maplibre-gl';
import mlcontour from 'maplibre-contour';
import { describeLoadError } from './map-errors';

export const mapOrigin = 'https://tiles.openfreemap.org';
const mapAttribution = '© OpenFreeMap © OpenMapTiles © OpenStreetMap contributors';
// Elevation for contour lines: Mapterhorn's open terrain tiles (Copernicus GLO-30 worldwide to zoom 12, finer national
// data in places), terrarium-encoded, public and without a key. maplibre-contour turns them into contour lines as
// vector tiles inside MapLibre, so they print as paths like the rest of the map.
export const elevationOrigin = 'https://tiles.mapterhorn.com';
const elevationAttribution = '© Mapterhorn';
// Decoded on the page rather than in a worker: a map is drawn once, off screen.
const elevation = new mlcontour.DemSource({ url: elevationOrigin + '/{z}/{x}/{y}.webp', encoding: 'terrarium', maxzoom: 12, worker: false });
// Mapterhorn has no tile where it has no elevation data, such as the open sea, and answers 404 there. That is sea
// level, not a failure: a contour tile is made from a tile and its eight neighbours, so one missing neighbour would
// otherwise fail the contours of the land beside it, and the whole map with them.
type TileResponse = { data: Blob; expires?: string; cacheControl?: string };
let seaLevel: Promise<Blob> | undefined;
// A terrarium tile of 0 m everywhere: red 128, green 0, blue 0. At the source's 512-pixel tile size, so it lines up
// with its neighbours.
const seaLevelTile = () => seaLevel ??= (() => {
  const canvas = new OffscreenCanvas(512, 512);
  const context = canvas.getContext('2d')!;
  context.fillStyle = 'rgb(128, 0, 0)';
  context.fillRect(0, 0, 512, 512);
  return canvas.convertToBlob({ type: 'image/png' });
})();
const elevationManager = elevation.manager as unknown as { getTile: (url: string, controller: AbortController) => Promise<TileResponse> };
elevationManager.getTile = async (url, controller) => {
  const response = await fetch(url, { signal: controller.signal });
  if (response.status === 404) return { data: await seaLevelTile() };
  if (!response.ok) throw new Error('Bad response: ' + response.status + ' for ' + url);
  return { data: await response.blob(), expires: response.headers.get('expires') ?? undefined,
    cacheControl: response.headers.get('cache-control') ?? undefined };
};
let prepared = false;
/** Lets MapLibre load contour tiles; call it with the MapLibre module before making a map. */
export function prepareMapLibre(maplibre: { addProtocol: (id: string, protocol: never) => void }) {
  if (prepared) return;
  prepared = true;
  elevation.setupMaplibre(maplibre as Parameters<typeof elevation.setupMaplibre>[0]);
}

/** What went wrong loading a map, naming the site that failed (map-errors.ts). */
export const describeMapError = (error: unknown) => describeLoadError(error, {
  [mapOrigin]: 'OpenFreeMap (map tiles)', [elevationOrigin]: 'Mapterhorn (elevation for contour lines)' });
/** Whether the style draws contour lines. */
export const hasContours = (style: MapStyle) => style === 'lines';
/** The credits of a map's data in a style, for a layout's `credits`: the book prints them on its last page. */
export const mapCredits = (style: MapStyle) => [
  { id: 'openstreetmap', text: 'Map data © OpenStreetMap contributors', url: 'https://www.openstreetmap.org/copyright' },
  { id: 'openfreemap', text: 'Map tiles © OpenFreeMap © OpenMapTiles', url: 'https://openfreemap.org' },
  ...(hasContours(style) ? [{ id: 'mapterhorn', text: 'Elevation © Mapterhorn', url: 'https://mapterhorn.com/attribution' }] : []),
];

type Palette = {
  background: string; water: string; waterway: string; boundary: string;
  wood?: string; grass?: string; wetland?: string; ice?: string; sand?: string; urban?: string; park?: string; building?: string;
  major: string; road: string; minor: string; rail: string; casing?: string;
  label: string; place: string; waterLabel: string; halo: string;
  // The outline of lakes and seas, as a line; and the water's fill opacity, for a map that is mostly lines.
  shore?: string; waterOpacity?: number;
  // Contour lines of the terrain, minor and every fifth (major) thicker.
  contour?: string;
  // A thinner, lighter map overall, such as line art.
  weight?: number;
};

const palettes = {
  paper: { background: '#f5f1e8', water: '#cbd9d6', waterway: '#a7c0c0', boundary: '#a89b88', wood: '#e3e2cb', ice: '#fbfaf6',
    urban: '#ece5d7', park: '#e6e3cc', building: '#e5dccb', major: '#c8b89f', road: '#d4c7b2', minor: '#ddd4c4', rail: '#bdb2a1',
    label: '#5a5247', place: '#2f2b25', waterLabel: '#5b7c7c', halo: '#f5f1e8' },
  ink: { background: '#ffffff', water: '#e7e7e4', waterway: '#8c8c88', boundary: '#3c3c3a', major: '#2a2a28', road: '#4a4a46',
    minor: '#8a8a84', rail: '#5a5a56', building: '#ededea', label: '#262624', place: '#111110', waterLabel: '#55554f', halo: '#ffffff', weight: .75 },
  atlas: { background: '#f2efe6', water: '#a7c8dc', waterway: '#8db5cf', boundary: '#9b7fa6', wood: '#cfdcb8', grass: '#e0e8cb',
    wetland: '#d6e3d6', ice: '#eaf1f4', sand: '#efe6c8', urban: '#e7e1d6', park: '#d3e2bd', building: '#ddd5c7', major: '#e3a35f',
    road: '#f0c27b', minor: '#ffffff', casing: '#cfc6b6', rail: '#9a948a', label: '#3a3833', place: '#1f1d1a', waterLabel: '#3f6e8c', halo: '#f2efe6' },
  night: { background: '#1b1c1a', water: '#2e3d47', waterway: '#3d5361', boundary: '#6d6a74', wood: '#242b2a', ice: '#2a2f33',
    urban: '#282c2f', park: '#252d2b', building: '#2c3134', major: '#7a7466', road: '#5e5c58', minor: '#45474a', rail: '#55575a',
    label: '#c9c3b6', place: '#ece6d8', waterLabel: '#8fb0bf', halo: '#1b1c1a' },
} satisfies Record<string, Palette>;

type Role = Exclude<keyof Palette, 'weight' | 'waterOpacity'>;
export type ColourTheme = 'light' | 'dark';
// The styles that follow the book's colour theme: their palette in each theme (with real colours, for the editor's
// live map and for laying out the drawn map), and the page's own colour variables that some roles take in the SVG.
// Lines is a map of lines in the page's own colours, after the quiet contour maps of a travel book: the terrain's
// contour lines in the page's rule colour, shores, rivers, roads and borders in its ink, muted and accent colours, and
// water as a faint wash of the rule colour.
const lineRoles = { background: '--paper', water: '--rule', shore: '--muted', contour: '--rule', waterway: '--muted', boundary: '--accent',
  major: '--ink', road: '--muted', minor: '--rule', rail: '--muted', label: '--muted', place: '--ink', waterLabel: '--muted', halo: '--paper' } as const;
const lines = (page: Record<'paper' | 'ink' | 'muted' | 'rule' | 'accent', string>): Palette => ({ waterOpacity: .45, weight: .7,
  ...Object.fromEntries(Object.entries(lineRoles).map(([role, variable]) => [role, page[variable.slice(2) as keyof typeof page]])) as Omit<Palette, 'weight' | 'waterOpacity'> });
const themed = {
  book: { light: palettes.paper, dark: palettes.night, page: { background: '--paper', halo: '--paper' } as Partial<Record<Role, string>> },
  // The starter's light and dark theme colours (styles.css).
  lines: { light: lines({ paper: '#f5f1e8', ink: '#1f2b25', muted: '#66706a', rule: '#cfc7b5', accent: '#9b6a3c' }),
    dark: lines({ paper: '#1b1c1a', ink: '#ece6da', muted: '#a39e93', rule: '#45433d', accent: '#d4aa6c' }), page: lineRoles as Partial<Record<Role, string>> },
};
type Themed = keyof typeof themed;
const isThemed = (style: string): style is Themed => style in themed;

export const mapStyles = {
  book: 'Book (follows the colour theme)', lines: 'Lines (follows the colour theme)', paper: 'Paper', ink: 'Ink', atlas: 'Atlas', night: 'Night',
  liberty: 'Liberty (OpenFreeMap)', bright: 'Bright (OpenFreeMap)', positron: 'Positron (OpenFreeMap)',
} as const;
export type MapStyle = keyof typeof mapStyles;

/**
 * The style for the map, as MapLibre takes it: a book style's specification or a standard style's URL. A style that
 * follows the colour theme is its palette in that theme, with real colours.
 */
export function mapStyle(style: MapStyle, theme: ColourTheme = 'light'): string | StyleSpecification {
  if (isThemed(style)) return bookStyle(themed[style][theme]).style;
  return style in palettes ? bookStyle(palettes[style as keyof typeof palettes]).style : mapOrigin + '/styles/' + style;
}

const cssName = (role: Role) => '--map-' + role.replace(/[A-Z]/g, (char) => '-' + char.toLowerCase());
const themedRoles: Partial<Record<Themed, Record<string, Record<string, Role>>>> = {};
/**
 * For maplibre-svg's `color`: a theme-following style's colours as the CSS variables of their roles, with the light
 * colour as fallback. Other styles keep their colours.
 */
export function mapColor(style: MapStyle) {
  if (!isThemed(style)) return undefined;
  const roles = themedRoles[style] ??= bookStyle(themed[style].light).roles;
  return (color: string, { layer, property }: { layer: { id: string }; property: string }) => {
    const role = roles[layer.id]?.[property];
    return role ? 'var(' + cssName(role) + ', ' + color + ')' : color;
  };
}
/**
 * The CSS variables that colour a theme-following map in the theme, for the map element's style: the roles the page
 * colours take from the page's own variables (so the Book map's ground is the page's paper, and a map that does not
 * fill the page sits on it without an edge), the others from the theme's palette.
 */
export function mapThemeColors(style: MapStyle, theme: ColourTheme) {
  if (!isThemed(style)) return undefined;
  const { page } = themed[style];
  return Object.fromEntries(Object.entries(themed[style][theme]).filter(([role]) => role !== 'weight' && role !== 'waterOpacity')
    .map(([role, value]) => [cssName(role as Role), page[role as Role] ? 'var(' + page[role as Role] + ', ' + value + ')' : String(value)]));
}

// Label fonts: MapLibre's font stacks name the role; the page sets each role in a font of the book (see labelFont).
const fontFor = { place: ['Noto Sans Bold'], water: ['Noto Sans Italic'], plain: ['Noto Sans Regular'] };
const name = ['coalesce', ['get', 'name:latin'], ['get', 'name']];
const zoomed = (...stops: number[]) => ['interpolate', ['exponential', 1.4], ['zoom'], ...stops];
const is = (key: string, ...values: string[]) => ['match', ['get', key], values, true, false];

/** A book style in a palette, and the palette role of each layer's colours. */
function bookStyle(p: Palette) {
  const w = p.weight ?? 1;
  const width = (...stops: number[]) => zoomed(...stops.map((value, i) => i % 2 ? value * w : value));
  const source = 'openmaptiles';
  const roles: Record<string, Record<string, Role>> = {};
  // A layer is drawn only when the palette has its colour.
  const fill = (id: string, layer: string, role: Role, extra: object = {}) => p[role] ? [(roles[id] = { 'fill-color': role }, { id, type: 'fill', source, 'source-layer': layer,
    paint: { 'fill-color': p[role], 'fill-antialias': false }, ...extra })] : [];
  const line = (id: string, layer: string, role: Role, lineWidth: unknown, extra: { filter?: unknown; minzoom?: number; dash?: number[]; cap?: string } = {}) => p[role] ? [(roles[id] = { 'line-color': role }, {
    id, type: 'line', source, 'source-layer': layer, ...(extra.filter ? { filter: extra.filter } : {}), ...(extra.minzoom ? { minzoom: extra.minzoom } : {}),
    layout: { 'line-cap': extra.cap ?? 'round', 'line-join': 'round' },
    paint: { 'line-color': p[role], 'line-width': lineWidth, ...(extra.dash ? { 'line-dasharray': extra.dash } : {}) } })] : [];
  const label = (id: string, layer: string, font: string[], role: Role, size: unknown, extra: Record<string, unknown> = {}) => [(roles[id] = { 'text-color': role, 'text-halo-color': 'halo' }, {
    id, type: 'symbol', source, 'source-layer': layer, ...(extra.filter ? { filter: extra.filter } : {}), ...(extra.minzoom ? { minzoom: extra.minzoom } : {}),
    ...(extra.maxzoom ? { maxzoom: extra.maxzoom } : {}),
    layout: { 'text-field': name, 'text-font': font, 'text-size': size, 'text-max-width': 8, ...(extra.layout ?? {}) },
    paint: { 'text-color': p[role], 'text-halo-color': p.halo, 'text-halo-width': 1.4, ...(extra.paint ?? {}) } })];
  const roads = (classes: string[]) => is('class', ...classes);
  const layers = [
    (roles.background = { 'background-color': 'background' }, { id: 'background', type: 'background', paint: { 'background-color': p.background } }),
    ...fill('wood', 'landcover', 'wood', { filter: is('class', 'wood', 'forest') }),
    ...fill('grass', 'landcover', 'grass', { filter: is('class', 'grass', 'farmland') }),
    ...fill('wetland', 'landcover', 'wetland', { filter: is('class', 'wetland') }),
    ...fill('sand', 'landcover', 'sand', { filter: is('class', 'sand') }),
    ...fill('ice', 'landcover', 'ice', { filter: is('class', 'ice') }),
    ...fill('urban', 'landuse', 'urban', { filter: is('class', 'residential', 'suburb', 'neighbourhood', 'commercial', 'industrial'), minzoom: 9 }),
    ...fill('park', 'park', 'park'),
    ...(p.contour ? [(roles.contours = { 'line-color': 'contour' }, { id: 'contours', type: 'line', source: 'contours', 'source-layer': 'contours',
      filter: ['==', ['get', 'level'], 0], layout: { 'line-join': 'round' }, paint: { 'line-color': p.contour, 'line-width': .35 } }),
    (roles['contours-major'] = { 'line-color': 'contour' }, { id: 'contours-major', type: 'line', source: 'contours', 'source-layer': 'contours',
      filter: ['>', ['get', 'level'], 0], layout: { 'line-join': 'round' }, paint: { 'line-color': p.contour, 'line-width': .8 } })] : []),
    ...fill('water', 'water', 'water', { filter: ['!=', ['get', 'brunnel'], 'tunnel'], ...(p.waterOpacity ? { paint: { 'fill-color': p.water, 'fill-opacity': p.waterOpacity, 'fill-antialias': false } } : {}) }),
    ...line('shore', 'water', 'shore', width(4, .35, 10, .7, 14, 1.1), { filter: ['!=', ['get', 'brunnel'], 'tunnel'] }),
    ...line('river', 'waterway', 'waterway', width(8, .5, 11, 1.2, 14, 2.6), { filter: is('class', 'river') }),
    ...line('stream', 'waterway', 'waterway', width(11, .3, 14, 1), { filter: is('class', 'stream', 'canal'), minzoom: 11 }),
    ...fill('building', 'building', 'building', { minzoom: 14 }),
    ...line('boundary-state', 'boundary', 'boundary', width(4, .4, 10, .8), { filter: ['all', ['==', ['get', 'admin_level'], 4], ['!=', ['get', 'maritime'], 1]], minzoom: 4, dash: [3, 2] }),
    ...line('boundary-country', 'boundary', 'boundary', width(2, .6, 10, 1.4), { filter: ['all', ['==', ['get', 'admin_level'], 2], ['!=', ['get', 'maritime'], 1]], dash: [4, 2, 1, 2] }),
    ...line('rail', 'transportation', 'rail', width(9, .3, 14, 1.2), { filter: roads(['rail']), minzoom: 9, dash: [3, 2], cap: 'butt' }),
    ...line('path', 'transportation', 'minor', width(13, .4, 16, 1), { filter: roads(['path', 'track']), minzoom: 13, dash: [2, 1.5] }),
    ...(p.casing ? line('road-casing', 'transportation', 'casing', width(11, 1.4, 14, 5), { filter: roads(['minor', 'service', 'tertiary']), minzoom: 11 }) : []),
    ...line('road-minor', 'transportation', 'minor', width(10, .3, 14, 3), { filter: roads(['minor', 'service', 'tertiary']), minzoom: 10 }),
    ...line('road', 'transportation', 'road', width(7, .3, 10, .9, 14, 4), { filter: roads(['primary', 'secondary']), minzoom: 7 }),
    ...line('road-major', 'transportation', 'major', width(5, .4, 10, 1.5, 14, 5), { filter: roads(['motorway', 'trunk']), minzoom: 5 }),
    ...label('road-names', 'transportation_name', fontFor.plain, 'label', 10, { minzoom: 13, layout: { 'symbol-placement': 'line' } }),
    ...label('river-names', 'waterway', fontFor.water, 'waterLabel', 11, { filter: is('class', 'river'), minzoom: 10, layout: { 'symbol-placement': 'line' } }),
    // Lakes and seas are named at a point or along a line through their middle.
    ...label('water-names', 'water_name', fontFor.water, 'waterLabel', zoomed(4, 11, 10, 14), { filter: ['==', ['geometry-type'], 'Point'],
      layout: { 'text-letter-spacing': .05 } }),
    ...label('water-names-line', 'water_name', fontFor.water, 'waterLabel', zoomed(4, 11, 10, 14), { filter: ['==', ['geometry-type'], 'LineString'],
      layout: { 'text-letter-spacing': .05, 'symbol-placement': 'line' } }),
    ...label('peaks', 'mountain_peak', fontFor.plain, 'label', 10, { minzoom: 11,
      layout: { 'text-field': ['concat', name, ['case', ['has', 'ele'], ['concat', ' ', ['to-string', ['get', 'ele']], ' m'], '']] } }),
    ...label('villages', 'place', fontFor.plain, 'label', zoomed(10, 10, 14, 13), { filter: is('class', 'village', 'hamlet', 'suburb'), minzoom: 10 }),
    ...label('towns', 'place', fontFor.plain, 'label', zoomed(7, 11, 12, 14), { filter: is('class', 'town'), minzoom: 7 }),
    ...label('cities', 'place', fontFor.place, 'place', zoomed(4, 12, 10, 18), { filter: is('class', 'city'), minzoom: 4 }),
    ...label('states', 'place', fontFor.plain, 'label', 10, { filter: is('class', 'state'), minzoom: 5, maxzoom: 8,
      layout: { 'text-transform': 'uppercase', 'text-letter-spacing': .15 } }),
    ...label('countries', 'place', fontFor.place, 'label', zoomed(2, 11, 6, 15), { filter: is('class', 'country'), maxzoom: 8,
      layout: { 'text-transform': 'uppercase', 'text-letter-spacing': .2 } }),
  ];
  const style = { version: 8, glyphs: mapOrigin + '/fonts/{fontstack}/{range}.pbf',
    sources: { openmaptiles: { type: 'vector', url: mapOrigin + '/planet', attribution: mapAttribution },
      ...(p.contour ? { contours: { type: 'vector', maxzoom: 15, attribution: elevationAttribution, tiles: [elevation.contourProtocolUrl({
        // [minor, major] interval in metres by tile zoom: country scale every 500 m, close in every 20 m.
        thresholds: { 5: [500, 2000], 7: [200, 1000], 9: [100, 500], 11: [50, 250], 13: [20, 100] },
        elevationKey: 'ele', levelKey: 'level', contourLayer: 'contours' })] } } : {}) },
    layers } as unknown as StyleSpecification;
  return { style, roles };
}
