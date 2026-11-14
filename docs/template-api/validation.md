# Validation

When the template is loaded:

- `id`, `version`, `contract` present; contract version supported; every capability in `requires` provided by this app.
- Exactly one of `format` or `formats`. Unknown declaration properties and `spreadFor` document mismatches are warnings (see [Declaring spreads](declaration.md#declaring-spreads)).
- Unique, stable identifiers for spreads, boxes, elements, and parameters; valid parameter defaults.
- A valid print format.
- Unique `flowOrder` among Markdown boxes of a spread.
- A box ID has one box type, and a parameter ID one parameter type within its scope, across all layouts (see [Switching layouts](switching-layouts.md#switching-layouts)).

When a spread renders:

- Every declared box rendered once; no undeclared box or element ids.
- Assigned files of file parameters exist, are readable, and have an accepted extension; template findings from `issue()` or `data-issue`.
- Valid anchor declarations; each `ctx.book.anchor(id)` lookup finds exactly one anchor (otherwise a warning).
- No rendered content extends beyond the spread's bleed (Markdown overflow is handled by the flow and reported as unplaced text).

At export:

- The format's checks: page count rule, transparency policy, fonts, resolution of each placed photo, file size.

Errors in edit mode appear in Book check. Print export blocks on render errors and PDF preflight failures. Proof export permits reported layout errors, but still requires a successful render and correct PDF page count and dimensions. Warnings do not block print export.
