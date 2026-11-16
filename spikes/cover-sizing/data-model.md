# Draft cover model for templates

Status: proposal, not a shipped template API. The template supplies cover specifications alongside its existing print formats. The template chooses one print specification, optionally using its own document parameters or editor; ImageFlow resolves one exact cover sheet from that specification and the final interior page count. Cover artwork uses named regions of that sheet.

The proposed [TypeScript model](cover-model.ts) and [declaration examples](cover-model-examples.ts) are checked against the existing `PrintFormat` types. They are isolated sketches; the application and the Kyrgyzstan book are unchanged. The examples reference a proposed authoring helper and are not executable until that helper exists.

## Separate template choices from sizing

The platform-facing contract contains the selected specification only:

```ts
type PrintSpecification = {
  interior: PrintFormat;
  cover?: CoverFormat;
};
```

A template can supply a fixed specification, select among existing named formats, or build one from ordinary document parameters. An illustrative declaration is:

```ts
print: ({ document, formatId }) => ({
  interior: interiorFormat(formatId, document.paper),
  cover: coverFormat(formatId, document.paper, document.binding),
})
```

`print` is a proposed hook, not an existing SDK export. The accompanying types model it as a fixed `PrintSpecification` or a synchronous function from document parameters and the selected format ID. The exact integration with the current `format`/`formats` fields remains an implementation decision; existing formats should adapt to `{ interior: existingFormat }` without requiring changes. Retain the five existing size IDs rather than generating another format for every paper/binding combination.

The template owns whether paper, binding or other choices exist, their labels and defaults, and which combinations it offers. It can use existing parameters and custom editors; it can also expose no choices at all. Printer convenience helpers can be shared without making a variant catalog, paper IDs or binding IDs part of the platform's geometry contract. Unsupported combinations are template findings, not combinations inferred by ImageFlow.

The hook returns one complete interior format and cover specification together. A paper change may alter both spine width and interior page limits or binding-safe insets. Returning the complete effective interior avoids ambiguous overrides or accidentally enforcing an old 112-page limit alongside a selected 200-page inkjet specification. Cover output settings are explicit and independent, including their own maximum PDF file size.

Re-evaluate this pure hook when its document inputs or format selection change, before pagination and geometry resolution. It must not depend on the rendered cover, pagination output, network requests or side effects. The final interior page count is used afterward to select a cover-size band. Validate each returned specification; template fixtures can exercise additional choices. Dynamic templates cannot have all possible parameter combinations checked at initial load, and the platform does not require them to enumerate a finite product catalog.

## Describe a cover as physical regions

A wrap has a common height, explicit front and back panel widths, a spine width, optional flap widths, outer allowances, and safety insets per region. Panel widths are cover measurements; they must not be inferred from the interior trim.

The physical order of an exterior wrap is:

```text
back flap (optional) | back | spine | front | front flap (optional)
```

The flap names refer to the panels they fold into. These flaps are printed on the same exterior sheet; printing the reverse surface of a cover would require another surface declaration later. Physical front/back covers are distinct from the first/last interior pages.

`outer.kind: 'wrap'` means the excess material turns around the board; `'bleed'` means it is cut away. Both use explicit top/right/bottom/left lengths and extend the export sheet beyond its trim boundary. This distinction gives the editor accurate guide labels without adding the allowance twice.

For a wrap, total trim width is the sum of the named region widths. The total sheet adds its outer insets. A `front-panel` cover instead specifies just a width, height, safe insets and outer insets; it has no back, spine or flaps. That accommodates a printed front insert without inventing a zero-width wrap.

`foldAvoidance` optionally describes bands inside the front and back panels next to the spine. It does not increase the sheet size. These bands support guides and warnings independently from the outer safety insets. No exact WhiteWall hinge width is entered in the examples because the source gives a range of 10–12 mm.

## Encode exact sizes as data

Only spine and flap widths vary by page count for the five researched formats. Store them together so the declaration can express Blurb jackets, whose flaps shrink as the spine grows:

```ts
widths: {
  kind: 'page-bands',
  bands: [
    { from: 20, to: 50, value: {
      spine: pt(33), flaps: { back: pt(284), front: pt(284) },
    } },
    { from: 52, to: 100, value: {
      spine: pt(41), flaps: { back: pt(280), front: pt(280) },
    } },
    // Remaining bands from the printer's specification.
  ],
}
```

Bounds are inclusive. First validate the returned interior's page-count rule, then match exactly one band. The gap between 50 and 52 is valid for an even-page rule because 51 is not an allowed page count. Do not interpolate, extrapolate, round the page count, or silently select the closest band.

A constant size uses `widths: { kind: 'fixed', value: { spine: mm(11) } }`. The fixed form also supports a custom measured specification without making dimensions ordinary spread parameters. Flap declarations and widths must agree in every band.

Authors should not have to expand WhiteWall formulas into dozens of rows by hand. The proposed `coverWidths` authoring helper enumerates the allowed page counts and coalesces adjacent equal results:

```ts
widths: coverWidths({
  pageCount: { min: 28, max: 112, step: 4 },
  sizeAt: (n) => ({
    spine: mm(11 + 1.5 * Math.floor((n - 28) / 8)),
  }),
})
```

