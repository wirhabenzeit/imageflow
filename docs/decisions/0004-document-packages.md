# 0004: Document packages and independent book sessions

Status: implemented, 2026-11-12. First phase of #40: packages, independent windows, and a standalone start window. Linked-photo storage and its lifecycle are a separate phase.

## Document boundary

A writable book is a directory with the `.imageflow` extension, registered on macOS as `ch.wirhabenzeit.imageflow.book`, conforming to `com.apple.package`. Finder presents the directory as one document. The existing readable layout stays inside it: `project.json`, `photos.json`, `photos/`, `texts/`, `files/`, and `template/`. There is no launcher file, archive container, or separate project folder.

This is a clean-slate release. Writable folder projects without the extension are not offered, and there is no migration or conversion UI. Internal loaders still accept directory roots for samples, checks, and test fixtures.

New Book uses one shared starter catalogue and picker, whether entered through the start window or the File menu. It copies the selected starter into a staged package and reserves the destination exclusively before publishing it. Existing destinations are never replaced. Each book owns its template, fonts, Markdown, photos, and file inputs. Installing or updating a starter cannot affect existing books. The current catalogue contains the existing photobook starter; #27 can add the calendar through the same picker.

`.imageflow/` inside the package is **not** disposable: it contains writer ownership and recoverable save journals. Ordinary editor photo renditions persist in the app data folder under `Cache/renditions`, pruned to 512 MB at launch and quit; validation jobs retain private temporary caches. Recents and small derived cover previews live in the app data folder. Covers are captured initially and refreshed after edits when a book loses focus or closes, rather than after every edit. Removing a recent entry does not delete its book. A valid package at its saved recent path can reopen after restore or remount changes its filesystem identity; opening refreshes that identity.

## Runtime ownership

`DocumentSession` composes the existing `ProjectSession` with one native editor window. Each session owns:

- the writer lock, current render identity, and retained editor render sessions;
- history, revision indexing, rendition caching, and idempotency receipts;
- a watcher, debounce/reload state, and import-write receipts;
- UI operation serialization, agent queue and pending-editor leases;
- check/export jobs, cancellation, and orderly cleanup.

The app owns Settings, the start window, recents, the starter picker, and the MCP transport. IPC derives the document from the sending window and verifies the requested render identity; an editor cannot save another window's book. Menus and dialogs target their owning/focused book. Closing one session cancels only its jobs, waits for published saves, and releases only its writer capability and render resources. App quit also waits for pending connection setup, all document cleanup, and app-owned persistence.

Open documents are deduplicated by canonical directory filesystem identity (device and inode), not by a persisted UUID or a path string. Aliases and moved packages resolve to the original window. A Finder duplicate has a different identity and gets its own session and history. Writer records carry that directory identity so a copied live lock does not prevent opening the duplicate. Matching live writers remain exclusive across processes. Moving an open package requires resolving its new location; reopening that location relocates its existing session and watcher without replacing its history.

The app registers `open-file` before readiness and queues cold-launch requests. Direct document opening enters its editor. Launch without a document shows the start window; successful opening hides that window for reuse. Closing the last book shows it again. Show Start Window in the app menu also makes it available. There is no automatic production session restoration in this phase. Development restarts preserve the open document list.

## Agent routing

Agent access is enabled app-wide. `list_projects` returns all open authorized books. Other requests select a live session handle explicitly; window focus never changes a request's destination. Each document has an independent queue and editor lease. Closing one expires its handle and cancels its requests without disconnecting other books or the transport. Merely reopening an already-open package preserves its handle.

## Next phase

Photo imports still copy originals into the package. The next phase introduces per-source copied/linked locations, source availability, stable replacement/relinking, last-good previews, collection, external watchers, and consistent photo inputs for checks and exports. The package/session layer does not claim linked-photo portability or snapshot guarantees yet.

## Verification

`documents.test.ts` covers package ownership, exclusive creation, identity, and app-owned recents. Persistence tests cover copied live locks and cross-process writer exclusion. `smoke-documents.mjs` exercises creation through the picker, multiple windows, undo and IPC isolation, alias/duplicate opening, external edits, concurrent checks, explicit multi-book agent targeting, closing a book without disconnecting others, and recent-document recovery/removal. The lifecycle smoke retains its interrupted-save and in-flight connection shutdown checks. Existing editing, PDF, appearance, import, layout, and authoring checks use document fixtures.
