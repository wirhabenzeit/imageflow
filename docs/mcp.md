# Local agent connection

ImageFlow exposes its open book to local MCP clients through a stdio bridge. The app owns project validation, persistence and Undo. The bridge forwards tool calls to the running app and returns page images as MCP image content.

## Connect

1. Open an editable project in ImageFlow.
2. Choose **Connect an agent…**, then **Enable local connection**.
3. Copy the displayed `mcpServers.imageflow` configuration into your agent’s MCP settings. It contains the bridge executable and the path to a connection file.
4. Close the connection dialog so ImageFlow can accept book edits. Connect or restart the MCP server in your agent.

The bridge requires Node.js 22.20 or newer. If your client cannot find `node`, replace the configuration’s `command` with the absolute path to your Node executable. Keep ImageFlow open while using its tools.

The connection dialog shows attached client names. **Disconnect agents** closes their app connections and removes the connection file. Enabling again creates new credentials. An existing bridge reads the current connection file before each call and can reconnect after it has been enabled again.

For a development checkout, `node scripts/build-mcp.mjs` creates `.build/mcp-bridge.cjs`. Desktop staging bundles that bridge and includes this document. A standalone invocation has the following form, using the connection path supplied by the app.

```sh
node /absolute/path/to/mcp-bridge.cjs --connection /absolute/path/to/mcp-connection.json
```

