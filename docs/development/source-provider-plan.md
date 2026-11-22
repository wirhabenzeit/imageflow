# Source provider contract: inventory and plan

Plan for the provider contract of [ADR 0011](../decisions/0011-lightroom-classic.md#source-providers): today's file behaviour moves behind a `SourceProvider` interface as two providers, `package` and `linked`, with no visible change, before any Lightroom code exists.

It has two steps:

1. **This document, the contract types and a paper check.** The inventory below, the two halves of the contract ([`src/source-locator.ts`](../../src/source-locator.ts), [`desktop/source-provider.ts`](../../desktop/source-provider.ts)) and four sketched providers that are type-checked against it ([`tests/source-provider-fit.ts`](../../tests/source-provider-fit.ts)): `package`, `linked`, Lightroom Classic and Immich. Nothing calls the contract yet.
2. **The refactor,** one pull request of several commits ([below](#the-refactor)), with the existing tests as the safety net.

The inventory names functions rather than lines; it describes the code at commit `768a283`.

## What the check found

The contract in the ADR holds, with the changes below. They are in the types and in the ADR.

- **Owned and linked photos are two providers, not one `local`.** They share only how a file is read. A photo in the package's `photos/` is in the host's own storage: no approval, no size limit, watched by the book folder watcher, its original synced, and renamable. A linked photo is an external source like any other: approved per path, limited to 50 MB, watched where it is, never uploaded. Copy into Book is then one operation for every provider, a change to `package`. One provider for both needed a question (`owned`) that only it answered differently from all the others. The named local roots of ADR 0010 would be a third file provider on the same helpers.
- **A provider's photo is either a file the host reads in place, or facts.** This is the one distinction the host makes. `package` and `linked` report a file, and the host then does everything it does today: it reads the facts with `sharp`, derives previews and renditions, keys them by the file's path and stamp, guards each read with the stamp and hashes the bytes for the input revision. A provider without a file reports facts, and its pixels come from `preview` and `materialize`. So none of the file machinery changes for them, and none of it has to be generalised for Lightroom.
- **The editor already shows photos that have no readable original.** A photo that is missing or unapproved on this Mac is laid out from its `assets-meta.json` fact and drawn from its proxy in the proxy store (`readContent` in [`desktop/project.ts`](../../desktop/project.ts)). A Lightroom photo in the editor is the same case without the problem. The protocol handler and `photoFile` always get a local file and need no change.
- **File providers do materialize.** The ADR said local files are read in place and `materialize` does nothing. In the editor they are; an export copies every photo into `pinned-sources` and checks that it did not change meanwhile (`SourceStore.resolve` with `pin`). That copy and check are `materialize`, with the same before-and-after revision rule the ADR sets for Lightroom renders.
- **Two revisions, not one.** Besides the stamp, `ProjectInputIndex` ([`desktop/revisions.ts`](../../desktop/revisions.ts)) hashes the bytes of every photo into the render-input revision. The export guard ("Sources changed during export") and the check cache compare it. For a photo without a file, the provider's `revision` token takes the place of the bytes there.
- **Half of the contract is pure and lives in `src/`.** The portable book-state revision, sync snapshots and the renderer read `path` and `linked` of a `photos.json` entry, and none of them runs in the main process. That half is `LocatorKind`: how an entry reads as a locator, its portable and shared forms, its key, its name, and whether the package owns its bytes.
- **`observe` gets the last known revisions.** Lightroom's develop hash costs one SDK call per photo, so it is read only when the revision moved. The provider keeps no state for that: the host hands in what it stored.
- **Photos only.** `SourceStore` also resolves texts and files. They stay files and use the file helpers the two file providers share; a provider for texts would be a different set of capabilities.
- **More states than the ADR lists.** Today there are `missing`, `unreadable`, `denied` and `unapproved`; the ADR adds `offline` and `needs-sign-in`. The proxy stands in for `missing` and `unapproved` only, and `offline` joins them with the Lightroom provider.
- **Approvals stay inside `linked`.** An approval is a grant for one exact path of one book, checked while the path is resolved (`originalPath`). What another provider needs approved (an app, a server) is a different question, so the contract leaves trust out until a second provider asks it.
- **Import is not in the contract.** `importIntoProject` takes file paths, a copy or link mode, and reports a file as already held by path, then by content. A Lightroom import arrives from the plugin. Both end in the same host step (assign an ID, write the entry, record facts), which is extracted when the second one exists.

- **Sync needs nothing from a provider.** Proxies and facts sync for every photo; originals sync only for `package`. Which Mac can print which photo is in the ADR ([Sync between Macs](../decisions/0011-lightroom-classic.md#sync-between-macs)).

Two findings concern the later Lightroom phase, not this one:

- **A book format cannot follow `photos.json` today.** `bookFormatOf` ([`src/project.ts`](../../src/project.ts)) derives the format from `project.json` alone. The format bump for entries without a `path` needs it to see the photo index.
- **`assets-meta.json` drops unknown fields.** `assetFactSchema` strips them, and a file with another `version` reads as empty and is then written over. A current build that saves a book would remove the `provided` and `lightroom` objects the ADR adds to a fact.

## Inventory of file assumptions

### The `photos.json` entry

| Where | Assumption |
| --- | --- |
| `photoIndexSchema` in [`src/project.ts`](../../src/project.ts) | `path` is required; `linked` tells an absolute external path from a relative one in `photos/`; capture fields are "read from the photo file" |
| `sourceEntries`, `SourceEntry`, `SourceStatus` in [`src/source-locations.ts`](../../src/source-locations.ts) | Every source is `{ path, linked }`; the status sent to the renderer carries both |
| `portablePhotos` in [`src/book-revision.ts`](../../src/book-revision.ts) | Drops `path` when `linked` is true and hashes every other entry whole |
| `portableManifests`, `projectManifests` in [`src/sync-snapshot.ts`](../../src/sync-snapshot.ts) | A linked path travels as its file name; a pull keeps this Mac's path or writes `/imageflow-unlocated/<name>` |
| `ProjectSession` in [`desktop/project-session.ts`](../../desktop/project-session.ts) | Undo and edits keep the current `path` and `linked` of each entry |
| `reference` in [`desktop/source-actions.ts`](../../desktop/source-actions.ts) | Relocating or collecting a source rewrites `path` and `linked` |

### Resolving and reading

| Where | Assumption |
| --- | --- |
| `originalPath` in [`desktop/source-store.ts`](../../desktop/source-store.ts) | Linked: absolute, approved, equal to its realpath, outside the book. Owned: inside `photos/` |
| `SourceStore.resolve` | `stat`, a 50 MB limit for linked photos, three ways to read: in place (editor), a snapshot in `source-cache/content` (texts and files), a private copy in `pinned-sources` (export) |
| `StoredSource` and the source index | Keyed by `photo:<id>`; reused while `path` and the stamp (`observation`) are unchanged |
| `fileStamp` in [`desktop/file-stamp.ts`](../../desktop/file-stamp.ts) | `ino:size:mtimeNs:ctimeNs` is the revision of a source |
| `approvedSource`, `requireSourceAccess` in [`desktop/source-access.ts`](../../desktop/source-access.ts) | A grant matches one exact path |
| `readContent` in [`desktop/project.ts`](../../desktop/project.ts) | Builds each `ProjectPhoto` from a file: the original, a snapshot, or a proxy for a `missing` or `unapproved` original |
| `photoDetails`, `photoFile` in [`desktop/photos.ts`](../../desktop/photos.ts) | Facts come from `sharp` on a JPEG, PNG or WebP file; the rendition key is `sha256(path:stamp:rendition-3)`; each read re-checks the stamp |
| `serve` in [`desktop/main.ts`](../../desktop/main.ts) | Pixels reach the renderer as `net.fetch` of a `file:` URL of what `photoFile` returns |

### Facts, previews and renditions

| Where | Assumption |
| --- | --- |
| `AssetFacts` in [`desktop/asset-facts.ts`](../../desktop/asset-facts.ts) | Facts are noted from `photoDetails` of an available original; `digest` is the SHA-256 of the original's bytes |
| `SourceStore.recordDigest` | The digest of a photo read in place is hashed from the file in the background |
| `ProxyStore` in [`desktop/proxy-store.ts`](../../desktop/proxy-store.ts) | Keyed by digest; no path. Unchanged |
| `CheckRenditionCache` in [`desktop/check-cache.ts`](../../desktop/check-cache.ts) | Keyed by the 64-hex rendition key. Unchanged while keys are |
| `estimatedCapture` in [`desktop/capture-time.ts`](../../desktop/capture-time.ts) | An undated photo's date is the file's modification time |

### Changes

| Where | Assumption |
| --- | --- |
| `DocumentSession.watchLinkedSources` in [`desktop/document-session.ts`](../../desktop/document-session.ts) | A 1.5 s `stat` poll of every linked path, `fs.watch` on each parent directory, and a probe every 10 s that resolves an unavailable source again |
| `DocumentSession.watchProject` | The book folder watcher covers owned photos in `photos/` |
| `ProjectInputIndex` in [`desktop/revisions.ts`](../../desktop/revisions.ts) | A linked photo is the input `@photo/<id>` with an `external` path; its bytes are hashed, with approval and the 50 MB limit checked again |
| `DocumentSession.runExport` | Compares the input revision before and after the export |

### Export, collection and copies

| Where | Assumption |
| --- | --- |
| `loadProject(folder, cache, true, true)` | `pinSources` copies every photo into the job's `pinned-sources` |
| `collectSources`, `saveDocumentCopy` in [`desktop/source-actions.ts`](../../desktop/source-actions.ts) | Copy into Book and Save a Copy copy a linked file into `photos/` and rewrite the entry |
| `relocateSource`, `relinkFolder` | Locate picks a file; Locate Folder searches a directory by file name and digest |

### Import

| Where | Assumption |
| --- | --- |
| `importIntoProject` in [`desktop/project.ts`](../../desktop/project.ts) | Takes paths; copy or link; already-held detection by path, then size and digest |
| `DocumentSession.importFiles`, `pathsForFiles` in [`desktop/preload.ts`](../../desktop/preload.ts) | An open dialog or a drop of files, as absolute paths |
| `import_sources` in [`desktop/authoring-service.ts`](../../desktop/authoring-service.ts) | Paths inside the book's `inbox/` |

### Actions that need a path

| Where | Assumption |
| --- | --- |
| `sourceAction` in [`desktop/main.ts`](../../desktop/main.ts) | Show in Finder, Edit in Default App and Quick Look call `originalPath`; Locate and Locate Folder open file dialogs |
| `dragSources`, the drop match of `channels.import` | Dragging out starts a file drag; a dropped file is matched to a source by path |
| `confirmRemoval` and messages | Names come from `basename(entry.path)` without the storage prefix |

### Sync

| Where | Assumption |
| --- | --- |
| `push` in [`desktop/sync-engine.ts`](../../desktop/sync-engine.ts) | Uploads originals of entries that are not `linked`, from their path, with the extension of `photo.path` |
| `stagePull`, `missingOriginals` | An owned original is `!photo.linked && photo.path.startsWith('photos/')` and is written to `join(root, photo.path)` |

### Renderer and MCP

| Where | Assumption |
| --- | --- |
| `source-items.ts`, `photo-view.ts`, `SourceInspector.tsx`, `Sources.tsx` | A photo without a title is named by its file name |
| `SourceManager.tsx`, `asset-menu.ts`, `commands.ts` | The Linked and In Book filter, the linked badge, and the menu items above, enabled by `linked` and the state |
| The `sources` view in `authoring-service.ts`, `mcp-results.ts` | MCP clients get `path` and `linked` of every source |

Templates see none of this: `Photo` has no path.

## The contract against four providers

| | `package` | `linked` | Lightroom Classic | Immich (on paper, API not verified) |
| --- | --- | --- | --- | --- |
| Locator | `{ path }`, relative to the book | `{ path, linked: true }`, absolute | `{ catalog, uuid, name? }` | `{ server, asset, name? }` |
| Portable form | The path | Only that it is linked | Catalog identity and UUID | Server name and asset ID |
| `observe` | Inside `photos/`, `stat`; reports the file | Approval, realpath, 50 MB, `stat`; reports the file | One `batchGetRawMetadata`; reports facts | `GET /assets/{id}`; reports facts |
| `revision` | The file stamp | The file stamp | `lrRevision` | Checksum and `updatedAt` |
| `contentRevision` | None | None | The develop hash, read only when `revision` moved | The checksum |
| `preview` | None: the host derives it | None | A 1400 px render | The server's preview |
| `materialize` | A clone of the file | A clone of the file | `LrExportSession`, five photos at a time | The original, downloaded |
| `watch` | Nothing: the book folder watcher covers it | The linked-folder poll and watches | The plugin's poll, and its connection | The server's asset events, or a poll |
| Unavailable | `missing`, `denied`, `unreadable` | `missing`, `denied`, `unreadable`, `unapproved` | `offline` (not running, another catalog), `missing` | `offline`, `needs-sign-in`, `missing` |
| Repairs | Locate, Locate Folder | Locate, Locate Folder | Launch Lightroom | Sign in |

What the host does with a result does not depend on the provider, only on whether it got a file:

| | A file read in place | Facts |
| --- | --- | --- |
| Facts in `assets-meta.json` | Read by the host with `sharp`; `digest` of the file's bytes | As reported; `digest` of the stored preview's bytes |
| Editor pixels | Renditions of the file, keyed by path and stamp | The preview in the proxy store, keyed by digest |
| Input revision | The file's bytes | The `revision` token |
| Export | Materialized into the job's `pinned-sources` | Materialized into the source cache, recorded against `revision`, then pinned |

## The refactor

One pull request. Each commit keeps the unit tests green, changes no file format, no IPC or MCP type and no text in the UI, and keeps the exported functions the tests import (`SourceStore.resolve`, `loadProject`, `originalPath`, `relocateSource` and the others).

1. **Tests for what the refactor moves and nothing covers yet.** An export load (`loadProject` with `pinSources`): the pinned copy, and a source that changes during the copy. The linked-folder watch: a change, a replaced file and a reconnect. The rendition key of a given path and stamp, as a fixed value.
2. **Locators.** Every reader of an entry's `path` and `linked` goes through `packageLocator` and `linkedLocator`: `sourceEntries`, `portablePhotos`, the sync snapshot, `ProjectSession`, `reference`, the input index and the sync engine's owned test.
3. **The `package` and `linked` providers.** `desktop/providers/files.ts` gets the two branches of `originalPath`, the approval check, the stamp and the limit as their `observe`, and the export copy as `materialize`. `SourceStore.resolve` calls it for photos and keeps returning `{ status, stored }`; texts and files use the same file helpers directly.
4. **One place builds a `ProjectPhoto`.** The three cases of `readContent` (a file in place, a snapshot, a proxy) become one host function over what `observe` returned.
5. **Watching.** `watchLinkedSources` keeps its debounce and reload and gets its changes from `provider.watch`.
6. **Actions and sync.** `sourceAction`, the menus' enabling and the sync engine ask which provider a photo has, and its `repairs`, instead of `linked`.

Not part of it: a `photos.json` entry without a `path` and the format bump for it, new states in the UI, changes to import, and anything a second provider would be the first to need.

The safety net: [`tests/linked-sources.test.ts`](../../tests/linked-sources.test.ts) (41 tests on resolving, approvals, relinking, collection, facts and the proxy stand-in), `tests/revisions.test.ts`, `tests/sync.test.ts`, `tests/project-session.test.ts`, the compatibility books, and `scripts/smoke-linked-sources.mjs` end to end.
