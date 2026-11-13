// The named exports of the `imageflow` module that templates import. The renderer provides them at runtime, the
// bundler exposes exactly these names, and the shipped declarations must declare the same set (src/template-types.ts).
export const runtimeExports = [
  'defineTemplate', 'spreadFor', 'p', 'mm', 'pt', 'inch', 'printFormat', 'Spread', 'PhotoBox', 'MarkdownBox', 'Element', 'asset', 'file', 'imageFile',
  'geometry', 'box', 'issue', 'capabilities',
] as const;

// Template API features this runtime provides beyond contract 1 as first released. A template lists the ones it
// needs in `requires`; an app without one of them reports which, instead of failing somewhere in a layout.
export const capabilities = [
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
  // `imageFile(id)` for PNG, JPEG and WebP file parameters, and `saveFile` in custom element editors (ADR 0006).
  'image-files', 'editor-save-file',
] as const;
export type Capability = typeof capabilities[number];