The connection file contains a local Unix socket address and a random access token. It has mode `0600`, and its socket lives in a private `0700` temporary directory. The connection currently supports macOS and Unix systems. The bridge uses the official MCP TypeScript SDK’s stdio transport. [SDK documentation](https://ts.sdk.modelcontextprotocol.io/v2/)

## Authoring workflow

Call `list_projects` and use the returned `project` handle explicitly in subsequent requests. A handle remains stable across edits and reloads. Opening another book, reopening a book, or restarting the app creates a new handle.

Read `get_authoring_context` for template declarations, supported operations, source paths and the installed template API. An agent with workspace access can edit files inside `template/` and existing Markdown files inside `texts/`. While the book is open, change project state through `apply_project_changes` or the UI. Register new content through `import_sources`.

Call `check_book` after source edits. It refreshes inputs from disk, bundles the template, resolves the whole book and returns diagnostics. Request a page or spread image when checking its composition. A template error leaves the last successful artwork visible in the app with a stale indication. Correcting the source triggers another reload.

Every inspection/check result identifies an input revision. Pass that revision as `expectedRevision` when applying commands or importing files. Obtain a fresh revision after a change. A revision conflict requires another inspection or check before preparing the next edit.

## Tools

| Tool | Arguments and result |
| --- | --- |
| `list_projects` | No arguments. Returns the currently authorized open project, its stable handle, writable state and current revision. |
| `get_authoring_context` | `project`, optional `includeSource`. Reads up to eight requested paths inside `template/` or `texts/`, with declarations and authoring guidance. |
| `inspect_book` | `project`, `view` of `summary`, `spreads`, `sources`, `parameters` or `elements`, optional `spread`, `offset` and `limit`. The `elements` view requires `spread` and optionally filters by `box` or `element`. Results are paginated with at most 100 records per call. |
| `check_book` | `project`, optional `expectedRevision`, `preview`, `inspect`, `typescript` and `draft`. Combines check coverage, diagnostics, measured element inspection and optional artwork. With `draft`, it renders an unsaved command batch on top of the saved book. |
| `apply_project_changes` | `project`, `expectedRevision`, `idempotencyKey`, `label`, `operations`, optional `dryRun`. Validates the complete batch and applies it through the app. One successful batch creates one named Undo entry. |
| `import_sources` | `project`, `expectedRevision`, `idempotencyKey`, `kind`, `paths`, and `accept` for file inputs. Registers files copied into this project’s `inbox/` folder and returns source IDs. |

Tool argument schemas are advertised through `tools/list`. The app validates them again before execution. Requests use only the selected project handle, even if the foreground book changes during a call.

Context and inspection remain available when a manifest is malformed or missing: results retain check diagnostics and safe template sources. Unavailable parsed sections are omitted or empty, and `revision` is `null` when the complete input set cannot be captured. Repair the reported files and check again before attempting a mutation.

The open project owns a bounded file index. Its first capture hashes registered originals; later captures reuse content hashes while rechecking resolved paths, file identity, size, modification/change timestamps and template directory membership. Watcher events invalidate affected files immediately, before preview reload is debounced. Missing event paths, watcher failure and system resume invalidate the entire index. Every tool operation still reconciles metadata, so it does not depend on watcher delivery alone. Closing or reopening a project retires its index.

Context and inspection reuse the latest successful whole-book check only while both its content revision and local observation remain current. A successful preview can supply those same declarations and diagnostics without retaining its image. An explicit `check_book` always validates and renders again. A delayed watcher notification with identical content and filesystem metadata may cause one fresh check retry; actual changed inputs still invalidate the result.

Each render check uses a private rendition folder. Only a completed check whose inputs remained valid can supply generated photo renditions to later checks. Reuse is limited to current photo identities and at most 2048 files / 512 MiB per open project; failed attempts are discarded. This avoids resizing unchanged originals again while still rendering the whole book for every explicit preview. Mutation preparation may also retry once for generation-only notification delays, before any save or import occurs.

### Page images

Address a physical page with a spread ID and side.

```json
{
  "project": "handle-from-list_projects",
  "preview": {
    "target": { "spread": "arrival", "side": "right" },
    "bounds": "trim",
    "maxEdge": 1000,
    "format": "png"
  }
}
```

Omit `side` to capture the whole spread. A single-page opening or closing layout produces its available side. Requesting its inactive side returns a target error. A target of `{ "page": 3 }` uses physical book numbering and also requires `expectedRevision`.

The defaults are trim bounds, PNG and 1000 pixels on the longest edge. Set `bounds` to `bleed` for output bleed, or `format` to `jpeg`. The longest edge may be between 1 and 1600 pixels. Images contain clean export-mode artwork after whole-book text flow, including the actual continuation on later pages. Metadata includes pixel and millimetre dimensions, spread identity, side, page numbers and rendering bounds. Image bytes appear once in an MCP image block. The text and structured result carry the image metadata.

A rendered image can accompany layout or type errors. TypeScript checking is opt-in; print preflight remains `not-run`. Capture uses screen-media artwork. Print-specific CSS and synthetic fixture content remain follow-up work. CSS background-image readiness has not been verified by the preview equivalence tests.

### TypeScript feedback

Set `typescript: true` on `check_book` to check template code against declarations shipped with the installed app. This is separate from bundling: an annotation such as `const count: number = 'wrong'` bundles but produces a `typescript-error` with a TypeScript diagnostic number, source path, one-based line and column. Usable artwork still returns with `state: ready`; check `checks.typescript` and diagnostic severities before treating a result as valid.

The compiler uses fixed strict settings and the installed `imageflow`, supported React and JSX types. It does not use the project's `tsconfig.json` settings, install packages, execute template code, or trust copied `template/types/imageflow.d.ts` declarations. Local TS/TSX, MTS/CTS and declaration files are checked; JS/JSX and MJS/CJS can participate but are not checked with `checkJs`. Relative JSON imports retain their inferred types, and TXT imports are strings. The `typecheck` result lists source files, total diagnostic count, truncation and elapsed milliseconds. The same before/after revision verification covers type checking and rendering; changed inputs discard the findings.

Checking runs off the app thread with a 15-second deadline, cancellation and a 256 MiB worker heap limit. The template source snapshot, including JSON files, is limited to 512 files / 8 MiB, and at most 50 diagnostics are returned. Timeout, resource or compiler availability failures are explicit diagnostics, never a successful type check. Ordinary context/preview calls omit this work unless requested, and typed results never enter their shared cache. A typed draft checks template code once and reuses those findings only after verifying the draft against the same revision.

### Contact sheets and close-ups

A contact sheet renders up to 12 specified spreads in one whole-book render, including the correct later-page text continuation. The array order determines cell order. Single-page ends occupy their available side. Labels identify spread IDs and physical pages; they are outside the artwork.

```json
{
  "project": "handle-from-list_projects",
  "typescript": true,
  "preview": { "target": { "spreads": ["arrival", "story", "closing"], "columns": 2 }, "maxEdge": 1200 }
}
```

Contact-sheet `maxEdge` ranges from 128 to 1600; columns range from 1 to 4 (default 3). `image.kind` is `contact-sheet`. Its `cells` include pixel rectangles, spread/page identities, physical dimensions, bounds and labels. The collage itself has no physical print size. The result uses the same single native MCP image block as a page preview. Cells fit without stretching, so empty space is expected when page shapes differ.

For a close-up, use `preview.target: { "spread": "arrival", "box": "hero", "paddingMm": 2 }`, or use `element` instead of `box`. Padding defaults to 2 mm and is bounded to 0–20 mm. The axis-aligned crop is clipped to the spread's trim/bleed bounds and keeps neighboring artwork. `image.detail` identifies the owner and crop origin in millimetres from the sheet's outer bleed corner. Missing or entirely clipped targets return `preview-target-not-found`.

### Focused element inspection

Use `inspect_book` with `view: "elements"` and a `spread`, or combine `inspect` with artwork in one `check_book` call:

```json
{
  "project": "handle-from-list_projects",
  "inspect": { "spread": "arrival", "box": "hero" },
  "preview": { "target": { "spread": "arrival", "box": "hero", "paddingMm": 2 }, "maxEdge": 800 }
}
```

The standalone tool returns `items`, `total` and `nextOffset`; combined checks put the same result in `render.inspection`. Measurements are taken after whole-book flow, before preview scaling. Each item includes its stable ID/kind, assigned source when present, axis-aligned `boundsMm`, an `upright` flag, the owner's computed typography and its declared parameter edit paths. Coordinates use `sheet-bleed-mm`, with the origin at the full sheet's outer bleed corner. Typography describes the owner element's computed style; nested headings or spans may have different styles. `lineHeightPt: null` means CSS `normal`. No CSS source location or arbitrary DOM identity is inferred. Custom `ctx.edit(...)` markers on other DOM nodes are outside this inspection scope.

Inspection requires one spread and supports either a `box` or `element` filter, plus `offset` and `limit` (default 30, maximum 100). Draft `$aliases` work in inspection, close-up and contact-sheet targets. Measurements and cells from an unsaved draft describe that draft and do not enter the saved-book inspection cache.

### Draft previews

Test a layout before it is in the book by passing an unsaved command batch as `draft.operations`. It uses the same operations as `apply_project_changes`. ImageFlow applies the batch to the freshly loaded book of `expectedRevision`, which is required, and renders the result through the normal whole-book flow. A preview target may name a spread the batch inserts or duplicates by its batch reference, such as `$chapter`.

```json
{
  "project": "handle-from-list_projects",
  "expectedRevision": "revision-from-inspection",
  "draft": { "operations": [
    { "op": "insert_spread", "definition": "chapter", "ref": "chapter", "after": "arrival", "params": { "heading": "North" } }
  ] },
  "preview": { "target": { "spread": "$chapter" }, "maxEdge": 1000 }
}
```

Nothing is saved, recorded in Undo or shown in the editor. The result's `draft` field reports `applied`, `committed: false`, the planned changes, affected spreads, resolved references and whether text reflows. Its image metadata carries `draft: true`. Diagnostics, page numbers and text flow describe the drafted book. Command errors such as `SPREAD_NOT_FOUND` or `REFERENCE_NOT_FOUND` are returned as tool errors, as for `apply_project_changes`. A changed revision returns `revision-conflict` with `draft.applied: false`. When the draft looks right, send the same operations to `apply_project_changes`.

A draft can also repair a saved book whose layout fails to render, for example because a parameter value makes it throw. The check keeps the declarations of the template that loaded at that revision, and both the draft and the committed batch are planned against them. A finished failed reload in the app does not block the agent's mutation. Open editors, focused fields and reloads still in progress do. A template that fails to compile has no declarations, so it must be fixed in source first.

### Diagnostics

Layout findings use one envelope: `code`, `severity`, `stage`, `message`, an optional `location` with `spread`, `box`, `element`, `source`, `parameter` and readable `where`, optional `details` with measured and allowed values, and an optional `suggestion` that names a template edit or command. Stable render codes include:

| Code | Location and details |
| --- | --- |
| `text-overflow` | Last box of the text chain and its Markdown source; `overflowCharacters`, `boxes`, `path`. |
| `text-source-missing` | First box of the chain and its source. |
| `photo-resolution-low` | Photo box and source; `ppi`, `minimumPpi`, `boxWidthMm`, `boxHeightMm`. |
| `photo-missing`, `photo-decode-failed` | Photo box and source. |
| `font-load-failed` | `family` of a `@font-face` whose file could not be loaded or decoded. The book renders with a fallback font. A font file that does not exist is a `template-compile-error`. |
| `outside-bleed` | Box or element; positive overshoot per side in millimetres. |
| `text-too-small` | Box or element containing the smallest text; `sizePt`, `minimumPt`. |
| `text-outside-safe-area` | Box or element with the largest overshoot; `overshootMm`. |
| `file-missing`, `file-unreadable`, `file-type` | Parameter and file source, with the box or element when it owns the parameter. |
| `parameter-invalid`, `content-undeclared`, `element-undeclared`, `edit-path-unknown` | Saved values or edit markers the current declarations do not accept. |
| `format-unavailable`, `page-sequence` | Book-level format and page-count findings. |
| `template-issue` | A template-reported `data-issue`, located on its box or element. |
| `anchor-missing`, `anchor-ambiguous` | The spread whose `ctx.book.anchor(id)` found no anchor, or several; `anchor`, and `declared` for ambiguous lookups. |

`render.anchors` lists every declared anchor with its spread and resolved page, in page order. A draft check reports the anchors of the drafted book.

Findings without a specific code use `layout-error` or `layout-warning`. Compiler errors use `template-compile-error` with file, line and column.

### Project command batches

Use a unique `idempotencyKey` for a new request. If the connection is lost after sending a request, retry the exact same arguments and key. The app retains successful receipts for the open project session. Reusing a key with different arguments returns an idempotency conflict. A dry run validates and describes the batch without committing it.

`move_spread` requires an explicit `after`: use `null` for the start, or a spread ID or `$alias` to move immediately after that spread. Omitting the destination is a validation error. For insertion, omitting `after` appends; for duplication, it places the copy after the original.

This batch inserts a layout and assigns a photo to its new spread through a batch-local reference.

```json
{
  "project": "handle-from-list_projects",
  "expectedRevision": "sha256-from-inspection",
  "idempotencyKey": "add-chapter-1",
  "label": "Add chapter opening",
  "operations": [
    { "op": "insert_spread", "definition": "chapter", "after": "arrival", "ref": "chapter" },
    { "op": "assign_source", "spread": "$chapter", "box": "hero", "kind": "photo", "source": "registered-photo-id" }
  ]
}
```

Use a real 64-character revision from the preceding inspection/check. Layout, box and source IDs must come from that book’s declarations and source registry.

The advertised command union supports title and format selection, declared parameter set/reset, spread insertion/duplication/movement/removal, compatible layout switching, source assignment/clearing, content swaps, crops and photo metadata. Inserted spreads can include initial parameters, boxes and elements. Batch-local references refer to earlier insertions or duplications. Results describe affected spreads, references, retained content and reflow consequences. Invalid batches leave saved project state untouched. Missing content and layout diagnostics can remain after a valid command.

ImageFlow conservatively blocks agent mutations while any human field or editor is active. Finish or cancel the human edit and close modal editors before retrying an edit-in-progress result. External project-state edits establish a new history boundary when adopted by the app. Template and Markdown file edits are separate from project Undo.

### Source imports

An agent with filesystem access first copies source files into the project’s `inbox/` directory. Obtain a current revision, then register them.

```json
{
  "project": "handle-from-list_projects",
  "expectedRevision": "sha256-from-inspection",
  "idempotencyKey": "import-photos-1",
  "kind": "photo",
  "paths": ["inbox/coast.jpg", "inbox/mountains.png"]
}
```

Use `kind: "markdown"` for Markdown sources. File parameters use `kind: "file"` with an `accept` array such as `[".gpx"]`. Every path must resolve inside this project’s `inbox/` directory, including symlink resolution. Each call accepts at most 20 paths and 100 MB of source data. Registration into the source library is retained rather than undone; later assignment changes have normal Undo/Redo. Registered originals are retained for saved assignments and Undo/Redo. Clearing an assignment does not delete its source.

## Limits and recovery

The socket accepts at most eight attached clients and four outstanding calls per client. ImageFlow queues overlapping agent requests in arrival order, with at most 32 waiting requests. Requests wait for active UI operations and earlier agent work; mutations retain exclusive access and the human-editing check. A full queue returns `AUTHORING_QUEUE_FULL`. Transport requests are limited to 1 MiB. Responses, including emitted MCP image content and metadata, are limited to 8 MiB. Reduce page resolution, requested source files or pagination size when a payload is too large.

A connection handshake has a five-second timeout. An individual bridge call has a two-minute timeout including time spent waiting in the queue, and artwork rendering has a separate one-minute timeout. MCP cancellation propagates to the app. Disconnecting or revoking a connection cancels its pending work; cancelled waiting requests never execute. A committed mutation can outlive the response, so use the original idempotency key when recovering from a lost response. Normal app shutdown waits for accepted saves and lock release.

Closed project handles and unavailable connections return actionable errors. Call `list_projects` for current handles, or re-enable the connection in ImageFlow when the app connection has closed. Inputs changing during a check invalidate its result and require another check. Compilation diagnostics retain source paths and positions when the compiler provides them.

ImageFlow records interrupted manifest saves in `.imageflow/persistence/pending-save.json`. A writable reopen completes the save when each live manifest matches its recorded original or intended bytes. Read-only checks refuse a pending save until that recovery completes. An interrupted durable tool save returns `SAVE_RECOVERY_REQUIRED` with `committed: "pending"`; reload the book and inspect it before making another change. Its idempotency key cannot repeat the command in that open-project session. A different or missing live manifest produces a conflict and preserves the journal and staging evidence. Restore each conflicting manifest to its recorded original or intended bytes, or restore a consistent backup before reopening.

Version-2 journals store before/after bytes only for changed manifests and a SHA-256 guard for each untouched manifest. Recovery checks the complete pair, including guarded files, before publishing changes. A guarded file that changed needs its original bytes restored from a backup; the journal does not contain a copy. Version-1 journals remain recoverable.

Writer ownership is recorded in `.imageflow/writer.lock`. New locks use a private local socket outside the project to verify the owning app, so a reused process ID cannot block recovery. Moving or removing the open folder does not prevent switching projects or closing the app. A live owner blocks a writable open; a confirmed absent owner allows recovery while preserving its record. Permission errors or an unresponsive owner fail closed when acquiring ownership. On release, a damaged or unreadable old record is preserved and reported, its ownership proof is retired, and switching to another successfully loaded project proceeds. Legacy version-1 locks still use conservative PID checks; an apparently live PID requires manual verification. A malformed lock or interrupted `.imageflow/writer-lock-acquire` gate also needs manual recovery. Close all ImageFlow instances, back up the project and lock/journal evidence, and verify that no writer remains before moving an orphan gate or malformed lock aside. Keep pending save journals and abandoned save/recovery staging directories available for inspection until the saved manifests have been reconciled.

Imported-file watcher receipts retain exact filesystem fingerprints for at most 2048 paths. A queued event pins its receipt while other work delays processing. The one-minute duplicate-event grace starts at the first verified consumption and is not renewed by repeats. Unobserved writes expire after five minutes. Evicted receipts may cause an extra reload; changed fingerprints always trigger external-change handling.

Source consistency uses content revisions, filesystem metadata and watcher generations around loading/rendering. It detects ordinary concurrent edits, including edits reverted during a check. Cached digests rely on filesystem identity and timestamps changing when an unwatched file changes; this is not an immutable input snapshot. External writers can still race outside those observations. Immutable snapshots, broader validation fixtures and additional client compatibility testing remain part of the full authoring release.

## Verification

`tests/mcp-connection.test.ts` exercises token rejection, private file/socket permissions, argument/path validation, request/response limits, cancellation, revocation, reconnection and SDK client tool discovery/image delivery. `scripts/smoke-mcp.mjs` exercises a real running ImageFlow instance with the official SDK client. Desktop preview/reload smoke tests cover later-page flow, proof agreement, single-page ends, asymmetric bleed and recovery after template errors.

See [the large-book benchmark](authoring-performance.md) for the reproducible 300-photo authoring workload, measured timings and hash-byte counts. The benchmark script generates its large fixture under `.build/`; originals are not committed to the repository.
