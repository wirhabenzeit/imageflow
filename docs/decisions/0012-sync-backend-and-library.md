# 0012: One sync backend per Mac, sync by source reach, and a book library

Status: proposed, 2026-11-23 (revised after review). Builds on [0010](0010-sync-revisions-and-cloud-assets.md) (snapshots, `SyncRemote`, the folder transport) and [0011](0011-lightroom-classic.md) (source providers). Supersedes 0010's choice of a synced folder as the first transport, its per-book sync folder, and its untrusted-remote rule for a user's own backend; the snapshot model, the engine and the fast-forward-or-keep-both policy stay as they are.

## Problem

Sync and source providers were built separately and do not yet read as one design.

- **Sync is configured per book.** Each book records, per Mac, the folder it syncs through (`desktop/sync-pull.ts`, **File → Sync → Sync with Folder…**). Every book on every Mac has to be pointed at the same folder by hand, and nothing lists what is synced.
- **What syncs is decided by a special case.** The engine uploads an original when the photo's provider is `package`. ADR 0011 describes the general rule (its "reach" table) but the provider contract does not carry it, and an online provider has no place in it yet.
- **A synced folder cannot say that a sync finished.** The folder transport (`desktop/sync-remote-folder.ts`) holds only immutable files, so it is safe, but:
  - a successful sync means "written to a local folder". Whether iCloud Drive or Dropbox has uploaded it is unknown, so closing the lid leaves the other Mac without the changes while this one says *Synced*;
  - files evicted to placeholders look present and stall when read, and a listing can be incomplete. `RemoteSyncingError` and the *remote still syncing* status exist only for this;
  - there is no conditional write, so `putCommit` falls back to looking and renaming where hard links are not available.

  None of this can be fixed from inside the app, and it rules out syncing automatically.

## Decision

1. **Sync behaviour follows from a photo's source.** A provider declares its reach, and the reach decides what syncs. A book has no sync options.
2. **The sync backend is a per-Mac app setting**, one at a time: first an S3-compatible bucket, later ImageFlow Cloud. A book only records whether it syncs on this Mac.
3. **Every trusted book syncs once a backend is configured**, unless it is opted out. A user's personal sync backend sits inside their trust boundary: only trusted books sync, and books downloaded from it arrive trusted.
4. **Each book has its own prefix on the remote**, with every blob it needs under it.
5. **The Start window is the library**: books on this Mac and books on the remote in one list, with the actions to download, stop syncing and delete. Storage is managed in Settings.
6. **Folders in iCloud Drive or Dropbox are no longer offered.** The folder transport stays for tests and development.

## 1. Sync by reach

The provider contract gains one declared property, `reach`. The engine reads it where it asks for `package` today.

| Reach | Providers | Locator | Facts and preview | Original |
| --- | --- | --- | --- | --- |
| `book` | `package` | synced | synced | synced; downloaded on demand, or always with *Keep originals* |
| `mac` | `linked`, `lightroom` | the portable part (`LocatorKind.shared`) | synced | never |
| `online` | a URL, Immich, S3 and other servers (none built yet) | synced whole | synced | never; each Mac reads it from its origin |

