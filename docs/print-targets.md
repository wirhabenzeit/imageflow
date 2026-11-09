# Print targets

Status: Phase 0 output of [validation-plan.md](validation-plan.md). Requirements for three online print services offering a square book of about 30 × 30 cm, read from their specification tools and help pages on 2026-11-09. Each service states that its own tool or template is authoritative; re-check before a real order.

The services differ in units, bleed, safe area, delivery unit (single pages or spreads), colour handling, and cover construction, but all fit one parameterized book profile. That supports keeping physical geometry out of templates.

## Comparison

| | Blurb Large Square | WhiteWall Gallery Square | Saal Digital 30 × 30 |
| --- | --- | --- | --- |
| Trim | 846 × 846 pt (298.5 mm) | 290 × 290 mm | ≈ 294 × 294 mm (derived) |
| Interior delivered as | Single pages | Single pages | Spreads |
| Bleed | 9 pt (3.2 mm), top/bottom/outside | 3 mm, top/bottom/outside | 3 mm, outer edges of the spread |
| Safe inset | 18 pt (6.4 mm); binding 36 pt (12.7 mm), 0 for layflat | 5 mm | ≈ 10 mm |
| First / last page | Single right / single left page | Not documented | Printed on the inside covers; every unit is a full spread |
| Page counts | Even; 20–240 (premium), 20–110 (layflat) | Steps of 4; 28–112 (photo paper), 28–200 (inkjet) | Even; 26–130 (Professional Line), 20–130 (Softcover) |
| Colour | CMYK recommended, sRGB accepted; 100% K body text | sRGB only; black as RGB 0/0/0 | sRGB only |
| Transparency | Not mentioned | Allowed, no flattening needed | Should be flattened ("optimized in Acrobat Pro") |
| Other formats | — | — | JPG per spread accepted |
| Cover | Separate wrap PDF; spine from table | Separate spread PDF; spine from configurator | Front panel (Professional Line) or wrap PDF (Softcover); spine from table |
| Paper | Offset/indigo papers, optional layflat | Inkjet papers or Fuji photo paper (layflat) | Photo paper, layflat |
| Upload limits | Pages 2 GB, cover 90 MB | Pages 1–1.5 GB, cover 250 MB | Not checked |

Fit with browser (HTML/CSS → Chromium) export, which produces RGB PDFs with transparency where CSS uses it:

- **WhiteWall**: best fit. sRGB only and transparency allowed; plain Chromium output may be acceptable as is. Size is 29 cm, not 30 cm.
- **Saal**: good fit for colour; transparency must be flattened, or spreads delivered as 300-dpi JPEGs. Only service with a true 30 × 30 cm book.
- **Blurb**: RGB is accepted, but the 100% K rule for body text conflicts with RGB output and may need a CMYK post-processing step.

## Blurb: Large Square

