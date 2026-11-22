# Package

A template is the `template/` folder of a project:

```
template/
  index.tsx        default export: defineTemplate({...})
  styles.css       imported from index.tsx: @font-face rules, Markdown typography, shared rules
  fonts/           static font files (WOFF2, TTF, OTF)
  assets/          optional SVG or raster artwork used by the design
  spreads/         optional: one file per spread definition
```

The app bundles `index.tsx` with esbuild. `react` and `imageflow` are provided by the host and must not be bundled. Relative imports, CSS imports, and asset imports inside `template/` are allowed. Other packages come from npm through the template's saved dependency bundle ([Dependencies](dependencies.md#dependencies)). Templates must render deterministically without fetching data, timers, state, or effects. This is an authoring requirement, not a guarantee that arbitrary template JavaScript is safe; open only projects you trust.

`imageflow` exports `defineTemplate`, `spreadFor`, `p`, `mm`, `pt`, `inch`, `printFormat`, `Spread`, `Page`, `PhotoBox`, `MarkdownBox`, `Element`, `asset`, `file`, `geometry`, `box`, `issue`, `capabilities`, `RenderedImage`, `FormattedText`, `plainText`, `Choice` and `fonts`. A build fails with a hint to update ImageFlow when a template uses an export the installed app does not have.

## Examples

[`docs/examples`](../examples) holds complete templates that compile against the installed declarations:

| Example | Shows |
| --- | --- |
| `minimal.tsx` | **Quickstart.** One layout with a full-bleed photo, an editable heading, a book setting and a page number. |
| `photo-story.tsx` | Photo and story, text continuation across layouts, chapter anchors and a contents layout. |
| `grid-bleed.tsx` | A photo grid inside the safe area and a full-bleed panorama with a caption. |
| `generated-element.tsx` | Generated SVG content from element parameters, edited by clicking it. |
| `file-input.tsx` | An optional CSV file input, parsed by the template, with a structured finding for bad lines. |
| `editing-levels.tsx` | Editing UI at three levels: generated controls, arranged `controls` with a condition, and a custom editor using `Control`. |
| `responsive.tsx` | Two formats and one layout that arranges itself by the shape of the chosen format. |
| `layout-family.tsx` | A layout family of three variants (grid size × text box, one combination missing) with a picker of two independent choices. |
| `inline-editor.tsx` | An element editor on the page (`presentation: 'inline'`): a focus ring dragged into place where it prints. |
| `list-parameter.tsx` | A list parameter: timeline stops the user adds, reorders and removes, each with a place, a date and a colour. |

Agents receive them with `get_authoring_context` and `includeExamples`. To start a template, copy `minimal.tsx` (or the closest example) and add layouts. To extend one, copy a single layout and its declarations. The starter template is the complete reference book, not a required starting point.

