# Sketch: print format in the template definition

Status: proposal derived from this spike. It shows how a template could declare the physical format so that rendering, post-processing, and validation are driven by data rather than by printer-specific code. Field names are illustrative.

## Where the format lives

The template declares one or more named **formats**. The project selects one; everything below is resolved from that selection. A template designed for a square book can therefore list WhiteWall 29 cm and Saal 30 cm side by side, while a template that only makes sense at one size lists one.

Layout uses trim-relative CSS variables supplied by the platform, so the same spread design adapts to 290 or 294 mm without per-format code.

## Declaration

```ts
type Length = { value: number; unit: "mm" | "pt" | "in" };

type PrintFormat = {
  label: string;

  // Finished page size, after trimming.
  trim: { width: Length; height: Length };

  // Bleed per edge of a page. "binding" is the edge at the spine.
  bleed: { top: Length; bottom: Length; outside: Length; binding: Length };

  // Content that must not be cut keeps this distance from the trim.
  safe: { top: Length; bottom: Length; outside: Length; binding: Length };

  // How the book is sequenced and delivered.
  structure: {
    delivery: "pages" | "spreads";
    // Blurb: page 1 is a single right-hand page, the last page a single left-hand page.
    // Saal: the outer pages are printed on the inside covers; every unit is a full spread.
    ends: "single-pages" | "inside-covers";
    pageCount: { min: number; max: number; step: 2 | 4 };
  };

  output: {
    container: "pdf" | "jpeg";
    colorSpace: "sRGB";                     // images converted before rendering
    transparency: "allow" | "flatten" | "forbid";
    resolution: { minimum: number; target: number; maximum: number }; // ppi
    // Only for container "jpeg": exact pixel size per delivered unit.
    raster?: { dpi: number; width: number; height: number };
    fonts: { allowType3: false; allowSystemFonts: false };
    minimumTextSize?: Length;               // e.g. Saal: 8 pt sans, 10 pt serif
    maximumFileSize?: { pages: number; cover: number }; // bytes
  };

  cover?: CoverFormat;                      // separate document, sketched below
};

type CoverFormat = {
  kind: "wrap" | "front-panel";
  bleed: Length;
  safe: Length;
  fold?: Length;                            // WhiteWall: 10–12 mm onto front and back
  // Spine width is a stepwise table, not a formula; entries are copied from the printer's tool.
  spine?: { pages: number; width: Length }[];
  board?: { width: Length; height: Length }; // cover trim per side
};
```

## Example declarations

```ts
const mm = (value: number): Length => ({ value, unit: "mm" });
const pt = (value: number): Length => ({ value, unit: "pt" });

export default defineTemplate({
  id: "photo-journal",
  version: "0.2.0",
  contractVersion: 1,

  formats: {
    "whitewall-gallery-square": {
      label: "WhiteWall Gallery Square 29 × 29 cm",
      trim: { width: mm(290), height: mm(290) },
      bleed: { top: mm(3), bottom: mm(3), outside: mm(3), binding: mm(0) },
      safe: { top: mm(5), bottom: mm(5), outside: mm(5), binding: mm(5) },
      structure: {
        delivery: "pages",
        ends: "single-pages",                 // not documented; to be confirmed
        pageCount: { min: 28, max: 112, step: 4 },
      },
      output: {
        container: "pdf",
        colorSpace: "sRGB",
        transparency: "allow",
        resolution: { minimum: 180, target: 300, maximum: 400 },
        fonts: { allowType3: false, allowSystemFonts: false },
      },
    },

    "saal-professional-30": {
      label: "Saal Digital Professional Line 30 × 30 cm",
      trim: { width: mm(294), height: mm(294) },    // derived from 7016 × 3543 px at 300 dpi
      bleed: { top: mm(3), bottom: mm(3), outside: mm(3), binding: mm(0) },
      safe: { top: mm(10), bottom: mm(10), outside: mm(10), binding: mm(10) },
      structure: {
        delivery: "spreads",
        ends: "inside-covers",
        pageCount: { min: 26, max: 130, step: 2 },
      },
      output: {
        container: "jpeg",                        // or "pdf" with transparency: "flatten"
        colorSpace: "sRGB",
        transparency: "flatten",
        resolution: { minimum: 200, target: 300, maximum: 300 },
        raster: { dpi: 300, width: 7016, height: 3543 },
        fonts: { allowType3: false, allowSystemFonts: false },
        minimumTextSize: pt(8),
      },
    },

    "blurb-large-square-layflat": {
      label: "Blurb Large Square, layflat",
      trim: { width: pt(846), height: pt(846) },
      bleed: { top: pt(9), bottom: pt(9), outside: pt(9), binding: pt(0) },
      safe: { top: pt(18), bottom: pt(18), outside: pt(18), binding: pt(0) },
      structure: {
        delivery: "pages",
        ends: "single-pages",
        pageCount: { min: 20, max: 110, step: 2 },
      },
      output: {
        container: "pdf",
        colorSpace: "sRGB",
        transparency: "allow",                    // not specified by Blurb; to be validated
        resolution: { minimum: 200, target: 300, maximum: 300 },
        fonts: { allowType3: false, allowSystemFonts: false },
        maximumFileSize: { pages: 2e9, cover: 90e6 },
      },
    },
  },

  spreads: { /* designs use trim-relative CSS variables, see below */ },
});
```

