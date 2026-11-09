# Print target: Blurb Large Square

Status: Phase 0 output of [validation-plan.md](validation-plan.md). Values were read from Blurb's PDF to Book specification tool and help center on 2026-11-09. Blurb states that the spec tool is authoritative and that bleed should not be derived from the trim size; re-check the tool before a real order.

Sources:

- [PDF to Book specification tool](https://www.blurb.com/make/pdf_to_book/booksize_calculator#book-attributes)
- [PDF to Book specifications and checklist](https://support.blurb.com/hc/en-us/articles/207792946-PDF-to-Book-specifications-and-checklist)
- [PDF uploader preflight errors](https://support.blurb.com/hc/en-us/articles/207792976-PDF-uploader-preflight-errors)
- [How many pages can my book have?](https://support.blurb.com/hc/en-us/articles/7607055286541-How-many-pages-can-my-book-have)

## Product

Blurb photo book, Large Square, nominally 12 × 12 in (30 × 30 cm). The actual trim is 846 × 846 pt (11.75 in, 29.8 cm). Softcover is not available in this size; the cover options are Hardcover ImageWrap (printed laminated cover) and Hardcover Dust Jacket.

The existing prototype already uses this geometry (`trimWidth: 846`, `bleed: 9` in `src/spread.ts`).

## Interior pages

All values in points (1 pt = 1/72 in). They are identical for every paper type except the binding-edge inset.

| Measure | Value |
| --- | --- |
| Final exported PDF page (w × h) | 855 × 864 |
| Trim (w × h) | 846 × 846 |
| Bleed | 9 on top, bottom, and outside edge; none on the binding edge |
| Safe inset, top/bottom/outside | 18 from trim |
| Safe inset, binding edge | 36 (standard, premium, Mohawk papers); 0 (layflat papers) |

Structure rules:

- The pages file contains **individual pages, not spreads**. Submitting spreads fails preflight with a page-dimension error.
- Page 1 is a single right-hand page. Pages 2–3 are the first spread. The last page is a single left-hand page with an even number.
- The page count must be even.
- No printer marks, crop marks, or registration colour.

Consequences for the editor's coordinate system: a spread is 1710 × 864 pt (two 855-pt pages, no bleed at the gutter). Odd (right) pages carry bleed on the right, even (left) pages on the left. Page 1 and the last page are half-spreads; the other half is the inside of the cover and is not printed.

## Paper and page counts

| Paper | Pages | Binding-edge safe inset |
| --- | --- | --- |
| Standard | 20–440 | 36 |
| Premium lustre or matte | 20–240 | 36 |
| Mohawk proPhoto Pearl / Superfine Eggshell | 20–240 | 36 |
| Mohawk proPhoto Pearl / Superfine Eggshell – Layflat | 20–110 | 0 |

Layflat binding is the only option where artwork can run across the gutter without loss, for example the prototype's full-spread panorama. With the other papers, content within 36 pt of the binding edge is unsafe, and a panorama loses its middle into the gutter.

## Cover

The cover is a separate single-page PDF, created once the final page count is known. Spine width depends on paper and page count. It follows a stepwise table, not a formula, so it must come from the spec tool (or a table copied from it) rather than be computed.

Hardcover ImageWrap, premium lustre/matte paper:

| Pages | Cover PDF (w × h) | Spine |
| --- | --- | --- |
| 20 | — | 33 |
| 40 | 1793 × 918 | 33 |
| 80 | — | 41 |
| 120 | 1814 × 918 | 54 |
| 160 | — | 54 |
| 200 | — | 66 |
| 240 | 1839 × 918 | 79 |

Hardcover ImageWrap, layflat paper: 40 pages → 1813 × 918 (spine 53); 110 pages → 1904 × 918 (spine 144). Spine at 20/60/80 pages: 40/81/104.

ImageWrap cover: trim height 874, 22-pt bleed on all edges, 18-pt safe inset from trim, no flaps. The cover trim is larger than the page trim because the boards overhang the pages.

Dust jacket (premium, 40 pages): 2377 × 882, 9-pt bleed on all edges, 284-pt flaps, spine 33.

A single-file upload (cover and pages together) is also accepted. The uploader then uses page 1 as the front cover and the last page as the back cover, at page dimensions. This could be a shortcut for the first test upload, but how Blurb derives the spine and the 22-pt wrap from it is not documented.

## Colour and PDF format

- CMYK is recommended; **sRGB is accepted**. The current checklist does not require PDF/X. Older Blurb guides (around 2010) required PDF/X-3 for the InDesign workflow, so the requirement appears relaxed, but only the uploader preflight can confirm it.
- No spot colours (Pantone) and no registration colour.
- Body text and line art should be 100% K black (0/0/0/100). Large black areas should use rich black (60/50/50/100).
- All fonts must be embedded with permissions allowing print.
- Use the perceptual rendering intent where possible.
- Rasterize overly complex vector art.
- Images need no more than 300 PPI. The pages file may be up to 2 GB, the cover file up to 90 MB.

Pixel sizes at 300 PPI: a full-bleed single page is 3563 × 3600 px; a full-bleed spread is 7125 × 3600 px. Blurb does not state a minimum resolution.

### Consequence for browser export

Chromium produces RGB PDFs. RGB alone is acceptable, but RGB black text is converted by the printer to four-colour black, which conflicts with the 100% K rule for body text and can look soft at small sizes through slight misregistration. Phase 1 must test whether this is acceptable in print, or whether a post-processing step (for example Ghostscript conversion to CMYK with black text mapped to pure K) is needed. This is the most concrete printer-specific risk for the HTML/CSS route.

## Fonts

The prototype uses Georgia and Helvetica Neue. These are system fonts that cannot be bundled, so they are unsuitable for a reproducible export environment.

Shortlist, all under the SIL Open Font License (bundling and PDF embedding permitted):

| Role | Font | Notes |
| --- | --- | --- |
| Serif, body and display | Source Serif 4 | Optical sizes cover both body and display text |
| Serif alternative | EB Garamond | Classic book face, close in character to the prototype |
| Sans, captions and labels | Inter | Neutral, wide language coverage |

Use static font files (one file per weight and style) for the spikes. Whether Chromium embeds variable fonts as normal outline fonts or as Type 3 fonts, which some preflight checks reject, should be tested before variable fonts are allowed.

## Decisions for the physical book model

Proposed, pending confirmation:

1. **Book profile.** Geometry belongs to a project-level book profile (product, paper, cover type), not to templates. Templates design in trim coordinates, extend full-bleed artwork into the bleed, and are validated against the profile's safe insets.
2. **Paper.** A layflat paper for the first book if it fits in 110 pages, because full-spread photos then cross the gutter safely. Otherwise premium lustre, with templates keeping content away from the binding edge.
3. **Cover type.** Hardcover ImageWrap: one printed cover, no flaps.
4. **Page sequencing.** The editor models page 1 and the last page as half-spreads. Templates provide single-page layouts for them.
5. **Cover scope.** The cover is required to order a book. It is a separate template with front, spine, and back regions whose width is set from the spine table, exported as its own PDF. It can follow after the interior spikes.

## Validation without ordering

Uploading a PDF to Blurb runs preflight and shows an online preview before any order is placed. The Phase 1 spike PDF should be uploaded this way first. A printed copy is still needed to judge colour, black text, and gutter behaviour.
