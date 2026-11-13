// The named exports of the `imageflow` module that templates import. The renderer provides them at runtime, the
// bundler exposes exactly these names, and the shipped declarations must declare the same set (src/template-types.ts).
export const runtimeExports = [
  'defineTemplate', 'spreadFor', 'p', 'mm', 'pt', 'inch', 'printFormat', 'Spread', 'PhotoBox', 'MarkdownBox', 'Element', 'asset', 'file',
  'geometry', 'box', 'issue', 'capabilities', 'RenderedImage',
] as const;

// Frozen contract-1 baseline. Every supported contract-1 runtime provides all of these; templates need no
// `requires` entries for them. Keep this list fixed when adding extensions after the v1 freeze.
export const contract1Capabilities = [
  'anchors', 'geometry', 'box-helpers', 'template-issues', 'typed-components',
  // `spreads: ({ spread }) => …`, `ctx.geometry` with `rect` props, `ctx.Text`, `printFormat`, and `box.photos`.
  'spread-builder', 'bound-geometry', 'text-component', 'format-helper', 'box-records',
  // `controls` on spreads, boxes and elements; `Control` and `importFile` in custom element editors.
  'editor-controls', 'editor-native-controls',
  // `layoutFamilies`, with `family` and `variant` on layouts, and a family's own layout picker.
  'layout-families',
  // `spread` on an element editor: layout parameters it edits together with the element's own.
  'editor-spread-parameters',
  // `openingSpreads`: the spreads a new book starts with.
  'opening-spreads',
  // `facingPages: false` formats and `span: 'page'` layouts: one page per unit instead of facing spreads.
  'single-pages',
  // `context` in custom editors: the spread they were opened from, as `render` sees it, kept current.
  'editor-context',
  // `editors`: editors of document parameters, opened from nodes marked with them.
  'document-editors',
  // `network`: HTTPS origins element editors may reach once the user allows them (ADR 0006).
  'editor-network',
  // `<RenderedImage>`: host-managed asynchronous pictures, which may use the `network` origins in previews, checks
  // and export (ADR 0006).
  'rendered-images',
] as const;
// All supported features, including the baseline names accepted in older templates' `requires` lists.
// Future additive extensions go here, and templates using those extensions declare them in `requires`.
export const capabilities = [...contract1Capabilities,
  // `presentation: 'inline'` on element and document editors: editing on the page, in the frame it was opened from.
  'inline-editors',
] as const;
export type Capability = typeof capabilities[number];
