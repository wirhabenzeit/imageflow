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
| `inspect_book` | `project`, `view` of `summary`, `spreads`, `sources` or `parameters`, optional `spread`, `offset` and `limit`. Results are paginated with at most 100 records per call. |
| `check_book` | `project`, optional `expectedRevision` and `preview`. Returns check coverage, diagnostics, revision, and optional rendered artwork. |
| `apply_project_changes` | `project`, `expectedRevision`, `idempotencyKey`, `label`, `operations`, optional `dryRun`. Validates the complete batch and applies it through the app. One successful batch creates one named Undo entry. |
| `import_sources` | `project`, `expectedRevision`, `idempotencyKey`, `kind`, `paths`, and `accept` for file inputs. Registers files copied into this project’s `inbox/` folder and returns source IDs. |

Tool argument schemas are advertised through `tools/list`. The app validates them again before execution. Requests use only the selected project handle, even if the foreground book changes during a call.

Context and inspection remain available when a manifest is malformed or missing: results retain check diagnostics and safe template sources. Unavailable parsed sections are omitted or empty, and `revision` is `null` when the complete input set cannot be captured. Repair the reported files and check again before attempting a mutation.

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

A rendered image can accompany layout errors or warnings. Coverage reports TypeScript checking and print preflight as `not-run` in this prototype. Capture uses screen-media artwork. Print-specific CSS, contact sheets, detailed crop targets and unused-layout fixtures remain follow-up work. CSS background-image readiness has not been verified by the preview equivalence tests.

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

Writer ownership is recorded in `.imageflow/writer.lock`. New locks use a private local socket outside the project to verify the owning app, so a reused process ID cannot block recovery. Moving or removing the open folder does not prevent switching projects or closing the app. A live owner blocks a writable open; a confirmed absent owner allows recovery while preserving its record. Permission errors or an unresponsive owner fail closed. Legacy version-1 locks still use conservative PID checks; an apparently live PID requires manual verification. A malformed lock or interrupted `.imageflow/writer-lock-acquire` gate also needs manual recovery. Close all ImageFlow instances, back up the project and lock/journal evidence, and verify that no writer remains before moving an orphan gate or malformed lock aside. Keep pending save journals and abandoned save/recovery staging directories available for inspection until the saved manifests have been reconciled.

Imported-file watcher receipts retain exact filesystem fingerprints for up to one minute and at most 2048 paths. Repeated matching events are suppressed during that window. Expired or evicted receipts may cause an extra reload; changed fingerprints always trigger external-change handling.

Source consistency uses content revisions and filesystem change observations around loading/rendering. It detects ordinary concurrent edits, including edits reverted during a check. External writers can still race outside those observations. Large-book performance, immutable input snapshots, broader validation fixtures and additional client compatibility testing remain part of the full authoring release.

## Verification

`tests/mcp-connection.test.ts` exercises token rejection, private file/socket permissions, argument/path validation, request/response limits, cancellation, revocation, reconnection and SDK client tool discovery/image delivery. `scripts/smoke-mcp.mjs` exercises a real running ImageFlow instance with the official SDK client. Desktop preview/reload smoke tests cover later-page flow, proof agreement, single-page ends, asymmetric bleed and recovery after template errors.
