# 0012: One sync backend per Mac, sync by source reach, and a book library

Status: accepted, 2026-11-23, with the implementation (#278–#285; see [What the implementation settled](#what-the-implementation-settled)). Proposed the same day, revised after review and amended after the CloudKit spike (#286). Amended 2026-11-24: Download asks where a book goes, and there is no folder for downloaded books (#303); which books sync, storage and Clean Up are managed in a Sync window, where each book is turned on, instead of a list asked once in Settings (#306, #307). Builds on [0010](0010-sync-revisions-and-cloud-assets.md) (snapshots, `SyncRemote`, the folder transport) and [0011](0011-lightroom-classic.md) (source providers). Supersedes 0010's choice of a synced folder as the first transport, its per-book sync folder, and its untrusted-remote rule for a user's own backend (with the matching wording of [0006](0006-template-capabilities.md) about templates that arrive over sync); the snapshot model, the engine and the fast-forward-or-keep-both policy stay as they are.

## Problem

Sync and source providers were built separately and do not yet read as one design.

- **Sync is configured per book.** Each book records, per Mac, the folder it syncs through (`desktop/sync-pull.ts`, **File → Sync → Sync with Folder…**). Every book on every Mac has to be pointed at the same folder by hand, and nothing lists what is synced.
- **What syncs is decided by a special case.** The engine uploads an original when the photo's provider is `package`. ADR 0011 describes the general rule (its "reach" table) but the provider contract does not carry it, and an online provider has no place in it yet.
- **A synced folder cannot say that a sync finished.** The folder transport (`desktop/sync-store-folder.ts`) holds only immutable files, so it is safe, but:
  - a successful sync means "written to a local folder". Whether iCloud Drive or Dropbox has uploaded it is unknown, so closing the lid leaves the other Mac without the changes while this one says *Synced*;
  - files evicted to placeholders look present and stall when read, and a listing can be incomplete. `RemoteSyncingError` and the *remote still syncing* status exist only for this;
  - there is no conditional write, so `putCommit` falls back to looking and renaming where hard links are not available.

  None of this can be fixed from inside the app, and it rules out syncing automatically.

## Decision

1. **Sync behaviour follows from a photo's source.** A provider declares its reach, and the reach decides what syncs. A book has no sync options.
2. **The sync backend is a per-Mac app setting**, one at a time, and **sync is off until the user turns it on** in Settings → Sync and chooses the backend: **iCloud** (the user's private CloudKit database) or an **S3-compatible bucket** they bring. Neither is preselected, and being signed in to iCloud starts nothing. A book only records whether it syncs on this Mac.
3. **The user turns on which books sync.** Books made while sync is set up sync from the start. (First: every trusted book, unless it was opted out; amended by #307.) A user's personal sync backend sits inside their trust boundary: only trusted books sync, and books downloaded from it arrive trusted.
4. **Each book has its own prefix on the remote**, with every blob it needs under it.
5. **The Start window is the library**: books on this Mac and books on the remote in one list, to open and download. **The Sync window** manages what syncs: a switch per book, what each takes up, Delete from Sync and Clean Up (#307; first in the Start window and in Settings).
6. **Folders in iCloud Drive or Dropbox are no longer offered.** The folder transport stays for tests and development. iCloud as a backend means CloudKit, not a folder in iCloud Drive.

## 1. Sync by reach

The provider contract gains one declared property, `reach`. The engine reads it where it asks for `package` today.

| Reach | Providers | Locator | Facts and preview | Original |
| --- | --- | --- | --- | --- |
| `book` | `package` | synced | synced | synced; downloaded on demand, or always with *Keep originals* |
| `mac` | `linked`, `lightroom` | the portable part (`LocatorKind.shared`) | synced | never |
| `online` | a URL, Immich, S3 and other servers (none built yet) | synced whole | synced | never; each Mac reads it from its origin |

- **Every photo syncs facts and a 1400 px preview, whatever its reach.** This includes online photos: the preview is small, a Mac that is offline or not signed in can still lay out the book, and the web companion (#212) then needs one rule. Fact updates from non-file providers (`lightroom`, `online`) participate in change detection and per-asset auto-resolution just like local files.
- **Copy into Book is the only per-photo control.** It changes a photo's reach to `book`, as it changes its provider to `package` today.
- **Printing on another Mac** is unchanged from ADR 0011: a `mac` photo prints only where its folder or catalog is. Book check says so before the export, in one line for all of them (#308).
- **Syncing full-resolution renders of placed `mac` photos** (0011, deferred) becomes practical with object storage. If built, it is one per-Mac preference, not a per-book one.

Where things are configured follows the same split:

| Per Mac (Settings) | Per book |
| --- | --- |
| The sync backend and its credentials | Its photos and their locators |
| Keep originals | Whether it syncs on this Mac |
| Where linked folders and the Lightroom catalog are | |

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
| `copy(from, to)` (optional) | Duplicate, without uploading again. A store without a server-side copy (CloudKit) leaves it out, and the caller uploads instead |
| `delete(keys)` | Deleting a book, the sweep |
| `changes(bookId, token)` (optional) | What changed in a book since a token. Where a store has it (CloudKit), it replaces listing commits and the commit header cache |

- **S3-compatible bucket:** endpoint, region, bucket and an optional prefix in app settings; the access key and secret are encrypted with `safeStorage` (keychain-backed) and stored in a separate `0600` credentials file, never in `settings.json`. `putIfAbsent` prefers `If-None-Match: *` (with head-then-put fallback if a service lacks conditional writes, since blobs are content-addressed and commit IDs are UUIDs; *unverified until the spike*). Works with S3, R2, B2, MinIO and Wasabi; the connection test checks conditional writes and checksum verification.
- **iCloud (CloudKit):** the private database of the container `iCloud.ch.wirhabenzeit.imageflow`, through a native addon. One record zone per book and one generic record type `Blob` (bytes up to 256 KB inline, larger ones as an asset, plus `size` and `sha256`); the record name is the key below `books/<bookId>/`. `remote.json` and the tombstones live in an `index` zone, so deleting a book's zone keeps its tombstone. `putIfAbsent` is a save that fails when the record exists, a real conditional write; `listPrefixes` lists zones; deleting a book deletes its zone; zone change tokens give `changes`. The spike (`spikes/cloudkit/README.md`) measured all of this on two Macs. Nothing to set up: the Mac's Apple ID is the login, storage counts against the user's iCloud plan, and a database subscription tells other Macs to pull. It needs a signed build with an embedded provisioning profile and cannot be tested in CI, so the store conformance suite runs against it locally.
- **ImageFlow Cloud (perhaps later):** the same keys, reached through URLs a small service signs after authenticating the user. The client code above the store is unchanged. iCloud covers what it was for on the Mac; it remains an option for a web companion or another platform.
- **Folder:** the store over a directory, for tests, development and possibly a NAS or external drive. It is not offered for folders a sync service manages.

### What a real store changes

- **A finished sync is finished.** A put is durable when it returns and a listing is complete. *Remote still syncing* becomes an error that should not happen for commits, state blobs and previews (an original still uploading from another Mac is surfaced separately as "still uploading", not as a sync error).
- **Sync can be automatic.** Pull when a book opens or regains focus, push when it has been idle after a save and when it closes. **File → Sync** stays as *Sync Now*. Fast-forward or keep both is unchanged, and automatic sync only fast-forwards or pushes — a divergence (even with a single remote tip) never creates a conflict copy or overwrites the open book without asking.
- **Listing commits is cached.** Headers are immutable, so a Mac keeps the ones it has read and fetches only keys it has not seen. A store with `changes` (CloudKit) is asked only for what changed since its token instead: 0.3 s against 9 s for a full listing of 3000 records in the spike.
- **Originals upload in the background**, after the book state and previews, per-photo resumable across launches and with progress. What is still to upload is derived, not recorded: an original the tip names, that is here, and that the remote's listing lacks. Any Mac holding the file therefore repairs a missing original at its next sync; previews are checked the same way at each push. The other Mac can open the book before the originals have arrived. Single PUT with `x-amz-content-sha256` (or `x-amz-checksum-sha256`, checked in the spike) covers photos far below S3's 5 GB limit while keeping whole-object server-side SHA-256 verification (*multipart is not needed unless the spike finds otherwise*).

### Remote identity

A remote carries a UUID, written at first use (`remote.json` at its root; a Mac always reads it back after writing and adopts what is there, so two Macs that initialize an empty remote at once agree, also where the store has no conditional write). A book's sync record names the remote it last synced with. A book meeting another remote is asked about ("start syncing here, as a new history?"), so changing the bucket never forks a book silently. With iCloud, each Apple ID has its own private database and so its own `remote.json`: signing in with another Apple ID is meeting another remote. CloudKit's account-change event also fires without a change, so the app compares the iCloud user record ID before treating it as one.

### Trust

A user's configured sync backend is **inside their trust boundary** (revising ADR 0010's unauthenticated-folder rule):

- **Only trusted books sync.** An untrusted book (e.g. received from someone else) never starts syncing automatically, and **Templates → Stop Trusting This Book's Template…** also stops syncing on this Mac.
- **Explicit opt-in trusts and syncs.** Choosing **Start Syncing** on an untrusted local book, or turning on its switch in the Sync window, asks once to trust and sync it (`trustBook`), giving older or copied books without declared `network` origins a direct path into sync.
- **Downloaded books arrive trusted.** Because the configured backend holds only the user's own trusted books, `cloneFromRemote` marks the downloaded book trusted and synced template changes stay trusted without re-prompting. The download says once which sites the book's template loads from, as a notice and not a question; a pulled template change that adds a site does the same (the existing notice for trusted books).
- **Trusted means what `bookTrusted` means today** (`desktop/source-access.ts`): made here, trusted once, or a book for which a site was allowed before. A received book whose map site the user allowed therefore counts as their own and syncs.
- **iCloud fits this rule best:** the private database is authenticated as the user and reachable only by them.
- **Assumption:** personal sync credentials belong to the user's own Macs and are not shared with untrusted writers. If shared or multi-user books are added later, they stay outside this boundary and open untrusted.

## 3. Which books sync

(Amended by #307. First, a trusted book started syncing when it was opened with a backend configured, and Settings asked once which of the recent books to leave out.)

- **Configuring a backend uploads nothing by itself.** The Sync window opens with the books on this Mac switched off, except those whose own sync record says they sync with this remote (sync was off in between), beside the books that are on the remote. Owned originals can be gigabytes; nothing of a book goes up until its switch is turned on.
- **A book that was there before never starts by itself**, whether it was among the recent books or is found and opened later. Turning its switch on, or Start Syncing in it, records it as syncing (`remoteId`, `enabled`), and that record is what syncs it.
- **A book made from then on syncs by default.** Setting a backend up (the first one, or another) makes a new *set-up* (`AppSettings.syncSetup`, a UUID). New Book notes it in the book's record (`startWith`), which needs no request, and the book starts at its first open while that set-up lasts; its first sync replaces the note. Another set-up does not know the note, so turning sync off and on, or changing the backend, starts no book that did not sync yet. A copy (Duplicate, Keep Both) does what the book it was made from does, with the same remote.
- **A book turned on while it is closed syncs without being opened**: under its writer lock, pushing or fast-forwarding only (`desktop/sync-closed.ts`). Opening it stops that sync, and the open book's own goes on.
- **Installations from before #307** are settled once, at launch, without a request (`settleSyncSetup`). Where the list was answered, books with a record go on as they are, and a recent trusted book without one was chosen and not opened since: it is noted like a new book and starts when it opens. Where the list was never answered, nothing syncs by itself until it is settled, and the recent books with a record are turned off.
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
deleted/<bookId>.json
```

- **Why per book:** deleting a book deletes one prefix, a book's size is one listing, and a service can scope credentials or a share link to one prefix.
- **Cost:** two books with the same photo store it twice. *Duplicate* and *Save a Copy* make a new `bookId` and record the source book's remote originals so the copy's first push copies them inside the store instead of uploading them — even if this Mac only holds previews or was offline when duplicating.
- **Blob keys** (`blobKeyPattern`, `src/sync-snapshot.ts`) become relative to a book. Nothing has shipped on the old layout beyond the folder test case, so there is no migration.
- **Sweep.** Commit headers and everything under `content/` (state blobs as well as historical `texts/`, `files/` and `template/` blobs) are kept for good: they are small, and the three-way merge of Milestone 2 needs the common ancestor. Originals, proxies and covers that no tip references (neither a tip's state blob nor a tip header's `coverDigest`) are deleted by *Clean Up*, after a grace period (7 days by object `lastModified`) so that a Mac that is mid-push does not lose what it just uploaded. The grace period does not protect an old blob that a push reuses instead of uploading (a photo removed and added again), so *Clean Up* reads the tips again immediately before it deletes, and a blob lost in the remaining window is uploaded again by the repair above.
- **Deletion leaves a tombstone.** *Delete from Sync* cancels any active upload for the book, writes `deleted.json` (`{ version: 1, bookId, deletedAt }`) and removes everything else. A Mac that still has the book then asks ("removed from sync on another Mac: keep it here only, or sync it again?") instead of pushing it back. Beside it, a marker `deleted/<bookId>.json` at the remote's root lets the library find every deleted book in one listing; the deletion writes the marker first, then removes the commits, then writes the tombstone, and a book with a marker and no commits reads as deleted.
- **Cover and format version.** `commitHeaderSchema` bumps to `version: 2` and gains an optional `coverDigest` pointing at `books/<bookId>/covers/<digest>.jpg` (the 320 px JPEG cover), so a book that is only on the remote has a thumbnail. Bumping to `version: 2` also ensures older builds hitting the per-book layout cleanly refuse with `NewerSyncFormatError` instead of misreading it as *Remote still syncing*; it ships with the layout change, before any real remote exists.

## 5. Library and storage

**Start window.** One list of the books on this Mac and on the remote, matched by `bookId` (`RecentDocuments` records `bookId` and keeps local synced books tracked rather than dropping them at a 20-item cap).

| State | Shown as | Actions |
| --- | --- | --- |
| On this Mac, synced | Sync status as in the editor | Open |
| On this Mac, not syncing | *Not syncing* | Open |
| On the remote only | Cover, title, last change | Download |
| Removed on another Mac | *Removed from sync* | Keep Here Only, Sync Again |
| Synced by a newer ImageFlow | *Needs an update* | Update |

- What syncs is managed in the Sync window, which the rows' menu opens (*Manage Synced Books…*).
- *Download* is `cloneFromRemote`, to where a save panel of the Start window asks for, with the book's title as the name. With several versions, which one is asked first. A name that is taken and a place inside another book are refused. It opens trusted. A download shows on its row how many of the book's files and previews are here, with Cancel, which leaves nothing behind; it belongs to the app, so closing the window does not end it, and Quit asks (#305). (Amended by #303: it first saved into a default books folder, `~/Documents/ImageFlow` unless changed in Settings, without asking, so macOS asked for access to a folder the user never chose.)
- *Update* opens Settings → General and checks for updates (or restarts if an update is already ready).
- **Open from Sync Folder** and **Sync with Folder…** are removed; **File → Sync** offers *Set Up Sync…* when no backend is configured.

**Sync window** (#307), opened from Settings → Sync, **File → Sync → Manage Synced Books…** and the Start window's rows, and by itself when a backend is set up. One table of the books on this Mac and on the remote, matched as in the Start window: cover, title and where it is; what it takes up; what sync does with it (transfers and failures, in a few words); and a switch for each book on this Mac, which is Start Syncing and Stop Syncing on This Mac. Sizes fill in as they are counted, two books at a time, since over a bucket each is a listing. The footer has the total and *Clean Up*. A row's menu has Delete from Sync and the other actions.

**Settings → Sync.** Sync is off at first. The choice is Off, iCloud (listed when this build can use it) or an S3-compatible bucket, with neither backend preselected. Off and iCloud take one click; a bucket has its fields and connection test in a sheet. Beside it are *Keep originals* and *Sync automatically*. The pane keeps one height in every state (#306). While sync is off, the Start window offers *Set Up Sync…*. Which books sync, storage and Clean Up are in the Sync window.

## Deferred

- Removing the local copy of a synced book from inside the app. Finder does it; doing it in the app needs proof that everything was pushed.
- Pruning history beyond the blob sweep.
- Client-side encryption. It conflicts with a web companion that serves previews.
- ImageFlow Cloud itself: accounts, quotas, the signing service.
- Shared or multi-user books (which would sit outside the personal trust boundary). CloudKit zone sharing is a possible path, since a book is a zone.
- Syncing full-resolution renders of `mac` photos (0011).
- Named local roots for linked folders (0010).
- More than one backend at a time.

## Consequences

- A book carries no sync configuration. What it syncs follows from its sources, and where it syncs follows from the Mac.
- *Synced* means that the other Mac can get the changes. Automatic sync and a library become possible.
- Treating a personal sync backend as inside the user's trust boundary removes friction when downloading and syncing books across the user's own Macs, while keeping untrusted books from elsewhere out of sync.
- Sync is opt-in: nothing leaves the Mac until the user turns sync on and chooses a backend. On a Mac signed in to iCloud, choosing iCloud needs no further setup. A bucket serves users without iCloud or who want their own storage; that is a higher bar than choosing an iCloud Drive folder, accepted because the folder could not keep the promise.
- iCloud sync uses the user's iCloud storage (5 GB on the free plan), works only on Apple platforms, and CloudKit keeps its own cache copy of uploaded and downloaded originals until the system purges it.
- Signing gains restricted entitlements and an embedded Developer ID provisioning profile. Without the profile the app is killed at launch, so the release checks verify it; a Mac with the profile installed hides its absence.
- `SyncRemote`, the engine and the snapshot format survive. The work is the object store and its S3 and CloudKit implementations, per-book keys, the remote identity and tombstone, moving the setting, and the library.

## What the implementation settled

Where this section and the text above differ, this section holds.

- **Sync is automatic** (#284): an automatic sync only fast-forwards or pushes; a divergence, with one tip or several, waits for **Sync Now**. iCloud pushes come from a `CKDatabaseSubscription`, which names the database, not a zone, so every open book looks.
- **Storage figures** (#285) are one path for every backend: `SyncRemote.usage()` per book. The Sync window counts them in the background while it is open (#307; first only when asked, in Settings); over iCloud they come from the key indexes.
- **Clean Up** (#285) runs over every book on the remote at once, after showing what it would free; the main process asks before it deletes, as for Delete from Sync. **The grace period counts from the removal, not the upload:** a blob is kept while a tip names it, while a commit made within the week dropped it (the parents of every commit of the last week are read as tips are), and while the store's time of last change is within the week. An original a book's tip names but lacks (a duplicate still copying it) is kept in every book. A push checks the previews it carries forward against the remote and sends a missing one again, and a sync with nothing to push sends the missing previews of its snapshot, where this Mac holds the recorded bytes, so a preview lost to the race does not stop other Macs from pulling. It lists each book in the store itself (`listBook(…, { full: true })`), never from a key index, and deletes through `SyncRemote.deleteBlobs`, which accepts only `originals/`, `proxies/` and `covers/` keys and removes them from the key index and from the listing of a sync running on this Mac, so a later push uploads a swept blob again instead of trusting either. A book whose tips cannot be read (none yet, a snapshot missing, damaged or from a newer version) is left alone. What is left of a deleted book goes through `SyncRemote.deleteRemains`, which refuses a book without a tombstone; on iCloud nothing is left, since deleting a book deletes its zone.
- **Duplicate and Save a Copy** (#285) note the source in the copy's sync record (`copiedFrom`: the source's `bookId`, its remote, and the originals by photo, from the source's sync record and photos.json, so it works offline and on a Mac with previews only). The copy's first push names those originals for photos without a file here, and its background upload copies each inside the store (`copyBlob`) before it would upload. Where the store cannot copy (iCloud), it uploads the file here, or, on a Mac with previews only, downloads the original from the source book and uploads it again. The Duplicate question says so when the backend is iCloud. The hint is used only while the copy syncs with the remote it names, only for the originals it names (a photo added to the copy later uploads with no copy request), and it is dropped once none of them is left to copy.
- **Not done:** whether macOS purges CloudKit's asset cache (`~/Library/Caches/CloudKit/<bundle ID>`) is still unchecked on a signed build, so Settings → Sync does not show its size.

## Implementation order

1. Object store under `SyncRemote`, per-book keys and reserved v2/identity/tombstone formats (#278); folder and memory stores pass existing sync tests.
2. `reach` on the provider contract; engine reads it and syncs updated facts for non-file providers (#279).
3. Sync backend as a per-Mac setting with remote identity (#280).
4. S3-compatible object store (starting with the spike), `safeStorage` credentials, commit header cache and Settings → Sync pane (#281).
5. iCloud (CloudKit) object store with the optional change feed, iCloud as a backend choice beside S3, and the signing changes (#292).
6. Every trusted opened book syncs with opt-out; originals upload in the background after the commit (#282).
7. Start window as the library: covers, download, stop, delete with tombstones; removes the development flag and ships sync (#283).
8. Automatic pull/push on open, focus, idle and close, with `fastForwardOnly` safety; for iCloud, a database subscription whose push starts a pull (#284).
9. On-demand storage figures, *Clean Up* sweep and *Duplicate*/*Save a Copy* server-side copy (#285).