## Derived geometry

The platform resolves a format into concrete boxes once, in points, and every later step uses the same numbers.

For `delivery: "pages"` (page 1 is a right-hand page):

| Box | Right-hand page (odd) | Left-hand page (even) |
| --- | --- | --- |
| MediaBox / BleedBox | trim + bleed (top, bottom, outside) | same |
| TrimBox x-origin | 0 (binding edge has no bleed) | bleed.outside |
| Safe rectangle | trim inset by safe; binding side on the left | binding side on the right |

For `delivery: "spreads"`, the delivered unit is two trims side by side plus bleed on all four outer edges; the gutter is a fold line, not an edge.

The editor always works in spreads with a shared coordinate system. For page delivery, a spread is cut at the gutter into a left page (bleed on the left) and a right page (bleed on the right). With `ends: "single-pages"`, the first and last spreads have one inactive half.

## CSS contract for templates

The platform renders each spread inside a container and sets custom properties from the resolved format. Templates position artwork relative to these instead of absolute sizes:

```css
.spread {
  /* Set by the platform from the selected format. */
  --trim-width: 290mm;
  --trim-height: 290mm;
  --bleed-top: 3mm;  --bleed-bottom: 3mm;  --bleed-outside: 3mm;
  --safe-top: 5mm;   --safe-bottom: 5mm;   --safe-outside: 5mm;  --safe-binding: 5mm;
  container-type: size;                 /* enables cqw/cqh units relative to the spread */
}

/* Template CSS: full-bleed photo on the left page, text inside the right page's safe area. */
.photo-journal .hero { position: absolute; inset: 0 50% 0 0; }
.photo-journal .body {
  position: absolute;
  left: calc(50% + var(--safe-binding));
  right: var(--safe-outside);
  top: var(--safe-top);
}
```

The page content box is the trim; bleed is added outside it by the platform. A full-bleed element extends into the bleed by being positioned at the trim edge with a negative inset of the bleed variable, or by using a platform-provided `bleed` utility class.

## Pipeline steps driven by the format

| Step | Driven by | Mechanism (verified in this spike where noted) |
| --- | --- | --- |
| Image preparation | `output.colorSpace`, `output.resolution` | Convert to sRGB and cap at `maximum` ppi for the placed size; warn below `minimum` (Chrome neither converts nor resamples — verified) |
| Page size | `trim`, `bleed`, `structure.delivery` | `@page { size }` per delivered unit (verified, ±0.12 mm) |
| Render | — | Chrome `page.pdf`, or a screenshot at `raster.dpi / 96` for JPEG (verified) |
| Exact boxes | resolved geometry | Set MediaBox, BleedBox, TrimBox per page (`postprocess.py`, verified) |
| Transparency | `output.transparency` | `allow`: keep; `flatten`: rasterize affected pages with Ghostscript at `resolution.target` (verified); `forbid`: fail with the page and element |
| Fonts | `output.fonts` | Fail on Type 3 or system fonts in the output (detection verified with pdffonts) |
| Raster size | `output.raster` | Resize or extend to the exact pixel size and set dpi metadata (needed: Chrome is off by up to 2 px) |
| Validation | `safe`, `minimumTextSize`, `pageCount`, `maximumFileSize` | DOM checks before rendering: text boxes within the safe rectangle, computed font sizes; count and size checks after |

## Open points

- Whether formats belong to templates (as sketched) or to a project-level profile that templates opt into. Declaring them in the template keeps a template self-contained; a shared registry avoids copying printer data into every template. Both can coexist: templates reference formats by id from a platform registry and may define their own.
- How the cover template consumes `CoverFormat`, in particular the spine table and page-count dependency.
- Whether `transparency: "flatten"` should flatten per page (Ghostscript) or rasterize the whole book for consistency.
- Saal's derived 294 mm trim needs confirmation from its template.
