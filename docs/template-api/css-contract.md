# CSS contract

## Authoring

Templates style with inline React `style` objects (positions, sizes, and anything driven by parameters) and one plain CSS file (`styles.css`, plus optional imports) for fonts, Markdown typography, and rules shared across spreads. Native CSS nesting may be used. No CSS preprocessor, Tailwind, or CSS-in-JS library is part of the v1 build.

```tsx
<h1 style={{ position: 'absolute', left: '30mm', top: '40mm', color: params.accent }}>{params.heading}</h1>
<MarkdownBox id="body" className="editorial" style={{ position: 'absolute', left: '55%', top: '30mm', width: '110mm', height: '230mm' }} />
```

```css
.editorial {
  font: 10.5pt/1.45 'Source Serif 4';
  p { margin: 0; }
  p + p { text-indent: 1.2em; }
  h2 { font: 400 9pt Inter; letter-spacing: .12em; text-transform: uppercase; }
}
```

The platform validates the rendered result (computed styles and the exported PDF), so its checks do not depend on how styles were written.

## Geometry variables

`<Spread>` and `<Page>` set, in physical units from the resolved format:

```css
--trim-width; --trim-height;          /* one page */
--bleed-top; --bleed-bottom; --bleed-outside;
--safe-top; --safe-bottom; --safe-outside; --safe-binding;
/* without facing pages, instead of the outside and binding variables: */
--bleed-left; --bleed-right; --safe-left; --safe-right;
```

For `<Page>` the content box is always one trim. Its `data-side="left" | "right" | "page"` distinguishes the placement; outside/binding variables use that side's resolved insets. Position artwork locally rather than using spread-wide `.left-page` or `.right-page` classes.

Without facing pages the content box is one trim (`--trim-width` by `--trim-height`) and there is no gutter.

The spread's content box is the two trims side by side (`2 × --trim-width` by `--trim-height`), with the gutter at 50 %. Coordinates are relative to the trim; the platform adds the bleed outside. Utility classes extend an element into the bleed: `.bleed` (all outer edges it touches), `.left-page`, `.right-page` (position a full page, including its outer bleed).

## Markdown

Template CSS styles the elements inside a `MarkdownBox`: `p`, `h1`–`h6`, `em`, `strong`, `a`, `ul`, `ol`, `li`, `blockquote`. The platform adds and owns:

- `overflow-wrap: break-word` and `hyphens: manual` on Markdown boxes (set `hyphens: auto` to hyphenate in the book's language, see [Language and hyphenation](#language-and-hyphenation)).
- Multi-column and fragmentation properties on Markdown boxes (`column-*`, `break-*` are set by the platform; `orphans`, `widows` may be set by templates).
- Continuation classes: `.split` on the part of an element that continues in a later box, `.cont` on the continuing part. Defaults: a continued paragraph has no first-line indent, a continued list item has no marker, and a split justified paragraph justifies its last line. Templates may restyle these.
- List markers stay inside the box (`list-style-position` or sufficient padding, checked by the platform).

Not allowed in Markdown boxes: CSS counters for list numbering, `float`, `position: absolute` on content, transitions and animations.

## Language and hyphenation

Declare the book's language as `language` on the template, a BCP 47 tag such as `'de'`, `'de-CH'` or `'en-GB'` (capability `book-language`, included in the contract-1 baseline):

```tsx
export default defineTemplate({ id: 'alpenbuch', version: '1.0.0', contract: 1, language: 'de-CH', /* format, spreads … */ });
```

ImageFlow sets it as `lang` on the root element of every page it renders: the editor's book view and thumbnails, layout previews, the Book check, the presentation, MCP artwork and the exported PDF, so the text is set the same way everywhere. Without it the language is `en`. CSS that depends on the language follows it: `hyphens: auto` hyphenates by the language's rules, `:lang(de)` selects, and `quotes` and `text-transform` use the language's conventions. A tag that is not well-formed is a template error when the template loads; the tag is kept in its canonical form (`de-ch` becomes `de-CH`).

A part of the book can be in another language. `lang` on `<Spread>`, `<Page>`, `<MarkdownBox>`, `<Element>`, `<ctx.Text>` and `<ctx.Caption>` sets it inside that component, and on the template's own elements HTML's `lang` attribute does the same. A malformed tag on a component fails the spread's render with a template error that names the component. A Markdown text can declare its own language in its header, `lang: fr`, which sets it in every box the text flows through, over the box's `lang` (see [Text metadata](boxes-and-elements.md#text-metadata)).

Markdown boxes default to `hyphens: manual`: only soft hyphens (`&shy;`) break words. Opt into automatic hyphenation in the template's CSS, for the boxes or the elements inside them:

```css
.story p { hyphens: auto; hyphenate-limit-chars: 6 3 3; }
```

The text flow measures with the same hyphenation as the printed page, because it lays the text out in the boxes themselves. ImageFlow renders with Chromium on macOS, which hyphenates by the rules macOS ships: German (also `de-CH`), English, French, Italian, Spanish, Portuguese, Dutch, Danish, Swedish, Norwegian, Finnish, Polish, Czech and Russian among others. A language without rules is set without hyphens.

## Fonts and output

- Fonts are declared with `@font-face` in template CSS, from files in `template/fonts/`. Static files only; system fonts are not allowed. Export fails if the PDF contains Type 3 fonts or fonts not shipped with the template. These are platform rules, independent of the format. Omit `output.fonts`: the old `{ allowType3: false, allowSystemFonts: false }` field is deprecated, accepted only for compatibility, and does not change validation. Values of `true` remain invalid.
- Effects that create transparency (opacity, `rgba()` fills, shadows, blend modes, filters, gradients, rounded clipping) are allowed; whether they pass depends on the format's transparency policy, checked at export.
- Text below the format's minimum size and text outside the safe area are reported in edit mode.
- **Characters and strokes.** The Book check reports text whose characters the bundled font has no glyphs for (`font-coverage`, with the characters), since they would print in a system font, and stroked text (`text-stroked`: an SVG `stroke` on text or `-webkit-text-stroke`), since Chromium prints stroked glyphs as a Type 3 font. Both cover text inside SVG too, such as the labels of a vector map. Draw a halo as filled copies of the text shifted around it instead of a stroke.
- **`fonts`** (capability `font-coverage`) tells template code which characters its fonts can set, for text it draws itself, such as labels from map data: `fonts.missing(text, { family, weight?, style? })` returns the characters that cannot be set, `fonts.settable(text, font)` returns the text without them (letters with marks fall back to their base letter, ş → s), and `fonts.list()` the bundled faces. `family` may be a fallback stack, as a CSS string or a list: each character counts as settable when any bundled family of the stack has it, as the browser falls back character by character; the Book check reads text's whole `font-family` stack the same way. Faces are matched as the browser matches them (style, then weight by the CSS font matching rules: a request of 400 prefers 500 to 300), and a face's coverage is its font file's character map, narrowed by its `unicode-range`. An SVG picture placed in the page needs no embedded fonts: its text uses the template's `@font-face` families by name, or by a class the template's CSS styles.
- **Decorative type.** Display type that deliberately runs off the page, or sits behind other type, would raise these findings on every spread that uses it. Mark it `decorative` (a boolean prop of `ctx.Text`, `PhotoBox`, `MarkdownBox` and `Element`, or `data-decorative` on any node) and the Book check skips the text inside it for safe-area, minimum-size, overflow and overlap findings. PDF output is unchanged: the page edge still cuts the text, so only mark type whose cutting is intended. A Markdown box's text-flow overflow, which loses text, is still reported. Text inside SVG is already skipped by these checks.