- **Every photo syncs facts and a 1400 px preview, whatever its reach.** This includes online photos: the preview is small, a Mac that is offline or not signed in can still lay out the book, and the web companion (#212) then needs one rule. Fact updates from non-file providers (`lightroom`, `online`) participate in change detection and per-asset auto-resolution just like local files.
- **Copy into Book is the only per-photo control.** It changes a photo's reach to `book`, as it changes its provider to `package` today.
- **Printing on another Mac** is unchanged from ADR 0011: a `mac` photo prints only where its folder or catalog is. Book check says so before the export.
- **Syncing full-resolution renders of placed `mac` photos** (0011, deferred) becomes practical with object storage. If built, it is one per-Mac preference, not a per-book one.

Where things are configured follows the same split:

| Per Mac (Settings) | Per book |
| --- | --- |
| The sync backend and its credentials | Its photos and their locators |
| Keep originals | Whether it syncs on this Mac |
| Where linked folders and the Lightroom catalog are | |
| The default folder for downloaded books | |

## 2. The backend

### An object store under `SyncRemote`

`SyncRemote` is implemented once, over a small object store. A transport implements only the store.

| Operation | Use |
| --- | --- |
| `putIfAbsent(key, bytes or file, options?)` | Commit headers and blobs; never replaces an object. Optional `sha256`, `signal` and progress |
| `get(key)`, `download(key, file, options?)` | Small and large objects; optional `signal` and progress |
| `head(key)` | Size and presence |
| `list(prefix)` | Keys with sizes and `lastModified` timestamps |
| `listPrefixes(prefix)` | Immediate child prefixes (e.g. `books/<bookId>/`), so listing books does not scan every blob |
| `copy(from, to)` | Duplicate, without uploading again |
| `delete(keys)` | Deleting a book, the sweep |

- **S3-compatible bucket:** endpoint, region, bucket and an optional prefix in app settings; the access key and secret are encrypted with `safeStorage` (keychain-backed) and stored in a separate `0600` credentials file, never in `settings.json`. `putIfAbsent` prefers `If-None-Match: *` (with head-then-put fallback if a service lacks conditional writes, since blobs are content-addressed and commit IDs are UUIDs; *unverified until the spike*). Works with S3, R2, B2, MinIO and Wasabi; the connection test checks conditional writes and checksum verification.
- **ImageFlow Cloud (later):** the same keys, reached through URLs a small service signs after authenticating the user. The client code above the store is unchanged.
- **Folder:** the store over a directory, for tests, development and possibly a NAS or external drive. It is not offered for folders a sync service manages.

### What a real store changes

- **A finished sync is finished.** A put is durable when it returns and a listing is complete. *Remote still syncing* becomes an error that should not happen for commits, state blobs and previews (an original still uploading from another Mac is surfaced separately as "still uploading", not as a sync error).
- **Sync can be automatic.** Pull when a book opens or regains focus, push when it has been idle after a save and when it closes. **File → Sync** stays as *Sync Now*. Fast-forward or keep both is unchanged, and automatic sync only fast-forwards or pushes — a divergence (even with a single remote tip) never creates a conflict copy or overwrites the open book without asking.
- **Listing commits is cached.** Headers are immutable, so a Mac keeps the ones it has read and fetches only keys it has not seen.
- **Originals upload in the background**, after the book state and previews, per-photo resumable across launches and with progress. The other Mac can open the book before the originals have arrived. Single PUT with `x-amz-content-sha256` (or `x-amz-checksum-sha256`, checked in the spike) covers photos far below S3's 5 GB limit while keeping whole-object server-side SHA-256 verification (*multipart is not needed unless the spike finds otherwise*).

### Remote identity

A remote carries a UUID, written at first use (`remote.json` at its root; if two Macs initialize an empty remote concurrently, the second reads and adopts the first's UUID). A book's sync record names the remote it last synced with. A book meeting another remote is asked about ("start syncing here, as a new history?"), so changing the bucket never forks a book silently.

### Trust

A user's configured sync backend is **inside their trust boundary** (revising ADR 0010's unauthenticated-folder rule):

- **Only trusted books sync.** An untrusted book (e.g. received from someone else) never starts syncing automatically, and **Templates → Stop Trusting This Book's Template…** also stops syncing on this Mac.
- **Explicit opt-in trusts and syncs.** Choosing **Start Syncing** on an untrusted local book (or selecting it in the first-configuration sheet) asks once to trust and sync it (`trustBook`), giving older or copied books without declared `network` origins a direct path into sync.
- **Downloaded books arrive trusted.** Because the configured backend holds only the user's own trusted books, `cloneFromRemote` marks the downloaded book trusted and synced template changes stay trusted without re-prompting.
- **Assumption:** personal sync credentials belong to the user's own Macs and are not shared with untrusted writers. If shared or multi-user books are added later, they stay outside this boundary and open untrusted.

## 3. Which books sync

ImageFlow has no library folder, so "every book" means every trusted book this Mac opens.

- **A trusted book starts syncing when it is opened with a backend configured**, and a new trusted book when it is created.
- **Configuring a backend uploads nothing by itself.** It lists the recent books with their sizes and asks once. Owned originals can be gigabytes. Unchecking a book records `enabled: false` for that remote so opening it later does not start syncing it.
- **Never auto-synced:** the sample book, template previews, read-only opens and untrusted books (which can opt in through *Start Syncing* after trusting the book).
- **Two ways out, kept apart:**
  - *Stop Syncing on This Mac* is local. The remote copy stays, and other Macs go on syncing.
  - *Delete from Sync* removes the book from the remote for every Mac. Local copies stay.

## 4. Remote layout

```
remote.json
books/<bookId>/snapshots/<commitId>.json
books/<bookId>/content/<digest>
books/<bookId>/originals/<digest><ext>
books/<bookId>/proxies/<digest>-preview-v1<ext>
books/<bookId>/covers/<digest>.jpg
books/<bookId>/deleted.json
```

- **Why per book:** deleting a book deletes one prefix, a book's size is one listing, and a service can scope credentials or a share link to one prefix.
- **Cost:** two books with the same photo store it twice. *Duplicate* and *Save a Copy* make a new `bookId` and record the source book's remote originals so the copy's first push copies them inside the store instead of uploading them — even if this Mac only holds previews or was offline when duplicating.
- **Blob keys** (`blobKeyPattern`, `src/sync-snapshot.ts`) become relative to a book. Nothing has shipped on the old layout beyond the folder test case, so there is no migration.
- **Sweep.** Commit headers and everything under `content/` (state blobs as well as historical `texts/`, `files/` and `template/` blobs) are kept for good: they are small, and the three-way merge of Milestone 2 needs the common ancestor. Originals, proxies and covers that no tip references (neither a tip's state blob nor a tip header's `coverDigest`) are deleted by *Clean Up*, after a grace period (7 days by object `lastModified`) so that a Mac that is mid-push does not lose what it just uploaded.
- **Deletion leaves a tombstone.** *Delete from Sync* cancels any active upload for the book, writes `deleted.json` (`{ version: 1, bookId, deletedAt }`) and removes everything else. A Mac that still has the book then asks ("removed from sync on another Mac: keep it here only, or sync it again?") instead of pushing it back.
- **Cover and format version.** `commitHeaderSchema` bumps to `version: 2` and gains an optional `coverDigest` pointing at `books/<bookId>/covers/<digest>.jpg` (the 320 px JPEG cover), so a book that is only on the remote has a thumbnail. Bumping to `version: 2` also ensures older builds hitting the per-book layout cleanly refuse with `NewerSyncFormatError` instead of misreading it as *Remote still syncing*; it ships with the layout change, before any real remote exists.

## 5. Library and storage

**Start window.** One list of the books on this Mac and on the remote, matched by `bookId` (`RecentDocuments` records `bookId` and keeps local synced books tracked rather than dropping them at a 20-item cap).

| State | Shown as | Actions |
| --- | --- | --- |
| On this Mac, synced | Sync status as in the editor | Open, Stop Syncing on This Mac, Delete from Sync |
| On this Mac, not syncing | *Not syncing* | Open, Start Syncing |
| On the remote only | Cover, title, last change | Download, Delete from Sync |
| Removed on another Mac | *Removed from sync* | Keep Here Only, Sync Again |
| Synced by a newer ImageFlow | *Needs an update* | Update |

- *Download* is `cloneFromRemote`, into the default books folder, without a save dialog. It opens trusted.
- *Update* opens Settings → General and checks for updates (or restarts if an update is already ready).
- **Open from Sync Folder** and **Sync with Folder…** are removed; **File → Sync** offers *Set Up Sync…* when no backend is configured.

**Settings → Sync.** The backend and a connection test, total and per-book storage (computed on demand, not at launch), *Keep originals*, *Sync automatically*, the default books folder, and *Clean Up*.

## Deferred

- Removing the local copy of a synced book from inside the app. Finder does it; doing it in the app needs proof that everything was pushed.
- Pruning history beyond the blob sweep.
- Client-side encryption. It conflicts with a web companion that serves previews.
- ImageFlow Cloud itself: accounts, quotas, the signing service.
- Shared or multi-user books (which would sit outside the personal trust boundary).
- Syncing full-resolution renders of `mac` photos (0011).
- Named local roots for linked folders (0010).
- More than one backend at a time.

## Consequences

- A book carries no sync configuration. What it syncs follows from its sources, and where it syncs follows from the Mac.
- *Synced* means that the other Mac can get the changes. Automatic sync and a library become possible.
- Treating a personal sync backend as inside the user's trust boundary removes friction when downloading and syncing books across the user's own Macs, while keeping untrusted books from elsewhere out of sync.
- Syncing needs a bucket until ImageFlow Cloud exists. That is a higher bar than choosing an iCloud folder, accepted because the folder could not keep the promise.
- `SyncRemote`, the engine and the snapshot format survive. The work is the object store and its S3 implementation, per-book keys, the remote identity and tombstone, moving the setting, and the library.

## Implementation order

1. Object store under `SyncRemote`, per-book keys and reserved v2/identity/tombstone formats (#278); folder and memory stores pass existing sync tests.
2. `reach` on the provider contract; engine reads it and syncs updated facts for non-file providers (#279).
3. Sync backend as a per-Mac setting with remote identity (#280).
4. S3-compatible object store (starting with the spike), `safeStorage` credentials, commit header cache and Settings → Sync pane (#281).
5. Every trusted opened book syncs with opt-out; originals upload in the background after the commit (#282).
6. Start window as the library: covers, download, stop, delete with tombstones; removes the development flag and ships sync (#283).
7. Automatic pull/push on open, focus, idle and close, with `fastForwardOnly` safety (#284).
8. On-demand storage figures, *Clean Up* sweep and *Duplicate*/*Save a Copy* server-side copy (#285).
