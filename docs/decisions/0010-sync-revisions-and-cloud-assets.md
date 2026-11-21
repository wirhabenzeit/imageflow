# 0010: Sync, revision tracking, cloud assets and web readiness

Status: proposed, 2026-11-21. Builds on [0004](0004-document-packages.md) (document packages), [0005](0005-linked-sources.md) (linked sources), the save ledger (#201) and the web companion exploration (#212). Captures long-term architectural direction and the short-term guardrails it places on revision tracking, persistence and schema evolution. Sync transports, authentication and web editing scope remain deferred.

## Problem

ImageFlow is currently single-machine local software: each `.imageflow` package lives on one Mac's disk, linked sources store canonical absolute paths, and runtime locks and history live inside `.imageflow/`. Two longer-term needs put pressure on those assumptions:

1. **Multi-Mac sync**, primarily one person switching between a desktop (with large local storage or a Lightroom export folder) and a laptop (with smaller disk space and occasional offline edits). Multi-user collaboration is optional for now.
2. **A lightweight web companion** (#212), starting from shareable read-only proofs and potentially extending to light editing (captions, crops, photo swaps, spread order) using ImageFlow's existing React renderer, alongside eventual support for **cloud asset providers** (S3/R2, WebDAV, Immich, Lightroom, Apple Photos).

Putting a `.imageflow` package into iCloud Drive, Dropbox or Syncthing today creates concrete failure modes:

- **Machine-local runtime files sit inside `.imageflow/`.** `writer.lock` records a local PID, `/tmp` Unix socket endpoint and local `(dev, ino)` (`desktop/persistence.ts`, `desktop/lock-owner.ts`). A second Mac cannot reach that socket and sees a different `(dev, ino)`, so it treats the active lock as stale, moves it to `writer-stale-*.json` and opens the book writable anyway. `pending-save.json` relies on local hard links and inode checks; file-by-file cloud sync can deliver it out of order with `project.json` and `photos.json` and trigger interrupted-save recovery errors. `.imageflow/history/ledger.jsonl` is a single mutable append-only file that produces conflict copies under concurrent sessions.
- **Non-atomic multi-file sync and placeholder eviction.** Sync folders copy `project.json`, `photos.json` and `photos/` independently, risking temporary or conflicting divergence between manifests. iCloud Drive's *Optimize Mac Storage* can evict photos to dataless placeholders, stalling `O_NONBLOCK` reads and revision hashing (`desktop/revisions.ts`).
- **Whole-file manifest conflicts.** `project.json` holds every spread and `photos.json` holds every photo entry. Non-overlapping edits on two Macs collide at the file level because there is no recorded common ancestor or semantic merge.
- **Asset asymmetry and non-portable linked paths.** Linked sources store raw absolute paths (`/Users/...`), and `SourceStore` approvals, digests, dimensions and cached previews are keyed by machine-local filesystem identity (`volumeUUID-inode-birthtimeNs`, `desktop/source-identity.ts`). A second Mac or web client without the originals cannot even know photo aspect ratios or capture times.

## Principle

**Separate book state from asset bytes, and keep the revision model independent of sync transport and authentication.**

A `.imageflow` package stays a local, human-readable, Git- and MCP-friendly working tree. Sync engines, remote storage backends, cloud asset providers and an eventual web frontend should layer cleanly over a portable causal revision model and content-addressed asset/proxy layer — much as Git separates its commit/blob model from local folders, S3 or hosted services — rather than replacing local files or locking books to one cloud vendor.

## Architectural direction

### 1. Split book state from originals and screen proxies

Book state (`project.json`, `photos.json`, `texts/`, `files/`, `template/`) is small (kilobytes to a few megabytes), whereas originals in `photos/` can reach tens of gigabytes.

- A laptop away from a home drive, or a web companion, rarely needs full-resolution originals to sequence spreads, crop photos, edit captions/Markdown or review proofs. It only needs **screen-resolution proxies** (content-addressed by original SHA-256 and rendition spec) and **cached asset facts** (dimensions, digest, capture time).
- Full originals remain required for print PDF export, matching the existing proof-versus-print boundary in [0005](0005-linked-sources.md).
- `RenderProject` (`src/project.ts`) already encapsulates a self-contained web-shaped render input (`project`, `photos` with `src` URLs, `texts`, `files` and compiled `template` assets). A web viewer or light editor can render spreads with the same React pipeline inside a sandboxed iframe using HTTPS proxy URLs and a pre-bundled template, leaving print PDF export on the Mac (or a later headless Chromium worker).

### 2. Causal revision DAG and domain-aware 3-way merge

For revision tracking and conflict resolution, ImageFlow prefers a **Git-like causal revision DAG with domain-aware 3-way merge** over making a CRDT (such as Automerge or Yjs) the primary document format:

- **Fits human-readable files, Git and MCP.** External text editors, template editors, Git and local MCP agents read and write plain files (`project.json`, `photos.json`, `texts/*.md`, `template/*.tsx`). Maintaining a parallel opaque CRDT store across all of those inputs adds translation complexity without clear benefit for solo async switching.
- **Preserves schema invariants.** `projectSchema` enforces cross-field rules (a box cannot hold both a photo and a text; `split: true` requires a page state; `project.json` and `photos.json` must stay referentially consistent). A domain-aware 3-way merge validates the merged result against `projectSchema` before committing, whereas blind field-level CRDT merges can silently produce invalid states.
- **Matches the existing data model.** Spreads already carry UUIDs (`spread.id`), and boxes, elements, parameters, crops, photos, texts and files are keyed by stable IDs (`src/project.ts`). Given a common ancestor (`base`), 3-way merging `(base, local, remote)` resolves non-overlapping edits automatically (for example, editing different spreads, adding different photos or updating captions independently) and merges `project.spreads` order by spread ID. Genuine same-slot collisions can fall back to explicit resolution or a preserved conflict snapshot.
- **Supports web suggestions and future collaboration.** A web companion submitting limited edits (#212) simply attaches the base revision/checkpoint ID it edited from; the Mac app merges or surfaces conflicts using the exact same machinery. If real-time co-editing is ever added on the web, live sessions can still commit snapshots into the same revision DAG.

### 3. Pluggable sync backends and cloud asset providers

Keeping the revision and blob contract transport-agnostic leaves all storage options open until product scope settles:

- **Synced folders (iCloud Drive, Dropbox, Syncthing, Git):** Viable zero-backend path for async desktop ↔ laptop use once machine-local runtime files leave `.imageflow/` and history/merge handling is conflict-safe.
- **Optional hosted ImageFlow Cloud or BYO remotes (S3/R2, WebDAV):** Most flexible path for multi-Mac sync plus a web frontend, without locking web access to Apple IDs. (CloudKit / `CKSyncEngine` + CloudKit JS remains a candidate if Apple-only personal sync is prioritized, as noted in #212, though Electron provisioning and non-Apple guest access add friction.)
- **Authentication stays outside the document format.** Read-only web previews can start with account-free, revocable capability links; user accounts and login only become necessary when adding hosted write-back or managed multi-Mac sync.
- **Cloud asset providers and portable local roots.** [0005](0005-linked-sources.md) already ensures locations are never IDs. `sourceReferenceSchema` and `photos.json` can evolve backward-compatibly from `string | { path, linked: true }` to provider-tagged locators — for example a named `local-root` (mapped per Mac in app settings so `/Users/alice/Photos` and `/Users/bob/Photos` resolve the same linked export folder) or cloud providers (`s3`, `webdav`, `immich`, `lightroom`, `apple-photos`). Machine-specific paths and provider credentials remain in local app settings, never inside `project.json` or `photos.json`.

## Short-term guardrails

We do not need to build a sync transport, cloud backend or web frontend yet. However, the direction above should guide near-term work on persistence, revisions and schemas:

1. **Move machine-local runtime state out of `.imageflow/`.** Active writer locks (`writer.lock`, `writer-lock-acquire/`) and transient save staging (`pending-save.json`) belong in local app support (keyed by local book identity/path) rather than inside a package directory that users may place in iCloud Drive or Dropbox. Removing live lock and staging files from the package eliminates the sharpest cross-Mac corruption hazards immediately while preserving local crash recovery and cross-process exclusion.
2. **Add a stable logical `bookId` (UUID).** Store a persistent logical book ID in `project.json`, regenerated on *Duplicate* and *Save a Copy*. Keep `sourceBookKey` (`volumeUUID-inode-birthtimeNs`) strictly as the local macOS security boundary for source approvals and book trust ([0004](0004-document-packages.md), [0005](0005-linked-sources.md)).
3. **Give checkpoints causal lineage and device attribution.** Extend `CheckpointRecord` (`desktop/persistence.ts`) with `parents: string[]` (pointing to the previous checkpoint ID, or two IDs after a merge) and a locally generated `deviceId`. Before storing history inside synced packages for cross-Mac use, move away from mutating one shared `ledger.jsonl` in place toward immutable per-checkpoint or per-device segment files.
4. **Separate portable content revisions from local filesystem observations.** In `desktop/revisions.ts`, `ProjectRevision` currently hashes `input.external` (machine-specific absolute paths) and `relative(root, state.actual)`. Keep absolute paths, devices, inodes and timestamps strictly in the local `observation`, and compute portable content revisions from logical source IDs and content digests so identical book states produce identical revision hashes across Macs and the web.
5. **Keep book manifests merge-friendly and deterministic.** Continue preferring ID-keyed maps over positional arrays for independently editable entities; give new long-lived array entries (such as review annotations or expanded displaced state) stable IDs where independent edits are plausible. Serialize `project.json` and `photos.json` with deterministic key ordering so diffs and 3-way merges stay minimal.
6. **Keep source locators encapsulated and `src/` host-agnostic.** Route source resolution through `src/source-locations.ts` helpers instead of assuming raw filesystem path strings in UI or render code. Keep `src/` free of Electron, Node and filesystem APIs so the renderer and `src/project-commands.ts` remain directly reusable in a browser host.
7. **Design portable proxies around content digests.** Keep fast local stamp-based rendition invalidation for in-place re-exports (such as Lightroom), while keying shareable proxies and future synced asset facts (`digest`, `width`, `height`, capture time) by content digest so remote Macs and web clients can render and crop without originals on disk.

## Deferred

- Choosing and implementing a sync transport (sync-folder commit store, BYO S3/WebDAV, optional hosted ImageFlow Cloud or CloudKit).
- Defining the web companion's scope, user/account management and server-side Chromium PDF export (#212).
- Deciding where portable screen proxies and cached asset facts live (inside a lightweight package section versus remote object storage).
- Implementing cloud asset provider integrations (`s3`, `immich`, `lightroom`, `apple-photos`) and named `local-root` mappings.
- Real-time multi-user co-editing.

## Consequences

- Near-term persistence and revision work makes `.imageflow` packages substantially safer in iCloud Drive, Dropbox and Git without introducing a server, accounts or vendor lock-in.
- Multi-Mac sync, cloud asset providers and a web companion (#212) can share one revision DAG, one content-addressed proxy/blob model and one `RenderProject` boundary when implemented.
- Local `.imageflow` packages remain plain, inspectable, Git-friendly directories with full local MCP authoring support.
