# 0001: Templates render HTML/CSS; Chromium exports the PDF

Status: accepted, 2026-11-09.

## Context

The contract in [content-template-contract.md](../content-template-contract.md) left the rendering model open: templates could produce HTML/CSS laid out and exported by a browser engine, or a primitive tree drawn by a renderer Imageflow controls (the existing Swift/Core Graphics exporter). The choice determines how Markdown flows across boxes, which CSS templates may use, and whether preview and export can share one layout.

Two spikes supplied evidence:

- **PDF export** (`spikes/pdf-format`, PR #2). Chrome honours physical page sizes to within 0.12 mm, embeds photographs byte-for-byte without resampling, keeps colour profiles, and embeds static fonts properly. Its gaps (no trim or bleed boxes, unconverted wide-gamut images, transparency from CSS effects, Type 3 output for variable fonts and fallback glyphs) are all fixable or detectable in post-processing. All three print targets in [print-targets.md](../print-targets.md) are reachable.
- **Text flow** (`spikes/text-flow`, PR #3). One Markdown source flows through chained boxes of different sizes and styles with no lost text, clipping, or numbering errors in 360 random chains, preview and PDF line breaks are identical, and a 15,000-word book flows in about 20 ms.

## Decision

- **Templates render HTML/CSS** (React components producing DOM, styled by template CSS, with SVG for generated artwork). No custom primitive tree.
- **One engine for preview and export.** The editor shows the same rendered DOM that is exported. In the Electron app (see [v1-decisions.md](../v1-decisions.md)), export uses Electron's bundled Chromium (`webContents.printToPDF` in a hidden window, or `capturePage` for raster delivery), so preview and export run the same engine on the same machine.
- **Profile-driven post-processing** after Chromium, as sketched in PR #2: exact page boxes (pdf-lib), sRGB conversion and resolution limits on import or before export, transparency handling per print format (keep, flatten, or raster delivery), and a check that fails on Type 3 or system fonts.
- **Text flow** uses the columns strategy from PR #3: Chrome's multi-column fragmentation finds breaks; JavaScript adds widow lookahead into the next box, keep-with-next for headings, and a one-line overflow guard. The platform keeps the unsplit source and reruns the flow whenever an input changes.
- **Markdown**: CommonMark subset (paragraphs, headings, emphasis, strong, links, lists, block quotes). See [v1-decisions.md](../v1-decisions.md) for quotes and hyphenation.
- **The Swift renderer is retired**, together with the layout upload to it in the current app and in the Electron draft (PR #4).

## Consequences

- Templates have the full expressiveness of HTML, CSS, and SVG, constrained by a short list of platform-owned CSS (multi-column properties on Markdown boxes, `overflow-wrap`, continuation classes, list marker room) and per-format output rules (transparency, fonts).
- Chromium's quirks become ours: page sizes are quantized to 1/300 in, transparency appears for many CSS effects, and behaviour can change between Chromium versions. Electron pins the version per app release; export tests should run on each Electron upgrade.
- CMYK output (Blurb's 100% K black text) is not native and would need a post-processing step if Blurb is used.
- The existing frame and layer model in `book.ts` / `bookRender.ts` and the SVG canvas are replaced by template rendering.
