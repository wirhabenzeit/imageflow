# Source provider contract: inventory and plan

Plan for the provider contract of [ADR 0011](../decisions/0011-lightroom-classic.md#source-providers): today's file behaviour moves behind a `SourceProvider` interface as two providers, `package` and `linked`, with no visible change, before any Lightroom code exists.

It has four steps:

1. **This document, the contract types and a paper check.** The inventory below, the two halves of the contract ([`src/source-locator.ts`](../../src/source-locator.ts), [`desktop/source-provider.ts`](../../desktop/source-provider.ts)) and sketched providers that are type-checked against it ([`tests/source-provider-fit.ts`](../../tests/source-provider-fit.ts)): `package` and `linked`, which are real since step 2, Lightroom Classic and Immich.
2. **The refactor,** one pull request of several commits ([below](#the-refactor)), with the existing tests as the safety net. Done.
3. **Compatibility and host support for photos without a file** ([below](#photos-without-a-file)), built against a provider that keeps its photos in memory and exists only in tests. Done.
4. **Full-resolution originals of photos without a file** ([below](#full-resolution-originals)): materialization into the source cache, export pinning, Copy into Book and Save a Copy, against the same provider. Done.

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

Done in one pull request, without a change to a file format, an IPC or MCP type or a text in the UI. The exported functions the tests import (`SourceStore.resolve`, `loadProject`, `originalPath`, `relocateSource` and the others) kept their signatures and results.

1. **Tests for what moved and nothing covered** ([`tests/source-providers.test.ts`](../../tests/source-providers.test.ts)): the rendition key of a file read in place, and the private copies of an export load. The providers' own tests joined them: what `observe` reports, a materialized copy with its revisions, and the watch (a change, a replacement, a file that comes back, a change made before the watch started).
2. **Locators.** `sourceEntries`, `portablePhotos`, the sync snapshot, `ProjectSession`, `reference`, the input index and the sync engine's owned test read an entry through `packageLocator` and `linkedLocator` (`locatorOf`, `portableEntry`, `sharedEntry`, `adoptedEntry`, `relocatedEntry`, `packagePath` in [`src/source-locator.ts`](../../src/source-locator.ts)).
3. **The `package` and `linked` providers** ([`desktop/providers/files.ts`](../../desktop/providers/files.ts)). `SourceStore.resolve` asks a photo's provider for its state (`observe`) and, for an export, for its private copy (`materialize`). Texts and files call the same file functions (`observeFile`, `cloneFile`) directly.
4. **Watching.** `DocumentSession` keeps the debounce, the reload and waiting for a save or an export, and gets changes from each photo's provider and, for linked texts and files, from `watchLinkedFiles`. The watch starts from the revision each source was last read at.
5. **One place builds a `ProjectPhoto`** (`loadPhoto` in [`desktop/project.ts`](../../desktop/project.ts)): from the original or a copy of it, from what was last read of it, or from its fact and its proxy.

Left for the Lightroom provider, because only a provider without a file can show what they must become:

- **`SourceEntry` still carries `path` and `linked`** for photos, derived from the locator. Texts and files have nothing else, and the source actions, the Assets window and the MCP `sources` view handle all three kinds alike. A photo without a file needs its locator there instead.
- **Actions and menus still ask `linked`.** `provider.repairs` is implemented and has no caller: Locate and Locate Folder are offered as before.
- **`SourceStore` keeps files only.** A provider that reports facts gets an `unreadable` state from it. Storing previews and materializations against a revision is new host code, not moved code.
- **`observe` is called for one photo at a time,** as `resolve` is. A provider behind a bridge needs the book's photos in one call.
- **A `photos.json` entry without a `path`,** the format bump for it, new states in the UI, and import.

One difference in behaviour: a linked photo that is there but cannot be decoded is reloaded once more shortly after the book opens. The watch cannot tell it from a file that came back, and reports it once.

The safety net was [`tests/linked-sources.test.ts`](../../tests/linked-sources.test.ts) (41 tests on resolving, approvals, relinking, collection, facts and the proxy stand-in), `tests/revisions.test.ts`, `tests/sync.test.ts`, `tests/project-session.test.ts`, the compatibility books, and `scripts/smoke-linked-sources.mjs` end to end.


## Photos without a file

The host side of a provider that reports facts, with no Lightroom code. Every path is unit-tested against `MemoryProvider` in [`tests/provided-photos.test.ts`](../../tests/provided-photos.test.ts), which registers its locator kind and provider the way a real one will (`registerLocatorKind`, `registerProvider`).

### Compatibility (ships a release before any such book exists)

- **`assets-meta.json` keeps unknown fields.** Facts and the file are parsed loose (`src/asset-facts.ts`) and written back with what this version does not know. Noting a file photo again keeps a fact's unknown keys while its digest is the same. A file of another `version` reads as empty and is never written over (`writeAssetFacts` in [`desktop/asset-facts.ts`](../../desktop/asset-facts.ts)).
- **Book format 4.** `bookFormatOf(project, photoIndex)` returns 4 when an entry has no `path`; `withBookFormat` applies it wherever a book is saved (`updateProject`, sync pull and clone, `ensureBookId`), and `persistProjectManifests` refuses a save whose `project.json` is below the format its `photos.json` needs. Older builds then refuse such a book with the existing "update ImageFlow" message.
- **`photoIndexSchema` accepts an entry without `path`** when a registered locator kind reads it. In this build only tests register one, so a real book with such an entry is refused.

### Host support

- **Locators and entries.** `LocatorKind`s and providers are registries. A photo's `SourceEntry` carries its `locator` and a `name` (from `LocatorKind.name`) instead of `path` and `linked`; `sourceFile` and `fileSourceOf` give the file of a text, a file or a file photo, and every file action (Show in Finder, Quick Look, drag out, collect, relink) goes through them.
- **Loading** ([`desktop/project.ts`](../../desktop/project.ts)). `observePhotos` asks each provider once for all its photos, handing back the stored revisions. A file result goes to `SourceStore.resolve` as before, with the state already observed. A facts result goes to `refreshProvided` ([`desktop/provided-photos.ts`](../../desktop/provided-photos.ts)): the fact is recorded with `revisions`, `provided` and `extra`, and a preview is asked for only when there is no proxy or the content revision moved. The preview is stripped of its APP1 and COM segments (PNG: text, time and EXIF chunks), hashed and stored in `ProxyStore` under that digest. `loadProvidedPhoto` draws the photo from fact and proxy without a problem, with `previewOnly` on its status.
- **Changes** (`providedChanges`, `DocumentSession.providedChanged`). A provider's `watch` report is observed again; a moved revision invalidates the render inputs, a moved content revision re-renders the preview, and the book reloads for a new digest, a change of availability, or new titles, size or capture data; a change of anything else (a rating) only moves the revision. A preview discarded because the photo changed meanwhile is asked for again after observing the photo again, so its facts match its revision. A new preview with another aspect ratio of a placed photo raises a notice and a `source-reshaped` warning for the session.
- **Input revision.** `ProjectInputIndex` hashes the stored `revision` token of a photo without a file (from the session's facts, else the file).
- **Titles.** `photoMetadata`: the override where `photos.json` has the key, else the provided value. The summary carries `photoProvided`; the Inspector shows a provided value as the placeholder and offers Revert, which removes the key. `set_photo_metadata` with `null` already removed the key, which now means inherit.
- **States and menus.** `SourceStatus` gains `offline`, `needs-sign-in`, `repairs` (from `provider.repairs`) and `previewOnly`. The proxy stands in for `offline` and `needs-sign-in` too. Assets shows Offline and Sign in needed; the menus offer Locate and Locate Folder only where the provider does, and Retry otherwise.
- **Export.** A photo without a file was drawn from its proxy in the export load too, nothing was materialized, and `printProblem` reported it as `source-unavailable`, so the page was marked ORIGINAL UNAVAILABLE and the PDF was a proof. That is now only the fallback ([below](#full-resolution-originals)).

The ADR's `lightroom` object on a fact is the generic `revisions` (`revision` = `lrRevision`, `contentRevision` = the develop hash) and `extra` here.

### Full-resolution originals

The host side of `materialize` (ADR 0011, §4), provider-independent and unit-tested against `MemoryProvider` too. The provider contract is unchanged.

- **Materialization** (`materializePhotos` in [`desktop/materialized-photos.ts`](../../desktop/materialized-photos.ts)). Given photos with the revisions just observed, it reuses an original the source cache holds for that `revision` and asks each provider once for all the others. The provider writes into a staging folder inside the source cache (`SourceStore.staging`); the host hashes each file, checks it is one still JPEG, PNG or WebP whose pixels decode, renames it to `source-cache/content/<sha256>.<ext>` and records it in the book's source index under `full:photo:<id>`, against the revision and the locator it was made for (`SourceStore.keepMaterialized`, `materialization`). The key is separate from the photo's own, so the editor's reads and the stand-in for an unavailable photo never take it for a file snapshot. `pruneSourceCache` keeps it like a linked file's snapshot, and removes staging folders a crash left behind.
- **The before-and-after rule.** A result whose `before` and `after` revisions differ, or whose revision is not the one observed, is discarded; the photo is observed again and asked for once more, three times in all, then it fails as a photo that kept changing. A photo the provider cannot produce gets its state and problem, and the others follow. The staging folder is removed after each call with everything in it, also files of failed, discarded and unasked-for results.
- **Cancelling.** After the signal aborts, a result that still arrives is not stored, the photos without a stored original are reported as cancelled, and nothing half-made is recorded. Originals completed before the cancel stay in the cache, as whole files recorded against their revision, for the next export.
- **Export.** `loadProject(folder, job, true, true, { signal, progress })` materializes the placed photos without a file (`placedPhotos`: boxes of spreads and cover, and template parameters; `assetUsage`, as the ADR says) whose provider reported them available, and pins each into the job's `pinned-sources` as a copy checked against its digest (`SourceStore.pinMaterialized`). Such a photo is drawn from it at the original's own size, with the provider's titles and capture data; its status has no `previewOnly`, so `printProblem` reports nothing and the page is not marked. `DocumentSession.runExport` passes the export's abort and shows "Preparing originals: n of m…" in the status bar. A photo whose provider is offline, or that it cannot produce, is printed from its proxy as before, with `previewOnly` and a proof. The load records the revision each original was made from (`OpenProject.materialized`); the export refuses ("Sources changed while preparing export") when one differs from what the open book has stored, and the existing guard after printing compares the `revision` tokens as before.
- **`previewOnly` is an export's mark only.** The editor no longer sets it on an available photo without a file, so the Book check does not predict a proof for photos an export will materialize; an offline photo is still reported, as a cached stand-in.
- **Copy into Book and Save a Copy** (`collectSources`, `saveDocumentCopy` with *Include all files*, in [`desktop/source-actions.ts`](../../desktop/source-actions.ts)). Photos without a file are observed in one call per provider (an unavailable one is refused like a missing file), materialized (or found in the source cache), copied into the package's `photos/<id>-<random>/<name>.<ext>`, named after the locator's name, and their entries rewritten into `package` entries with `relocatedEntry`. The provider's titles become the book's own where the entry has no override, since the photo no longer follows its source; its fact is read from the copied file from then on, like any owned photo's. The book format drops below 4 once no entry without a `path` is left, in a saved copy too. A photo its provider cannot produce keeps its entry and is reported (`CopyOptions.failed`); a cancelled copy changes nothing and leaves no file. The Assets menu offers Copy into Book for these photos, and `DocumentSession.copying` gives both commands the status bar's progress and the export's Cancel.

Not done here: an offline export from an original cached for the last known revision (the ADR allows it; the export stays a proof), a Cancel button for Copy into Book in the Assets window (the session's cancel stops it, but only the export shows one), and syncing originals between Macs (ADR 0011, deferred).

Still left for the Lightroom provider: the plugin and its loopback bridge, import, and Launch Lightroom as a repair action.
