// The named exports of the `imageflow` module that templates import. The renderer provides them at runtime, the
// bundler exposes exactly these names, and the shipped declarations must declare the same set (src/template-types.ts).
export const runtimeExports = [
  'defineTemplate', 'spreadFor', 'p', 'mm', 'pt', 'inch', 'printFormat', 'Spread', 'Page', 'PhotoBox', 'MarkdownBox', 'Element', 'asset', 'file',
  'geometry', 'box', 'issue', 'capabilities', 'RenderedImage', 'FormattedText', 'plainText', 'Choice', 'fonts',
] as const;

// Contract-1 baseline, open until the first public release (ADR 0008). Templates need no `requires` entries
// for these features. Freeze this list at that release; later additions are extensions.
export const contract1Capabilities = [
  'anchors', 'geometry', 'box-helpers', 'template-issues', 'typed-components',
  // `spreads: ({ spread }) => …`, `ctx.geometry` with `rect` props, `ctx.Text`, `printFormat`, and `box.photos`.
  'spread-builder', 'bound-geometry', 'text-component', 'format-helper', 'box-records',
  // `controls` on spreads, boxes and elements; `Control` and `importFile` in custom element editors.
  'editor-controls', 'editor-native-controls',
  // `layoutFamilies`, with `family` and `variant` on layouts, and a family's picker: a built-in choice or a component.
  'layout-families',
  // `spread` on an element editor: layout parameters it edits together with the element's own.
  'editor-spread-parameters',
  // `openingSpreads`: the spreads a new book starts with.
  'opening-spreads',
  // `facingPages: false` formats and `span: 'page'` layouts: one page per unit instead of facing spreads.
  'single-pages',
  // Page layouts compose either side of a facing sheet, with <Page>, page-local geometry and per-page editing.
  'page-layouts',
  // `context` in custom editors: the spread they were opened from, as `render` sees it, kept current.
  'editor-context',
  // `editors`: editors of document parameters, opened from nodes marked with them.
  'document-editors',
  // `network`: HTTPS origins element editors may reach once the user allows them (ADR 0006).
  'editor-network',
  // `<RenderedImage>`: host-managed asynchronous pictures, which may use the `network` origins in previews, checks
  // and export (ADR 0006).
  'rendered-images',
  // `image/svg+xml` pictures from <RenderedImage>, placed in the page as vectors with the template's fonts.
  'rendered-vectors',
  // `fonts`: the template's bundled faces and the characters they can set, for text drawn outside the page's own
  // text, such as map labels in a vector picture.
  'font-coverage',
  // `credits` on layouts, collected for the book in `ctx.book.credits`, with a warning for credits printed nowhere.
  'book-credits',
  // `presentation: 'inline'` on element and document editors: editing on the page, in the frame it was opened from.
  'inline-editors',
  // Plain string ctx.Text parameters edited in the template's typography.
  'inline-text',
  // `ctx.Caption`: a photo box's caption, marked so it is typed on the page and saved with the photo (UI-019).
  'inline-caption',
  // `p.list`: lists of flat items with stable IDs, a generated list control and item-level project commands (#115).
  'list-parameters',
  // `preview`: the template's own image for New Book, instead of a render of its opening spread.
  'template-preview',
  // `<PhotoBox>` children: a callback that draws the box's photo from its crop, such as through an SVG mask.
  'photo-render',
  // `markdown: 'inline'` on string parameters: **bold**, *italic* and ~~strikethrough~~, shown by ctx.Text and
  // `<FormattedText>` and typed with live conversion and shortcuts in the inline text editor.
  'formatted-text',
  // `<Choice>`: ImageFlow's own segmented choice for custom editors and layout-family pickers.
  'app-controls',
  // `text.meta` on Markdown boxes: the source's YAML header, the same on every box its text flows through; every
  // placed text in `ctx.book.texts`; and `boxes` in `anchors`.
  'text-metadata',
  // `compositions`: named functions that compose a text from its blocks, adding, replacing or wrapping them; a
  // Markdown box names one with `composition`. `data-keep-next` marks elements that stay with the next one (#230).
  'text-composition',
  // `basedOn`: the template a fork was copied from, so it can take an ID of its own in a book made from that one.
  'template-lineage',
  // `language`: the book's language as `lang` on every rendered page, `lang` on platform components and a Markdown
  // text's `lang` header, so hyphenation and :lang() follow it (API-024).
  'book-language',
] as const;
// All supported features, including the baseline names accepted in older templates' `requires` lists. Until the
// first public release the baseline stays open and new features join it (ADR 0008); after it, additive extensions
// go here, and templates using them declare them in `requires`.
export const capabilities = [...contract1Capabilities, 'physical-covers'] as const;
export type Capability = typeof capabilities[number];
