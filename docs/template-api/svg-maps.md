# SVG maps

For a printable map, use `<RenderedImage output="vector">` with the starter template's `maplibre-svg` package. This is a template-local dependency, not an export of `imageflow` or a package to fetch from npm. The complete implementation is in `sample/starter/template/map.tsx`; `map-styles.ts` supplies palettes, contour tiles and attribution.

## Reuse the helper

Copy `sample/starter/template/packages/maplibre-svg/` into your template's `packages/maplibre-svg/`. Add `"maplibre-svg": "file:packages/maplibre-svg"` and the starter's pinned `maplibre-gl` version to `template/package.json` dependencies, then call `rebuild_dependencies`. Do not run npm install inside the template. The rebuild bundles the helper's TypeScript source and its declarations; no package build is needed. See [Dependencies](dependencies.md).

Declare every style, tile, glyph and sprite origin in the template's `network`. The example below uses OpenFreeMap; a style with additional providers needs their origins too. Preserve the provider's attribution in the printed page or collect it through layout `credits` and `ctx.book.credits` ([Credits](anchors-and-index.md#credits)).

## Minimal map element

This render fragment assumes a declared `map` element and a template with `network: ['https://tiles.openfreemap.org']`. Use it inside `<Page>` for a `page()` layout. Use the appropriate spread rectangle inside `<Spread>` for a spread layout.

```tsx
import { fonts, Page, RenderedImage } from 'imageflow';
import { drawMapSvg, projector } from 'maplibre-svg';

// The page must use this bundled font family (replace it with your own).
const labelFamily = 'Field Serif';
const safe = ctx.geometry.page('safe');
const rect = { ...safe, height: safe.height - 8 }; // reserve attribution space
const centre = { longitude: 17.75, latitude: 69.35, zoom: 8.5 };
const cssPerMm = 96 / 25.4;
const view = { ...centre, width: rect.width * cssPerMm, height: rect.height * cssPerMm };
const marker = projector(view)([17.75, 69.35]);

return <Page style={{ fontFamily: labelFamily }}>
  <ctx.Element id="map" rect={rect}>
    <RenderedImage label="Map" output="vector" inputs={view}
      style={{ position: 'absolute', inset: 0 }}
      draw={async ({ signal }) => {
        const module = await import('maplibre-gl');
        return drawMapSvg({
          maplibre: module.default ?? module,
          style: 'https://tiles.openfreemap.org/styles/positron', view, signal,
          // Inherit a bundled font from the page; omit characters it cannot set.
          text: label => fonts.settable(label, { family: labelFamily }),
        });
      }} />
    <svg viewBox={`0 0 ${view.width} ${view.height}`}
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
      <circle cx={marker[0]} cy={marker[1]} r="4" fill="#c8432b" />
    </svg>
  </ctx.Element>
  <p style={{ ...ctx.geometry.css({ ...safe, y: safe.y + rect.height + 2, height: 6 }), margin: 0, fontSize: '8pt' }}>© OpenFreeMap © OpenMapTiles © OpenStreetMap contributors</p>
</Page>;
```

For the fonts helper's family/style arguments, see [Fonts and output](css-contract.md#fonts-and-output). Keep every changing draw input (including style and label options) in `inputs`. The marker and basemap must share the same view. The starter's editor saves longitude, latitude and print zoom as normal element parameters; an inset map on a split sheet is edited through MCP with the sheet ID and `page: 'left'` or `'right'`.

## Helper API and limits

- `drawMapSvg({ maplibre, style, view, signal?, ...options })` loads an off-screen MapLibre map, waits for tiles and label placement, returns SVG markup and releases the map. Tile/style failures reject; pass the host's abort signal.
- `mapToSvg(map, view, options?)` converts an already loaded, idle map.
- `projector(view)([longitude, latitude])` maps coordinates to the SVG's CSS-pixel viewBox. `view` contains longitude, latitude, zoom, width and height; size is CSS pixels at 96 per inch, not millimetres.
- Options: `font(stack)` chooses label classes/faces, `text(label, stack)` filters label text, `color(color, use)` maps paints (including CSS variables), `layers(layer)` filters layers, `avoid: [{ at: [longitude, latitude], radius }]` suppresses nearby basemap labels, and `className` styles the SVG root. Radius is CSS pixels.

The helper draws backgrounds, fills, flat extrusions, lines and symbol text. It omits icons, fill patterns, raster imagery, hillshade, line offsets and blur. It uses MapLibre's internal feature/style data, so keep the tested dependency version pinned and verify before upgrading. It does not provide a general rotated or pitched camera. Tracks, markers, custom labels and insets belong in your layout as SVG overlays. The starter demonstrates label fonts, terrain contours and theme-aware palettes.

Run `check_book` with `typescript: true`, then inspect page previews and export a PDF to check vector paths, labels, attribution and bundled fonts. MCP Book check does not run PDF print preflight. See [Rendered images](rendered-images.md) for host SVG handling, font limitations, caching and failures.