Sources: [spec tool](https://www.blurb.com/make/pdf_to_book/booksize_calculator#book-attributes), [specifications and checklist](https://support.blurb.com/hc/en-us/articles/207792946-PDF-to-Book-specifications-and-checklist), [preflight errors](https://support.blurb.com/hc/en-us/articles/207792976-PDF-uploader-preflight-errors), [page counts](https://support.blurb.com/hc/en-us/articles/7607055286541-How-many-pages-can-my-book-have).

Nominally 12 × 12 in; actual trim 846 × 846 pt (11.75 in). Softcover is not available; covers are Hardcover ImageWrap or Dust Jacket. The existing prototype already uses this geometry (`trimWidth: 846`, `bleed: 9` in `src/spread.ts`).

### Interior

| Measure (pt) | Value |
| --- | --- |
| Exported PDF page | 855 × 864 |
| Trim | 846 × 846 |
| Bleed | 9 top, bottom, outside; none at binding |
| Safe inset, top/bottom/outside | 18 |
| Safe inset, binding | 36 (standard, premium, Mohawk papers); 0 (layflat) |

- Individual pages, not spreads; spreads fail preflight.
- Page 1 is a single right-hand page; the last page is a single left-hand page with an even number.
- No printer marks or registration colour.

| Paper | Pages |
| --- | --- |
| Standard | 20–440 |
| Premium lustre or matte | 20–240 |
| Mohawk proPhoto Pearl / Superfine Eggshell | 20–240 |
| Mohawk … – Layflat | 20–110 |

### Cover

Separate single-page PDF. Spine width follows a stepwise table by paper and page count, not a formula.

Hardcover ImageWrap, premium paper (pt): spine 33 at 20 and 40 pages, 41 at 80, 54 at 120 and 160, 66 at 200, 79 at 240. Cover PDF 1793 × 918 at 40 pages, 1839 × 918 at 240. Trim height 874, 22-pt bleed on all edges, 18-pt safe inset, no flaps.

Layflat paper: spine 40/53/81/104/144 at 20/40/60/80/110 pages; cover PDF 1813 × 918 at 40 pages.

Dust jacket (premium, 40 pages): 2377 × 882, 9-pt bleed, 284-pt flaps, spine 33.

A single-file upload (cover pages at page size as first and last page) is also accepted; how the spine and wrap are then derived is undocumented.

### Colour and format

- CMYK recommended, sRGB accepted. PDF/X is not listed in the current checklist (older guides required PDF/X-3); only the uploader preflight can confirm.
- Body text and line art 100% K; large black areas rich black (60/50/50/100). No spot colours.
- Fonts embedded with print permission. Rasterize complex vector art. Perceptual rendering intent.
- Images up to 300 PPI; a full-bleed page is 3563 × 3600 px, a full-bleed spread 7125 × 3600 px at 300 PPI.

## WhiteWall: Coffee Table Book, Gallery Square

Sources: [PDF requirements](https://service.whitewall.com/hc/en-us/articles/4411222658321-05-PDF-file-requirements-and-export-instructions), [dimensions](https://service.whitewall.com/hc/en-us/articles/4411250911377-03-Setting-the-correct-dimensions-for-cover-and-content-pages), [design notes](https://service.whitewall.com/hc/en-us/articles/4411236486929-04-Notes-on-design), [ICC profiles](https://service.whitewall.com/hc/en-us/articles/213813645-Does-WhiteWall-offer-color-management-ICC-color-profiles), [PDF upload](https://www.whitewall.com/eu/coffee-table-book/pdf-upload).

Sizes offered: 20.5 × 20.5, 20.5 × 27, 27 × 20.5, 29 × 29, 27 × 35.6, 38.2 × 29 cm. No 30 × 30 cm. Values below are from the configurator for Gallery Square, Fuji Crystal Archive Velvet photo paper (layflat), hardcover, 28 pages.

### Interior

| Measure | Value |
| --- | --- |
| PDF page (gross) | 293 × 296 mm |
| Trim (net) | 290 × 290 mm |
| Bleed | 3 mm top, bottom, outside; 0 inside |
| Safe inset | 5 mm |

- Single pages, in a separate PDF from the cover.
- Pages in steps of 4: 28–112 on photo paper, 28–200 on inkjet papers. Indicative price at 28 pages: €119 (photo paper), €59.95 (inkjet).
- Whether page 1 is a single right-hand page is not documented; check the IDML template or the upload preview.
- Papers: three inkjet (Fedrigoni Symbol Freelife Gloss, with or without varnish; Sappi Magno Volume silk-matt) and three Fuji Crystal Archive photo papers (lustre, glossy, velvet), the latter laser-exposed with layflat binding. Whether inkjet papers need a binding margin is not documented.

### Cover

One double-page PDF (back, spine, front): 623 × 316 mm gross, 603 × 296 mm net, 10 mm bleed on all edges, spine 11 mm at 28 pages. Spine text at least 2 mm from the spine edges, at least 11 pt recommended. The fold extends 10–12 mm from the spine onto front and back. Spine width depends on paper and page count; only the 28-page value was read.

### Colour and format

- PDF 1.4 or later, sRGB, including black-and-white images. Solid black as RGB 0/0/0.
- ICC profiles are offered for soft-proofing only; do not convert to them or embed them.
- Images 180–300 ppi. Fonts embedded or outlined. Transparency may remain.
- No crop or registration marks, comments, form fields, or encryption.

## Saal Digital: 30 × 30 cm

Sources: [file guide (InDesign)](https://www.saal-digital.ch/service/profibereich/erstelle-deine-dateien-in-indesign/), [photobook specification tables](https://www.saal-digital.ch/fotobuch/profibereich/).

The standard hardcover photobook goes up to 28 × 28 cm. 30 × 30 cm is available as Professional Line (photo paper, layflat, 26–130 pages), Professional Line XT, Softcover (20–130 pages), and Portfolio Album. Saal publishes dimensions in pixels at a stated resolution; millimetre values below are converted.

### Interior (Professional Line and Softcover, identical)

| Measure | Value |
| --- | --- |
| Spread (gross) | 7016 × 3543 px at 300 dpi (594.0 × 300.0 mm) |
| Bleed | 35 px (≈ 3 mm) |
| Spread (net, derived) | ≈ 588 × 294 mm, i.e. ≈ 294 × 294 mm per page |
| Safe distance | ≈ 1 cm from the trim, or run fully into the bleed |

The net size assumes bleed on all four outer edges of the spread; confirm with the template.

- Each double page is one PDF page. Cover and interior may be one or two PDFs.
- The page count excludes the cover. The first page of the first spread and the last page of the last spread are printed on the inside covers; the book starts directly with a full spread.
- Minimum type sizes: 8 pt sans serif, 10 pt serif (measured against Arial and Times New Roman), 12 pt for light weights, 14 pt for light text on dark backgrounds. Lines at least 1 pt.

### Cover

- Professional Line: acrylic or brushed-aluminium front insert with leatherette or linen; the printed image is the front panel only, 4583 × 4819 px at 400 dpi (291 × 306 mm), 47-px (3 mm) bleed. Leather and linen special covers cannot be supplied as PDF and allow text only, designed in Saal's editor.
- Softcover: one wrap PDF. Spine follows a stepwise table, from 110 px (7 mm) at 20 pages to 472 px (30 mm) at 130 pages, at 400 dpi. At 20 pages the cover is 9460 × 4724 px (600.7 × 300 mm), 3-mm bleed.

### Colour and format

- Always sRGB (export target sRGB IEC61966-2.1).
- Fonts embedded or outlined. No register or crop marks.
- PDFs "must be optimized in Adobe Acrobat Pro" to convert masks, transparency, and metadata that could cause import problems. Whether the uploader rejects unflattened PDFs is untested.
- PDF or JPG upload. JPG per spread at the stated pixel size bypasses PDF concerns entirely; the photo paper is exposed as raster in any case.

## Fonts

The prototype uses Georgia and Helvetica Neue, system fonts that cannot be bundled.

Shortlist, all under the SIL Open Font License (bundling and PDF embedding permitted):

| Role | Font | Notes |
| --- | --- | --- |
| Serif, body and display | Source Serif 4 | Optical sizes cover body and display |
| Serif alternative | EB Garamond | Classic book face |
| Sans, captions and labels | Inter | Neutral, wide language coverage |

Use static font files for the spikes. Whether Chromium embeds variable fonts as outline fonts or as Type 3 fonts should be tested before allowing them.

## Book profile

All three services fit one project-level book profile. Templates design in trim-relative units and are validated against the profile; they do not hard-code a printer's geometry.

A profile declares:

- **Trim size** in physical units (mm or pt; values are not integral in points for WhiteWall and Saal).
- **Bleed** per edge, including none at the binding edge for single-page delivery.
- **Safe insets**, separately for the binding edge.
- **Delivery unit**: single pages (Blurb, WhiteWall) or spreads (Saal). The editor works in spreads; export either slices spreads into pages with bleed on three sides or emits whole spreads.
- **Book structure**: whether the first and last pages are single half-spreads (Blurb) or printed on the inside covers (Saal).
- **Page-count rule**: minimum, maximum, and step (2 or 4).
- **Cover construction**: wrap or front panel, cover bleed, fold allowance, and a spine-width table by page count.
- **Colour and format constraints**: colour space, transparency handling, black-text rule, accepted formats (PDF, JPG).
- **Validation rules**: minimum type size and line weight, resolution range.

## Consequences for the rendering decision

- With WhiteWall or Saal, an RGB-only pipeline is the intended workflow, removing the main colour risk of browser export.
- Rasterizing spreads at 300 dpi is an accepted delivery format for Saal and a plausible fallback elsewhere for photo-paper products. Browser rendering therefore always has an exact export route: render the same page at print resolution.
- Remaining format risks for Chromium PDF output are transparency (Saal), black text (Blurb), and font embedding type (all).

## Open decisions

1. **Primary target.** Proposed: WhiteWall Gallery Square on photo paper (lowest export risk, 29 cm), or Saal Professional Line 30 × 30 (true 30 cm, transparency or JPG question). Keep at least one other service as a second profile so the profile abstraction stays honest.
2. **Cover scope for the first book**, given that cover construction differs most between services.
3. **Page-count step**: design the editor for even page counts and validate the step per profile.

## Validation without ordering

Blurb and WhiteWall check uploaded PDFs (preflight or dimension check) and show a preview before ordering; Saal's upload preview should be checked the same way. Upload the Phase 1 spike output before ordering a printed copy, which remains necessary to judge colour, text rendering, and gutter behaviour.
