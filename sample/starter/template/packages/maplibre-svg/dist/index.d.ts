import type { Map as MapLibreMap, MapOptions, StyleSpecification } from 'maplibre-gl';
/** What the map shows: its centre and MapLibre zoom, and its size in CSS pixels (96 per inch). */
export type MapView = {
    longitude: number;
    latitude: number;
    zoom: number;
    width: number;
    height: number;
};
/** How a label is set: a class the page's CSS styles, or a family, weight and style written onto the text. */
export type LabelFont = {
    className?: string;
    family?: string;
    weight?: number;
    style?: 'normal' | 'italic';
};
/** A style layer, for choosing which ones to draw. */
export type LayerInfo = {
    id: string;
    type: string;
    sourceLayer?: string;
};
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
    color?: (color: string, use: {
        layer: LayerInfo;
        property: string;
    }) => string;
    /** Whether to draw a style layer; all by default. */
    layers?: (layer: LayerInfo) => boolean;
    /** Places, as [longitude, latitude], where the template draws its own markers: labels within `radius` CSS pixels are left out. */
    avoid?: {
        at: [number, number];
        radius: number;
    }[];
    /** A class for the <svg> element. */
    className?: string;
};
/** The MapLibre module, as `import('maplibre-gl')` gives it. */
export type MapLibreModule = {
    Map: new (options: MapOptions) => MapLibreMap;
};
export type DrawOptions = SvgOptions & {
    maplibre: MapLibreModule;
    style: string | StyleSpecification;
    view: MapView;
    /** Stops loading; the promise rejects. */
    signal?: AbortSignal;
};
/** Longitude and latitude to the view's CSS pixels, as the drawn map places them. Pure, so a layout can use it. */
export declare function projector(view: MapView): ([longitude, latitude]: readonly number[]) => [number, number];
/**
 * Loads `style` off screen at the view and draws it as SVG markup once every tile has loaded. A style or tile that
 * fails to load rejects, so a print never has holes in it.
 */
export declare function drawMapSvg({ maplibre, style, view, signal, ...options }: DrawOptions): Promise<string>;
/** Draws a MapLibre map that has finished loading (`idle`) as SVG markup of the view. */
export declare function mapToSvg(map: MapLibreMap, view: MapView, options?: SvgOptions): string;
