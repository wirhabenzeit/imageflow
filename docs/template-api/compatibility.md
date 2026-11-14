# Authoring and compatibility details

Use the generated `.imageflow-sdk/tsconfig.json`, or a project `tsconfig.json` that extends it, to check templates without installing host packages. Run `npm run generate:authoring` and `npx tsc -p sample/starter/template` in this repository. For layouts in their own files, export the document parameters and a builder made from them:

```tsx
// document.ts
export const documentParameters = { accent: p.color({ label: 'Accent', default: '#223344' }) };
export const spread = spreadFor(documentParameters);

// spreads/story.tsx
export const story = spread({
  label: 'Story',
  parameters: { heading: p.string({ label: 'Heading', default: '' }) },
  render: (ctx) => <Spread>
    <ctx.Text parameter="heading" as="h1" style={{ color: ctx.document.accent }} />
  </Spread>,
});
// index.tsx: defineTemplate({ …, parameters: documentParameters, spreads: { story } })
```

Helpers shared between layouts can take a slice of the typed context, such as `Pick<RenderContext<{ label: string }, typeof documentParameters>, 'document' | 'geometry'>`, as the starter's `Paper` and `Caption` do. `mm`, `pt`, and `inch` produce structured lengths for the print-format declaration; use CSS strings such as `'30mm'` in React styles. They are not CSS values.

`MarkdownBox` accepts `columns` (default 1, rounded and clamped to 1–6). Use `style={{ columnGap: '5mm' }}` for the gap. Text continues down each column, then through the next assigned box in spread/flow order. Expose a box parameter and pass its resolved value to `columns` if users should control it. Column layout remains platform-owned; avoid overriding its flow machinery with CSS.

Numeric `step` is a control increment, not a runtime divisibility constraint. Month precision changes the picker; it writes `YYYY-MM-01`, but existing valid ISO dates are not normalized. Use first-of-month defaults and bounds for month parameters.

Adjusting a selected photo draws it over the box's on-screen rectangle, so it assumes the box is upright. If template CSS rotates or skews a `PhotoBox` (or an ancestor inside the spread), the editor offers only the numeric crop values for it. Clicks act on the box or element drawn on top, in document order; content stacked with `z-index` is not accounted for.

Identifiers start with a letter or digit, then contain letters, digits, underscores or hyphens; reserved Object prototype names are rejected. Dots separate edit-path scopes and cannot occur in identifiers. PhotoBox, MarkdownBox and Element automatically expose their declared parameters; explicit edit marks add parameters. Ordinary nodes need `ctx.edit` or `ctx.Text`. Exported artwork keeps the invisible `data-edit` marks, so checks can name the parameter a text block shows. Avoid overlapping targets or marking several nodes with the identical path list: the current editor identifies targets by spread and path list.

## Persistence and evolution

`project.json` has `schemaVersion: 1`, `title`, `template: { id, version }`, document `params`, `texts` (ID → relative path), and ordered `spreads`. Each spread has `id`, `definition` (its current layout), and one `params`, `boxes` and `elements` state shared by all its layouts; see [Switching layouts](switching-layouts.md#switching-layouts). The example above shows one spread, not a complete project. Photo metadata is keyed by stable photo ID in `photos.json`; dimensions are derived from image files. Crop centers are normalized 0–1; zoom is 1–20. Constraints are checked on rendering; invalid saved values remain stored and render using defaults. Sources remain in the project even when no box uses them.

New projects copy the starter template. Updating the app does not replace existing project templates. Every supported contract-1 runtime provides the baseline above. Extensions after the first public release will use `requires`; keep the app and authoring declarations aligned. Renaming an ID or moving a parameter between scopes requires an explicit project-data migration; there is no automatic migration framework. Photobook starter 0.9.0 replaced the document `paper` and `accent` parameters with `theme`, moved `textSize` from the story and text layouts to the document, replaced the grids' `gutter` with the document `spacing`, removed the calendar layout (the Wall calendar starter has its own) and anchors stories as `section` under `chapter` openers; books made from earlier versions keep their own template and are not migrated.

## Preview limitations

The editor renders the whole book for the canvas and again for thumbnails. Layout choices render independently and restart Markdown from the beginning; they are composition previews, not previews of the actual continuation fragment. Review the main book and exported proof for final flow. Large-book latency and memory use need separate measurement.

The API is the in-process `imageflow` template module. There is no documented public REST or automation API. Desktop IPC and frame messages in `src/desktop.ts` are internal implementation details.

## Enum maps and scaled CSS lengths

`p.enum({ label: 'Language', options: { en: 'English', de: 'Deutsch' }, default: 'en' })` normalizes to the existing array-of-options declaration with labels. Keys become string saved values, including unquoted numeric keys; TypeScript checks the string default against those keys. Maps follow JavaScript property enumeration order: array index keys (such as `'2024'`) are sorted first in ascending order, then other string keys keep insertion order. Use the array form when option order must be explicit. Array options and separate labels remain supported.

`const at = ctx.geometry.design({ width: 420, height: 297 })` exposes `scaleX` and `scaleY`. `at.length(19, 'pt', 'x')` returns a CSS length, rounded to two decimal places. Choose `x`, `y`, `min` or `max` explicitly, including for type sizes; positions still scale on their respective axes. Units are `mm`, `pt` or `px`. Canvas dimensions must be positive and finite. The calendar uses the x axis to preserve its existing typography.

## Generated authoring SDK

The canonical SDK is `authoring/`. `npm run generate:authoring` generates standalone snapshots for both shipped templates; the build runs it automatically. Their tiny `tsconfig.json` extends `./.imageflow-sdk/tsconfig.json`. No template maintains a declaration copy or synchronization test.

Creating a book writes the installed SDK into `template/.imageflow-sdk/`. Exporting a template includes a fresh snapshot in the archive for external authoring, without changing its source folder. App import discards all archive-supplied SDK folders, at any depth; new books and subsequent exports use the installed SDK instead. Existing books are never rewritten when opened. The snapshot includes React declarations, a standalone TypeScript configuration and `api.json` identifying contract 1 and the SDK content digest. Outside ImageFlow, run `tsc -p .imageflow-sdk/tsconfig.json`, or extend that configuration from your own `tsconfig.json`.

`.imageflow-sdk/` is reserved for generated tooling. It is excluded from template hashes, saved-input revisions and runtime imports; the app always checks against its installed SDK. Authored source and other declaration files remain part of template identity. An export may contain different tooling bytes after an app update while retaining the same authored-template hash.

## Actual element geometry in editors

`context.elements[id].rect` is the element’s measured bounding rectangle in millimetres relative to the spread’s trim origin. It comes from the current page, including CSS sizing, rather than reconstructing a whole-spread rectangle. It is `null` before the current page is ready or when the element is not rendered. CSS rotation or skew yields a bounding rectangle. Changes of format, layout, element size, or DOM content/class/style that moves an element refresh the measurements; ordinary editor draft overlays preserve them.

The map editor waits for its first measurement, uses the actual output aspect ratio and width to frame the map, and keeps its existing map stable while the book redraws. Saved map settings remain ordinary parameters.
