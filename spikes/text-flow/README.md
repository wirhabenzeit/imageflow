# Spike: Markdown text flow across boxes

Phase 2 experiment from `docs/validation-plan.md` (on the `docs/content-template-contract` branch). It tests whether one Markdown source can flow reliably through a chain of differently sized and styled boxes in Chrome, and whether the PDF keeps the preview's line breaks.

Run on 2026-11-09 with Google Chrome 156 via Playwright, `mdast-util-from-markdown` 2.0.2, Source Serif 4 and Inter (static WOFF2).

## Running

```sh
npm install
node run.mjs        # writes out/report.json, scenario screenshots and PDFs
```

## What was built

- `markdown.mjs` converts CommonMark to HTML where every element carries its source range (`data-s`, `data-e`).
- `flow.js` runs in the page and flows that HTML through an ordered list of boxes. Two strategies find where a box's content ends:
  - **measure**: lay out normally and find the first character whose glyph box extends below the box (binary search over `Range.getClientRects()`).
  - **columns**: make the box a multi-column container of its own size and take the first character Chrome placed in an overflow column. Chrome's fragmentation engine applies CSS `orphans`, `widows`, and `break-after: avoid`.
- Both split the DOM at that character with `Range.extractContents()`, which clones partially selected ancestors, so emphasis, links, block quotes, and nested lists continue in the next box. Split elements are marked `.split` / `.cont`; continued ordered lists get a corrected `start`, and a continued list item hides its marker.
- Rules applied in JavaScript for both strategies:
  - **Orphans**: a split block keeps at least two lines in the current box, otherwise it moves whole.
  - **Widows**: the continuation is laid out at the *next* box's column width; if it would have one line, one more line moves (repeated as needed), or the whole block moves when only two lines would remain.
  - **Keep-with-next**: a heading does not end a box when the following block moves.
  - **Overflow guard**: if the box still overflows after splitting (line boxes can extend below glyph boxes by the half-leading), the break retreats one line.
- `run.mjs` checks a fixed two-spread scenario, 360 random box chains, a 15,000-word book, hyphenation, and preview/PDF line agreement.

## Results

| Check | measure | columns | columns, two-column boxes |
| --- | --- | --- | --- |
| Random chains (120 × 6 boxes, 50–160 mm × 25–180 mm, mixed styles) | | | |
| – text lost or duplicated | 0 | 0 | 0 |
| – boxes with clipped content | 0 | 0 | 0 |
| – list numbering errors | 0 | 0 | 0 |
| – orphans / widows | 0 / 0 | 0 / 0 | 0 / 0 |
| – heading ending a box | 0 | 0 | 2 (box too small for heading plus one line) |
| – split corrections needed | 142 | 47 | 53 |
| Fixed scenario: preview vs PDF line breaks (6 boxes, ~300 lines) | identical | identical | — |
| 15,177 words, 100 boxes of 120 × 230 mm: full flow | 20 ms | 22 ms | — |
| Edit near the end of the book: first changed box | 41 of 41 | 41 of 41 | — |

The flow is sequential and deterministic, so an edit only changes boxes from the first affected one onward; reflow can start there. At ~20 ms for a whole book, incremental reflow is not needed for performance.

### Findings that shaped the implementation

- **Widow control needs lookahead.** The continuation is reflowed at the next box's width, so two lines in a narrow box can become one line in a wide one. Neither a same-box rule nor CSS `widows` sees this; the first version produced widows in ~20 % of chains with both strategies. Laying out the continuation in a hidden probe at the next box's width fixed it.
- **Unbreakable words break both strategies.** A long URL in plain text (CommonMark does not autolink it) overflowed horizontally, which clipped content and broke the monotonic character search of the columns strategy. Markdown boxes must enforce `overflow-wrap: break-word` as a platform rule, not leave it to template CSS.
- **Glyph boxes are not line boxes.** Checking characters against the box bottom misses the half-leading of the last line (~2 px); a post-split overflow check with one-line retreat handles it.
- **Chrome's column fragmentation is a good break finder.** The columns strategy needed a third of the corrections of the measure strategy and supports multi-column boxes with no extra code, which matters for the deferred multi-column text box parameter.

### Hyphenation

With `hyphens: auto`, Chrome on macOS hyphenated English and German text in a 45-mm column (for example "Fotografinnen", "Berufsleben"). Chrome uses platform hyphenation dictionaries; on Linux they are a separately downloaded component. A preview on macOS and an export on a Linux server could therefore break lines differently. Options: export with the same Chrome on the same machine, disable automatic hyphenation, or insert soft hyphens with a bundled hyphenation library before layout so the result no longer depends on the platform.

### Other observations

- List markers sit outside the content box. With `overflow: hidden` on a box, a continued list starting at "10." loses its first digit in the narrow scenario box. Boxes need enough list padding or `overflow: clip` with `overflow-clip-margin` so markers are not clipped.
- The last line of a split justified paragraph is justified (`text-align-last: justify` on `.split`) so the paragraph reads as continuing; a continued paragraph drops its first-line indent.
- Per-box template CSS works naturally: the continuation takes the next box's font size and alignment.

## Decisions this informs

- **Fragmentation approach**: the columns strategy plus JavaScript rules (widow lookahead, keep-with-next, overflow guard) is the simpler and more robust base, and covers multi-column boxes.
- **Platform-enforced CSS for Markdown boxes**: `overflow-wrap: break-word`, list marker room, continuation classes; templates style everything else.
- **Markdown dialect**: CommonMark subset (paragraphs, headings, emphasis, strong, links, lists, block quotes). Open: GFM autolinks, typographic quotes, footnotes.
- **Hyphenation**: decide between off, platform, and bundled library before relying on preview/export equality across machines.

## Not tested

- Inline images, tables, footnotes, and raw HTML in Markdown.
- Very small boxes where not even one line fits, and boxes with non-rectangular shapes.
- Fonts with different metrics loading late (all fonts were loaded before measuring).
- Editing interactions: caret placement and selection across fragments.
- Export on a different machine or Chrome version than the preview.
