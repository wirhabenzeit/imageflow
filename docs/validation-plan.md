# Plan for resolving open points

Status: proposed. This plan orders the open questions in [content-template-contract.md](content-template-contract.md) by dependency and defines the experiments needed to answer them. It does not select an architecture.

## Summary

The deciding question is the rendering model: whether templates render to HTML/CSS and Chromium produces the print PDF, or templates produce primitives drawn by a renderer Imageflow controls. Most other decisions follow from it, including how text flows across boxes, whether the Swift exporter remains, and which CSS a template may use.

That question cannot be answered in the abstract. "Sufficient" means sufficient for a specific printer, so printer requirements are an input, not a later check. Text flow across boxes is part of the same question: with browser export it must be solved in the DOM; with a native renderer the approach changes entirely.

| Phase | Purpose | Depends on | Indicative effort |
| --- | --- | --- | --- |
| 0. Inputs | Printer specification, physical book model, fonts | — | A few days, no code |
| 1. Chromium PDF spike | Is browser PDF output printable and faithful for static pages? | Phase 0 | About 1 week |
| 2. Text-flow spike | Can Markdown flow reliably through arbitrary boxes? | Phase 0; runs in the Phase 1 setup | About 1–2 weeks |
| 3. Rendering decision record | Record the template output model and export pipeline | Phases 1–2 | Short |
| Independent decisions | Storage, parameter types, trust boundary, switching | — | In parallel |

## Phase 0: inputs

Status: specifications collected for Blurb, WhiteWall, and Saal Digital square books in [print-targets.md](print-targets.md), together with a proposed book profile and font shortlist. Pending: choosing the primary target and cover scope.

### Target printer

Choose one concrete printer for the first book and collect its specification:

- Accepted PDF variants: plain RGB PDF, or PDF/X (and which version).
- Colour handling: accepted ICC profiles, whether RGB is converted by the printer.
- Minimum effective resolution at final size.
- Bleed, safe area, and required TrimBox/BleedBox.
- Binding type and gutter loss (layflat versus perfect binding).
- How the cover and spine are delivered, and how spine width depends on page count.

### Physical book model

Write down what template declarations must express:

- Page versus spread sequencing, including a single right-hand first page and a possible single last page.
- Bleed, trim, safe area, and gutter, and whether they are set by the template, the project, or the printer profile.
- Whether the cover is in scope for the first version.

The spike templates need these values.

### Fonts

Choose two or three fonts that templates bundle, with licences permitting PDF embedding. System fonts such as Georgia and Helvetica Neue, used by the prototype, are not portable across export environments.

## Phase 1: Chromium PDF spike (static content)

Rebuild the existing demo spreads (photo and story, gallery, panorama, title) as HTML/CSS pages without text flow. Export them through headless Chromium (for example Playwright `page.pdf`) at the exact page size including bleed.

Evaluate:

- **PDF boxes.** Whether Chromium output carries correct TrimBox and BleedBox, and if not, whether post-processing (pdf-lib, qpdf, or Ghostscript) can set them on every page.
- **Images.** Whether embedded ICC profiles (sRGB, Display P3, Adobe RGB) survive; whether JPEGs are passed through or re-encoded; effective resolution; PDF size for a 30-spread book.
- **Fonts.** Embedded and subset, without fallback glyphs.
- **Effects.** Whether intended template effects (shadows, blend modes, SVG artwork, gradients) appear in the PDF as in preview.
- **Compliance.** If the printer requires PDF/X, whether post-conversion produces a file that passes preflight.
- **Print-target specifics** (see [print-targets.md](print-targets.md)):
  - Export from one spread model to both single pages with bleed on three sides (Blurb, WhiteWall) and whole spreads (Saal).
  - Whether Chromium output contains transparency, and whether flattening (for example with Ghostscript) or 300-dpi JPEG spreads satisfy Saal.
  - Whether the RGB PDF passes Blurb preflight and WhiteWall's dimension check.
  - For Blurb, whether body text prints acceptably without 100% K black, or needs a CMYK step mapping black text to pure K.
  - Whether static and variable fonts embed as outline fonts rather than Type 3.
- **Preview agreement.** Rasterize the PDF and compare it with screenshots of the same pages rendered in the editor.
- **Physical proof.** Order one printed proof from the chosen printer.

Outcomes:

- Passes preflight, the proof is acceptable, and preview matches PDF apart from anti-aliasing: browser rendering is viable.
- Only packaging fails (boxes, PDF/X): browser output plus post-processing.
- Colour or typography fails: evidence for a native or dedicated rendering engine.

## Phase 2: text-flow spike

In the Phase 1 setup, flow one Markdown source through at least three boxes of different sizes and styles across spreads, using the source rule from the contract (same source means continuation; order by spread, then template-declared box order).

Candidates:

- A small DOM-measurement fragmenter (paragraph and line splitting using Range rectangles).
- An existing pagination library, evaluated for arbitrary frame sequences rather than conventional pages (Paged.js is the obvious candidate to examine).
- Typst as a reference outside the browser model, limited to about a day. It renders both SVG and PDF from one engine, at the cost of templates no longer being React/CSS.

Pass criteria:

- Property test over random box sizes and edits: fragments together reproduce the source exactly, with nothing omitted or duplicated.
- Emphasis and links survive a break; lists continue with correct numbering; headings stay with the following text.
- An edit late in the book does not change earlier fragments.
- Results are stable after fonts load.
- Interactive reflow time on a 100-spread book with about 20,000 words is acceptable for editing.
- Line breaks in the exported PDF match the preview fragments.

## Phase 3: rendering decision record

Based on Phases 1 and 2, record:

- What a template outputs: DOM/CSS, or a primitive tree.
- The export pipeline, including any post-processing.
- Whether the Swift renderer is retired, kept for packaging, or remains the exporter.
- The supported Markdown subset and the allowed CSS subset for flow-relevant styles.

## Independent decisions

These do not block the spikes and can be settled in parallel.

- **Short text.** Titles, labels, and similar per-instance text are template string parameters (single- and multi-line), editable in place on the canvas, with fit checks reporting overflow. Markdown boxes are for flowing text. See the contract.
- **Template trust boundary.** Proposed: first-party and trusted local templates only for the first version. Sandboxing third-party or agent-authored templates is deferred.
- **Project storage.** For example a project folder containing photos, Markdown files, and a JSON index, with minted stable identifiers and detection of renamed or missing files.
- **Parameter types.** Proposed minimum: boolean, integer, number, string (single- and multi-line), enum, colour, date. Schema-defined objects and default inheritance are deferred.
- **Template switching.** Proposed for the first version: a box with the same identifier and type maps automatically; everything else is retained and reported, not migrated.
- **Contract document cleanup.** Add a decided/open status per section and use one naming scheme for boxes and generated elements.

## Not addressed by this plan

Per-use caption overrides, mixed content boxes, automatic continuation pages, independent repetition of a Markdown source, and custom inspectors remain deferred as described in the contract.
