# Spike: Chromium PDF format behaviour

Phase 1 experiment from `docs/validation-plan.md` (on the `docs/content-template-contract` branch). It answers format questions for exporting HTML/CSS pages with headless Chrome against the print targets in `docs/print-targets.md`: page geometry, image handling, colour profiles, transparency, fonts, and raster delivery. Text flow is not covered.

Run on 2026-11-09 with Google Chrome 156.0.8078.80 (Skia/PDF m156), Ghostscript 10.03.0, poppler, ImageMagick, and pikepdf 9.11.

## Running

```sh
npm install
python3 -m venv .venv && .venv/bin/pip install pikepdf==9.11.0
sh make-assets.sh          # synthetic test images in assets/
node export.mjs            # HTML test documents → out/*.pdf, out/*.jpg
.venv/bin/python analyze.py out/*.pdf
```

`export.mjs` uses the installed Google Chrome (`channel: 'chrome'`). Test images are synthetic: a colour chart with flat patches and line pairs, and fractal noise standing in for photographs.

## Findings

### Page geometry

- `@page { size }` in mm or pt is honoured, but Chrome quantizes the page size to 1/300 in. Observed deviations: WhiteWall 293 × 296 mm → +0.33 / −0.02 pt; Saal 594 × 300 mm → +0.30 / −0.31 pt; Blurb 855 × 864 pt → −0.12 / 0 pt. At most 0.12 mm, inside the bleed.
- MediaBox, CropBox, BleedBox, and TrimBox are all identical; Chrome writes no meaningful trim or bleed box.
- Both are fixed by a small post-processing step (`postprocess.py`, pikepdf) that sets the exact MediaBox and a TrimBox excluding the bleed on top, bottom, and the outside edge. Verified with `pdfinfo -box`.
- Single pages and spreads are just different `@page` sizes; one HTML spread model can produce either.

### Images

- **Photographs are embedded byte-for-byte.** The original JPEG stream (MD5-identical) is used for `object-fit: cover` crops, overflow clipping, CSS transforms, `clip-path`, and rounded corners. An image used on several pages is stored once.
- Flat synthetic graphics may instead be cropped and re-encoded losslessly (Flate) when that is smaller. No lossy re-encoding was observed.
- **No resampling.** A 7200-px image on a 293-mm page stays at 618 ppi; a 900-px image stays at 77 ppi. Resolution warnings and any downsampling for file size are the application's responsibility.
- EXIF orientation is applied.
- **Colour profiles are preserved, not converted.** sRGB-tagged and untagged images get an sRGB ICC profile; Display P3- and Adobe RGB-tagged images keep an equivalent P3 or Adobe RGB profile. For sRGB-only printers (WhiteWall, Saal), images should be converted to sRGB before export.
- Text and vector colours are written as untagged DeviceRGB (`0 0 0 rg` for black).

### Transparency

- Plain content produces no transparency: opaque images, text, and solid backgrounds.
- These produce transparency groups, soft masks, constant alpha, or blend modes: `opacity`, `rgba()` fills, `box-shadow`, `mix-blend-mode`, `filter`, PNG alpha, SVG `fill-opacity`, CSS gradients (even fully opaque ones), and `border-radius` clipping. `filter: blur` is rasterized into an image with a soft mask.
- Ghostscript flattening (`pdfwrite -dCompatibilityLevel=1.3`) rasterizes **every page that contains transparency in full**, at 720 dpi by default or at `-r300`. Text on such pages becomes pixels. Pages without transparency pass through unchanged, keeping original JPEGs and embedded fonts.
- Consequences per target: WhiteWall allows transparency; for Saal, either restrict templates to non-transparent features, flatten affected pages, or deliver every spread as JPEG; Blurb does not state a rule.

### Fonts

- Static WOFF2 fonts (Source Serif 4, Inter) are embedded and subset as CID TrueType with Unicode maps.
- **A variable font (Inter Variable) is embedded as Type 3.** Templates should bundle static instances; variable fonts can be instanced to static files at build time (for example with fontTools).
- **Fallback glyphs** missing from the bundled fonts (→, ★, CJK) are drawn from system fonts (Lucida Grande, PingFang) as Type 3. Export should detect fallback use, for example by reporting any Type 3 font or checking glyph coverage before export.
- System fonts such as Georgia are embedded if installed, but are not portable and may not be licensed for bundling.

### Raster delivery (JPEG)

- A spread screenshot at `deviceScaleFactor: 300/96` gives an sRGB-tagged JPEG at print resolution. Clipping in CSS px yields 7016 × 3541 px for Saal's 7016 × 3543 target, and rasterizing the PDF with `pdftoppm -r 300` yields 7017 × 3542. A final resize or extent to the exact pixel size and 300-dpi metadata are still needed (metadata is 72 dpi).

### Preview versus PDF

- The plain page rasterized from the PDF at 96 dpi matches the editor screenshot in layout and line breaks. Differences are text anti-aliasing and a sub-pixel image offset (RMSE 4.2 %, 0.8 % of pixels differ by more than 10 %).

## Implications

- HTML/CSS rendered by Chrome is technically viable for all three print targets, with a thin, profile-driven post-processing step:
  1. Set exact page boxes (all targets).
  2. Normalize image colour to sRGB and enforce resolution limits (all targets; required for WhiteWall and Saal).
  3. Handle transparency per profile: keep (WhiteWall), flatten affected pages or rasterize spreads to JPEG (Saal).
  4. Bundle static fonts and fail or warn on fallback glyphs and Type 3 fonts.
- Template authoring constraints follow from this: a transparency budget per print profile, static fonts only, and no reliance on system fonts.
- The text-flow spike can proceed in the same Chrome setup.

## Not tested

- Uploading to Blurb, WhiteWall, or Saal and their preflight or dimension checks.
- Printed output: colour, small text, gutter behaviour, and Blurb's 100% K black requirement or CMYK conversion.
- Real photographs and full-book file sizes and export times.
- How printer RIPs treat P3- or Adobe RGB-tagged images in a PDF.