The helper runs when a specification is built, either during static declaration or inside the selection hook, and returns the same plain `page-bands` data. The selection hook belongs to the template boundary; the geometry resolver and downstream print pipeline receive only normalized data. No function is persisted in the project. This follows the existing `printFormat(...)` helper pattern. It avoids introducing a formula language, an expression evaluator or printer-specific code in ImageFlow. Invalid helper results become template diagnostics when the specification is evaluated.

Lengths retain their existing `mm`, `pt` or `in` units. Authors perform printer rounding in the source unit before returning a length. In particular, the Blurb examples round jacket flaps to whole points before the platform converts to millimetres.

## Resolve once and share the result

`ResolvedCover` contains the export sheet rectangle, trim rectangle, named region rectangles, safe rectangles, fold lines, avoidance rectangles and output constraints, all in millimetres. Its origin matches current geometry helpers: `(0, 0)` is the trim's top-left; the sheet starts at negative outer insets.

For each region, layout placement uses its own rectangle rather than a percentage of the entire cover. A photo crossing the complete wrap can use the sheet rectangle. Front-cover text uses `front`, spine text uses `spine`, and optional flap artwork uses its respective flap region. The proposed render context would expose `ctx.cover` and helpers such as `ctx.cover.geometry.region('front', 'safe')`. These are cover-specific helpers; `ctx.geometry.page('left')` continues to mean an interior page.

The same resolved result drives preview, image-resolution checks, text-safety checks, PDF size and PDF boxes. The PDF export translates trim-relative coordinates to sheet coordinates; its TrimBox is inset by the outer allowances and its MediaBox/BleedBox cover the sheet. Fold and safety guides never become printable artwork.

Resolve against the final delivered interior page sequence, including blank interior pages. Covers never increase that count. Changing page count recomputes both spine and flaps and invalidates the cover render. Paper/binding changes also recompute effective interior constraints and any resulting pagination. A draft below the minimum has an unresolved cover and a diagnostic; a preview based on an assumed count would have to be explicitly labelled as such.

A region can physically exist but have no usable safe rectangle, such as a very narrow spine. Return `safe: null` for it and warn if text is placed there. Do not reject an otherwise printable cover merely because spine text cannot fit. A missing region is different: the selected construction has no such panel or flap.

## Keep cover artwork outside interior spreads

The physical specification is the template's current print specification. The cover's photos, text, crop positions and layout choice belong to a separate cover design state, using the same kinds of boxes, elements and parameters as existing spreads. It must not be inserted into `project.spreads`, numbered as an interior page or counted in the spine calculation.

An illustrative persistence addition is:

```ts
{
  format: 'square',
  params: { paper: 'fuji-velvet', binding: 'hardcover-matte' }, // ordinary template parameters
  cover: {
    definition: 'photo-wrap',              // ID in proposed template.coverLayouts
    params: { title: 'Kyrgyzstan' },
    boxes: { /* same saved content/crop model as spread boxes */ },
    elements: {},
  },
  spreads: [ /* interior units only */ ],
}
```

A template can offer `coverLayouts` separately from `spreads`. They receive cover geometry and have no page `span`. Missing flaps can hide their layout elements while keeping assigned content, as existing layout switching does. A format switch retains the cover artwork and reflows it against the new panel geometry. The existing parameter system owns saved option values and their compatibility rules. An invalid specification must produce a diagnostic and must not silently substitute a different product. There is no platform-owned variant selection to persist.

For the first implementation, export produces two artifacts: the existing interior PDF under the effective interior format and a one-page cover PDF under the cover specification. Their sizes, safety rules and limits are checked independently. Adding another printable cover surface or combined-file delivery can be a later extension without changing the interior spread model.

## Validation and compatibility

When a specification is evaluated, check finite lengths, positive sheet/panel dimensions, legal side names, complete band coverage of permitted interior page counts, no overlapping matches, and matching flap presence. Check each finite band's resulting sheet geometry against the same supported PDF size limits as interior formats. A helper may produce no usable spine-safe area; it may not produce a negative spine width, an invalid flap width or non-finite geometry. Static specifications can be checked at template load; dynamic ones are checked whenever the selection hook runs, with fixtures covering the template's offered choices.

At book check, validate the current specification, final interior count, required cover layout and content safety against the resolved cover. Unknown safety measurements should remain explicit gaps in a printer profile; zero insets mean no additional inset was declared, not manufacturer approval for text at an edge. Blurb's dedicated spine-text inset remains such a gap in the examples.

The existing interior `PrintFormat`, rendering context and project sequence remain the baseline. Shipping the additions requires schema/SDK/MCP inspection support, a template capability for covers, and project-format compatibility handling for the new saved fields. Older clients must not silently strip cover content or treat an unsupported cover declaration as a coverless book. None of those integrations is implemented by this draft.

## Why normalize sizing into bands

The template selection hook can use its ordinary parameter values to choose or construct a specification. Keeping the resulting sizing rules as plain bands separates that selection policy from page-count-dependent geometry. Plain normalized bands also let the host validate every allowed size before the user reaches it, expose the entire specification through MCP, preserve exact printer rounding, and show which page-count change caused a resize. The formula helper provides convenient authoring without putting executable geometry logic into downstream consumers.

The deliberate limit is a rectangular horizontal wrap with constant panel sizes and height within one specification. It covers the five researched formats. A future printer that changes panel size by page count would motivate extending each band's value to a full sheet specification. Arbitrary shape, cut-out or multi-surface packaging should not be forced into this model.
