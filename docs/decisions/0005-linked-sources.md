# 0005: A document import default with per-source ownership

Status: implemented, 2026-11-12. Second phase of #40, stacked on document packages (#41).

## Decision

Copy versus link is a **document-level default**, not a strict document mode. Book settings → New imports chooses Copy into Book (the default) or Link to Original Files. The default applies to photos, Markdown, parameter-file pickers, folder imports, and drag/drop. Existing sources retain their actual ownership when the default changes, and individual imports may override it. A document can mix copied and linked sources. Imports of resources already inside the package remain document-owned rather than linking a document to itself.

The Sources import menu offers explicit Copy and Link actions. File parameter controls expose the same choice beside Choose. Template code, its fonts, and bundled template assets stay document-owned; linking applies to registered source files, including everything selected through parameter file pickers. File parameters retain their existing UTF-8 text contract and 20 MB limit.

## Persisted locations and identity

`project.json.importMode` is the optional future-import default (`copy` when absent). Photo IDs remain in `photos.json`: a copied photo has a relative `path`, while a linked photo has an absolute `path` and `linked: true`. Markdown and parameter registries retain their IDs, with either a relative string for a copied file or `{ path, linked: true }` for an external file. Locations do not become IDs. Relinking, replacing, collection, and Save a Copy preserve IDs, metadata, assignments, and normalized crops.

Linked paths identify the explicitly selected exported files, not a Lightroom catalogue. Atomic replacement at that path updates the same source. The first implementation uses canonical absolute locators and explicit Locate actions for moves; it does not search arbitrary directories or follow filename-only guesses. A Locate Folder action considers byte-identical candidates with the saved filename and digest. Ambiguous candidates are reported for explicit per-source Locate rather than silently selected.

## Stable inputs and availability

The shared source store reads bounded regular files, verifies the file and path before/after reading, hashes and validates photo bytes, and stores an immutable content-addressed snapshot. APFS clones are used when possible and verified before publication. Editor frames and PDF/check jobs read those immutable bytes, while Markdown and parameter-file contents are loaded into their render data. A source change therefore cannot turn a lazy photo request into a mixture of old and new bytes.

The app-owned source cache also retains last-good content and metadata across reopen. Missing, denied, and unreadable states always come from the original location. Cached content never makes an unavailable original available. Derived cache corruption is checked and repaired from an available original; a fallback snapshot is verified against its digest before use. These caches live outside `.imageflow` documents and are not needed to open a collected book with available originals.

Each document watches selected external files' parent directories, so an atomic replacement does not strand an inode watch. Metadata reconciliation and watch reinstallation cover missed events, disconnected locations, resume, and files changed while closed. Short writes are coalesced; invalid content retains a marked last-good view. Unavailable sources are retried without repeatedly rebuilding the editor. A refresh pending behind a save or export is separate from actual source-change invalidation.

Checks reconcile source revisions around loading/rendering. Exports capture current inputs, load pinned contents, and recheck before publishing a PDF. A replacement during export rejects the result. External content changes do not rewrite files or enter ordinary layout Undo. Undo preserves each registered source's current location, so it cannot revive an obsolete relink or replace an external file.

## Recovery, collection and saving

Manage Sources lists photos, Markdown and parameter files with actual storage, location, availability, and cached-view status. It offers Reveal, Locate/Replace Original, Retry, Copy into Book, folder relinking, and Include All Assets. A missing source does not prevent the rest of a book from opening or being edited. Relinking an ID repairs every use. ImageFlow never overwrites or deletes a linked original.

Include All Assets on the current book validates every registered original, prepares owned copies, and publishes the manifest changes through the recoverable save path. Failure leaves the original registries intact; required recovery data and staged referenced assets survive an interrupted committed save. Successfully collecting also sets future imports to Copy.

**File → Save a Copy…** includes an **Include all assets** checkbox, checked by default, before the destination picker. Checked produces an independent package with copied photos, Markdown and parameter files, and a Copy import default. Unchecked preserves the current mix and document default. The original document and linked originals remain untouched. A missing original blocks collection with a list of sources to locate, rather than a falsely portable result. Normal autosave preserves existing ownership and links.

## Print and proof

Only unavailable sources used by the active layouts or assigned file parameters block print. Missing unused library sources remain diagnostic warnings. Proof export requires explicit confirmation to use cached content/placeholders, retains Book check errors, and marks affected PDF pages with `PROOF: ORIGINAL UNAVAILABLE`. The cached view never satisfies an original-file requirement for print or collection.

## Validation

Unit coverage exercises the shared import default, per-import exceptions, linked Markdown and file inputs, atomic replacement, original dimensions/crops, immutable pinned bytes, missing-source reopen, identity-preserving relinking across Undo, ambiguous folder candidates, collection, and portable Save a Copy. The desktop source workflow exercises all three source kinds, a deterministic replacement during PDF rendering, missing/cached views, print blocking, proof confirmation/marking, and opening a collected copy after external originals are removed. Existing document/session, authoring, editing, layout, parameter-file, and PDF workflows remain regression checks.
