# Authoring feedback foundations (#18)

This increment supports the first part of the authoring loop: edit project-owned template files, preserve useful artwork when an edit fails, and check/render current inputs through an app-owned service. The local MCP prototype now builds on this service; see [connection setup and workflow](mcp.md).

## Implemented boundaries

- Template/content reloads keep the last successful book visible while a replacement builds. Failed builds remain visibly stale, and stale canvas interactions cannot save edits.
- Open inline and custom-editor drafts are paused during a reload. Inline drafts resume when their declaration and saved values still match; incompatible drafts remain visible with conflict guidance instead of overwriting new values.
- The watcher also notices external project/index changes. Exact manifest bytes let it skip delayed events for changes already loaded or saved by the app. External project-state adoption clears incompatible in-memory Undo history; template-only reloads do not become project Undo entries.
- Input revisions hash project/index bytes, the contained template tree, and registered Markdown/photo/file inputs. Missing registered inputs have stable missing markers so the renderer can still report their problems. Cache and editor temporary files are excluded.
- A read-only check refreshes inputs from disk, checks content revisions and filesystem change tokens around loading and rendering, and discards results when those inputs change, including ordinary edits that are reverted before rendering finishes. Each check uses a private disposable image cache. The check does not save or adopt project state or change the editor's history.
- Page/spread PNG or JPEG artwork comes from the whole-book renderer after text flow. It does not use the layout picker's independent text fragments.
- Compiler errors retain file, line, and column. Layout findings carry stable codes, their spread, box, element or source, measured values and a suggested fix. See [diagnostics](mcp.md#diagnostics).
- MCP checks can render an unsaved command batch on top of the saved book, so a new layout can be previewed in the real text flow before it is inserted. See [draft previews](mcp.md#draft-previews).

## Internal app API

The Electron preload exposes `checkBook(id, request)` and `cancelCheck()` to the editor. These are internal app integration points. External agents use the local MCP bridge documented in [mcp.md](mcp.md). The current session ID is the same one used by existing save/export calls and changes when the app adopts a new project state.

```ts
const result = await window.imageflow!.checkBook(currentSessionId, {
  // Optional: refuse a check if the inputs differ from an earlier result.
  expectedRevision: previouslyInspectedRevision,
  preview: {
    target: { spread: 'spread-id', side: 'right' },
    bounds: 'trim',
    maxEdge: 1000,
    format: 'png',
  },
});
```

Omit `preview` to check the book without generating an image. A preview target can identify a spread, a specific side of that spread, or a current physical page number. An inactive side of a single-page end is rejected. Resolution is bounded to 1600 pixels on the longest edge. `bounds: 'bleed'` includes the output bleed; trim is the default.

An IPC failure returns `{ error }`. A completed check returns `{ value }`, with:

- `state`, attempted input `revision`, and structured `diagnostics`.
- `checks.bundle`, `checks.layout` and opt-in `checks.typescript`; `print` explicitly reports `not-run`.
- `render`, when available, with the actual template declarations, page sequence, flow positions, and findings.
- `image`, when requested and available, with MIME type, base64 data, pixel/physical dimensions, spread identity, page side, and page numbers.

`state: 'ready'` means rendering completed. Layout errors may still be present, and it does not imply print readiness. `revision-conflict` and `source-changed` results must be handled by inspecting/checking again rather than treating an old image as current.

## Scope and limitations

The prototype adds the local MCP connection, stable open-project handles, typed command batches, shared UI/MCP Undo, draft protection and recoverable manifest saves. Local authoring checks now include opt-in installed-runtime TypeScript validation, contact sheets, box/element close-ups and focused element measurements. PDF preflight, synthetic fixture content and broader client verification remain in #18. The template API additions from #29 (geometry, box and finding helpers, typed IDs, anchors, capability requirements and examples) are described in [template-api.md](template-api.md); constrained custom dimensions are proposed in [decision 0002](decisions/0002-custom-dimensions.md).

UI and MCP writes share the app-owned session and history. Agent mutations acquire an editor lease and serialize with saves and imports. Read-only agent checks can run while UI edits proceed; revision verification rejects changed-input results. Draft protection is deliberately conservative: any focused field or open editor blocks an agent mutation until the human finishes it.

Checks use before/after content and filesystem metadata verification rather than a fully immutable filesystem snapshot. Ordinary concurrent changes are rejected, but this is not an atomic transaction with an external file writer. Temporary-file activity inside a template directory can conservatively invalidate a check. The current renderer still resolves the whole book; large-book performance and finer invalidation require measurement.

Preview capture uses screen-media artwork with export-mode content. Print-specific CSS and arbitrary CSS background-image readiness are not covered by the image equivalence tests. PDF preflight remains the final output check.

Template code continues to run within the existing renderer trust boundary. The check API does not permit arbitrary script execution, arbitrary paths, or project mutations.
