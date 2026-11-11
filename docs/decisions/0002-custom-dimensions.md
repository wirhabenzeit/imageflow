# 0002: Constrained custom output dimensions

Status: proposed, 2026-11-11. Not implemented. This is item 6 and step G of issue #29.

## Context

A template declares one print format, or several named formats (presets) that the user chooses between in Book settings. Named presets cover most products and remain the default. Some templates could support any size within limits, such as a square book from 15 to 40 cm. Today an author would need one preset per size.

Constraints from the current runtime:

- The renderer chooses the format before any layout runs (`chooseFormat` in `src/template.tsx`). It resolves it once (`resolveFormat`) and uses the same geometry for the editor, MCP previews, checks and PDF export.
- Layouts adapt through `ctx.format`, `ctx.formatId`, the geometry helpers and the `--trim-*`, `--bleed-*` and `--safe-*` CSS variables.
- Changing the format keeps assignments, crops and text sources. Text flow, photo resolution and print checks are recomputed.
- A preset that the template no longer offers is previewed in the default format and blocks print export.

## Proposal

### Declaration

A `formats` entry can be a **resolver** instead of a fixed `PrintFormat`:

```ts
formats: {
  square: bookFormat('Square · 29 × 29 cm', 290, 290),
  custom: customFormat({
    label: 'Custom square',
    parameters: { size: p.number({ label: 'Size', default: 250, min: 150, max: 400, step: 10, unit: 'mm' }) },
    resolve: ({ size }) => bookFormat('Square · ' + size / 10 + ' cm', size, size),
    // Optional: sizes the printer accepts, beyond geometric validity.
    supported: ({ size }) => size % 10 === 0 || 'The printer offers sizes in 1 cm steps.',
  }),
},
```

- **Inputs are format parameters**, declared like document parameters and validated by the same schemas. They are stored in `project.json` under `formatParams`, next to `format`. They are not layout parameters, so a format never depends on rendered content, page count or other spreads. This avoids circular dependencies.
- **`resolve` is pure and synchronous.** It returns a complete `PrintFormat`: trim, bleed, safe area, structure and output rules. A resolver may change the bleed or the page-count rules with the size.
- **One resolved format per book**, as today.

### Resolution and validation

1. Validate the format parameters against their declarations. Invalid values use defaults and produce a `parameter-invalid` finding, as document parameters do today.
2. Call `resolve`. A throw or an invalid `PrintFormat` is a template error naming the format. It is caught and reported like a failing layout.
3. Run the existing geometry validation: PDF edges between 10 and 1000 mm, binding bleed within the facing page, and safe insets that leave space.
4. Call `supported` if it is declared. A string or `false` is a `format-unsupported` error. It blocks print export and keeps proof export and previews working. This separates geometrically valid sizes from sizes the printer actually sells.

The renderer resolves the format once per render, before `bookIndex` and layout. The editor, thumbnails, the layout picker, MCP checks, draft previews and export all render through `startRender`, so they all use the same resolved format.

### Editing, Undo and MCP

- **Book settings** shows the format parameters under the format choice. Changing one is a single undoable edit that rerenders and reflows the book, exactly like switching presets.
- **New commands** `set_format_parameter` and `reset_format_parameter` for MCP agents. They can be combined with `select_format` in one batch. Draft checks preview a size before it is saved.
- **`TemplateInfo`** reports the resolved format, the format parameters with their values, and whether the chosen entry is a resolver.

### Compatibility

- **Feature flag:** a template that uses resolvers lists `custom-formats` in `requires`. Apps without the feature report that capability by name instead of failing in `chooseFormat`. This follows the capability mechanism added for the template API work in #29.
- **Fixed formats:** presets behave as they do now. A template can offer presets and a resolver side by side.
- **Saved values:** a project whose saved resolver entry disappears falls back to the default format, like an unknown preset, and blocks print export. Saved `formatParams` stay untouched until the user picks a format again.
- **Contract:** stays at 1, because the change only adds to it. A later contract can require resolvers to declare their parameter ranges statically, if a product catalogue needs them without running template code.

## Validation plan

- Unit tests:
  - resolver parameter validation and defaults;
  - pure resolution, including that throws and invalid formats are reported;
  - geometry failures;
  - `supported` outcomes;
  - Undo of a size change.
- Render tests: a 150 mm and a 400 mm book through the geometry helpers, with the same assignments and crops. Recorded measurements, like the starter geometry baseline, scale as declared.
- Export test: the PDF page boxes match the resolved size to within 0.12 mm, the tolerance of decision 0001.
- MCP test: a draft check with `select_format` and `set_format_parameter` previews the new size without saving it, and applying the same batch saves it as one Undo entry.

## Open questions

- Should format parameters live in the document parameter namespace, which would make them simpler to edit, at the risk of mixing content and product settings? This proposal keeps them separate.
- Should `supported` also receive the page count, so it can enforce product rules such as page limits for larger sizes? The page count is known only after pagination. It would therefore apply as an export check, not as an input to `resolve`.