The examples use the generic `serif` and `sans-serif` font families, so they preview anywhere but **PDF export reports them as errors and asks for confirmation**: PDF preflight expects fonts bundled inside `template/` and loaded with `@font-face` from CSS the template imports. Before printing, add font files to `template/fonts/`, import a stylesheet that declares them, and use those families. The starter template shows the pattern ([Fonts and output](css-contract.md#fonts-and-output)).

## Requirements and compatibility

Every supported contract-1 runtime provides the complete baseline below, including document editors, network declarations, rendered images and editing on the page. A template selects it with `contract: 1`; no `requires` list is needed:

```ts
defineTemplate({ id: 'travel', version: '2.0.0', contract: 1, … })
```

| Baseline feature | Provides |
| --- | --- |
| `anchors` | `anchors` declarations and `ctx.book`. |
| `geometry` | The `geometry` helpers. |
| `box-helpers` | `box.photo` and `box.markdown`. |
| `template-issues` | `issue()` structured findings. |
| `typed-components` | `ctx.PhotoBox`, `ctx.MarkdownBox` and `ctx.Element`. |
| `spread-builder` | `spreads` as a function, `spreads: ({ spread }) => ({ … })`. |
| `bound-geometry` | `ctx.geometry` and the `rect` prop of platform components. |
| `text-component` | `ctx.Text`. |
| `format-helper` | `printFormat`. |
| `box-records` | `box.photos`. |
| `editor-controls` | `controls` on spreads, boxes and elements. |
| `editor-native-controls` | `Control` and `importFile` in element editors, and the element's other parameters in the editor dialog. |
| `layout-families` | `layoutFamilies`, `family` and `variant` on layouts, and a family's picker: a built-in choice or a component. |
| `editor-spread-parameters` | `spread` on an element editor: layout parameters edited together with the element's, with `setSpread` and `<Control scope="spread">`. |
| `opening-spreads` | `openingSpreads`, the spreads a new book starts with. |
| `page-layouts` | `page()` declarations, `<Page>`, page-local geometry, side-aware contexts and independent facing pages ([Page layouts](page-layouts.md)). |
| `single-pages` | Formats without facing pages (`facingPages: false`) and `span: 'page'` layouts. |
| `editor-context` | `context` in element and document editors: the spread they were opened from, as `render` sees it, kept current. |
| `document-editors` | `editors`: editors of document parameters, opened from nodes marked with them. |
| `editor-network` | Declared HTTPS origins for editors and rendering, subject to user approval. |
| `rendered-images` | `<RenderedImage>` for host-managed asynchronous pictures in preview, check and export. |
| `rendered-vectors` | SVG pictures from `<RenderedImage>` (markup, an `<svg>` element or an `image/svg+xml` Blob) placed in the page as vectors with the template's fonts, and `output="vector" \| "raster"` ([Rendered images](rendered-images.md#rendered-images)). |
| `book-credits` | `credits` on layouts and `ctx.book.credits`: what the book uses that needs a credit, collected for a credits page ([Credits](anchors-and-index.md#credits)). |
| `font-coverage` | `fonts`: the bundled faces and the characters they can set, for text the template draws itself ([Fonts and output](css-contract.md#fonts-and-output)). |
| `inline-editors` | `presentation: 'inline'` on element and document editors: editing on the page, in the frame of what the editor was opened from ([Editing on the page](editing-on-the-page.md#editing-on-the-page)). |
| `inline-text` | `ctx.Text presentation="inline"` for plain-string typing in template typography, with existing parameter scopes and Undo. |
| `list-parameters` | `p.list` of flat items with stable IDs, the generated list control, `Control` for one item's field, and item-level project commands ([List parameters](list-parameters.md#list-parameters)). |
| `template-preview` | `preview`: the template's own image for New Book instead of a render of its opening spread ([Template previews](template-library.md#template-previews)). |
| `photo-render` | `PhotoBox` children: a render callback that draws the box's photo from its crop, such as through an SVG mask ([PhotoBox render callbacks](platform-components.md#photobox-render-callbacks)). |
| `formatted-text` | `markdown: 'inline'` on string parameters: bold, italic and strikethrough, shown by `ctx.Text` and `<FormattedText>` ([Formatted text](formatted-text.md#formatted-text-formatted-text)). |
| `app-controls` | `<Choice>`: ImageFlow's own segmented choice for element editors and layout-family pickers ([App controls](layout-families.md#app-controls)). |
| `text-metadata` | `text.meta` on Markdown boxes: the fields of the source's YAML header, the same on every box of the chain ([Text metadata](boxes-and-elements.md#text-metadata)); every placed text in `ctx.book.texts` ([Texts](anchors-and-index.md#texts)); and `boxes` in `anchors`. |
| `text-composition` | `compositions`: named functions that compose a text from its blocks, adding, replacing or wrapping them; a Markdown box names one with `composition` ([Composing a text](boxes-and-elements.md#composing-a-text)). |


Use `requires` for extensions beyond the contract-1 baseline. Unsupported extensions are rejected when the template loads, with an update hint. Listing baseline features in `requires` is also valid.

`capabilities` lists all supported features. `get_authoring_context` reports the contract, `baseline`, `capabilities` and module `exports` in `capabilities.templateApi`. The baseline is defined in `src/runtime-exports.ts`.

An app update never rewrites a project's template folder. Renaming an ID, moving a parameter to another scope or changing an ID's type needs an explicit migration in the template and in `project.json`; ImageFlow never reinterprets or deletes saved values on its own.
