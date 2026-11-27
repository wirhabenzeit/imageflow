# Syncing books between Macs

ImageFlow can keep your books in sync between your Macs. Each Mac syncs through one place you choose in **Settings → Sync**: an S3-compatible bucket you bring, or iCloud where your version of ImageFlow offers it. Sync is off until you choose one, and nothing leaves your Mac before you turn on a book. **Set Up Sync…** in the Start window opens the setting.

Every Mac that syncs needs this version of ImageFlow or a later one: an older version cannot read what this one syncs, and asks to be updated instead of syncing.

## Set up sync

### An S3-compatible bucket

Any S3-compatible service works: Amazon S3, Cloudflare R2, Backblaze B2, MinIO or Wasabi.

1. Create a bucket for ImageFlow at your provider, and an access key that can read, write, list and delete in it (or under a prefix in it).
2. In **Settings → Sync**, choose **S3 bucket**. Enter the endpoint, the bucket and its region (`auto` for R2), and an optional prefix if the bucket holds other things. You can paste the URL your provider shows, with the bucket in it; ImageFlow takes the bucket from it.
3. Enter the access key ID and the secret access key, then choose **Test Connection**. It says whether the service refuses to replace objects and whether it checks uploads, which ImageFlow makes up for when it does not.
4. Choose **Save**.

The secret access key is encrypted with a key in your Mac's keychain and kept apart from the other settings. ImageFlow never shows it again; to change it, choose **Edit…**, enter a new one and save. **Off** stops syncing on this Mac and, after asking, forgets the key.

On your other Macs, enter the same bucket and key. That is all a Mac needs to see and download every book you synced.

### iCloud

Where your version of ImageFlow offers iCloud, choose **iCloud** in **Settings → Sync**. There is nothing else to set up: the Mac's Apple Account is the sign-in, and your books go into ImageFlow's private storage in your iCloud, which only you can reach.

- Books count toward your iCloud storage (5 GB on the free plan). The Sync window says how much each book uses (see [Storage and Clean Up](#storage-and-clean-up)).
- When your iCloud storage is full, the book itself still syncs as long as it fits; originals that do not fit wait, and the status bar says so with **Manage Storage…**. They upload once there is room.
- macOS keeps a copy of the originals ImageFlow uploads and downloads in iCloud's own cache until it needs the space.
- Signing in with another Apple Account is syncing with another iCloud: books that synced with the first ask before they sync with the second.
- If you delete ImageFlow's data in **System Settings → Apple Account → iCloud → Manage Storage**, every book goes from iCloud, with the record of which books you deleted from sync. Books you had deleted from sync are then treated like any book that synced somewhere else: your Macs ask before they sync them again.

### Which books sync

You turn on each book you want to sync. When you set up sync, the **Sync window** opens with the books on this Mac and the books already in your sync; the books on this Mac are switched off, and nothing is uploaded until you turn one on. Open the window again at any time with **Manage Synced Books…** in **Settings → Sync**, **File → Sync**, or by right-clicking the sync status in a book's status bar.

- Turn a book on to sync it. It does not have to be open. Turn it off to stop syncing it on this Mac. **File → Sync → Start Syncing** and **Stop Syncing on This Mac…** do the same for the open book.
- A book you make while sync is set up syncs from the start, as does a duplicate of a book that syncs. A book that was on this Mac before never starts by itself.
- The sample book, template previews and books opened read-only do not sync.
- A book you did not make on this Mac syncs only once you trust it: turning it on asks once. **Templates → Stop Trusting This Book's Template…** also stops syncing it on this Mac.

If you set up sync with an earlier version of ImageFlow, the books that synced go on syncing. If you never answered its question which books to sync, no book syncs until you turn it on.

### Syncing by itself

A book that syncs keeps itself current, with **Sync automatically** on in **Settings → Sync** (it is on unless you turn it off):

- When the book opens, when its window comes to the front, and every few minutes while it is open, it looks for what your other Macs synced and takes it. Looking costs one quick question to iCloud or your bucket; nothing is downloaded when nothing changed. With iCloud, a change from another Mac also reaches a book that is open in the background right away.
- After you edit, it sends your changes once you have stopped for about 30 seconds, and when you close the book. Closing waits a few seconds at most: what did not go up by then goes up the next time the book syncs. Originals follow in the background.
- It takes changes only when nothing is being edited: while you type in a field, while a text is open in its own editor, while an inline editor is open, while the book exports or an agent changes it, the changes wait and arrive once you are done. Before an agent saves a change to a book with changes to fetch, the book takes them first, so the agent's change does not leave the book changed on two Macs; the agent then looks at the book again before it saves.
- Taking changes from another Mac starts **Undo** over: each Undo step brings back the whole book as it was, so undoing an earlier step would also undo the other Mac's changes. The status bar says so, and **Edit → Undo** reads **Can’t Undo After Sync** until your next edit. Edits you make after that can be undone as usual.
- Editing always comes first: an edit you make while the book syncs by itself is never refused. Sending stops and starts again once you pause. Only when the book is just then taking changes from another Mac does your edit wait a moment, and if it was made on the version before those changes, ImageFlow says so and you make it again.
- It never decides for you. A book changed on two Macs at once shows **Changed on two Macs** and waits for you.
- When the other Macs cannot be reached (offline, iCloud unavailable), the status bar says so and the book tries again later, sooner once the network changes. No dialog interrupts you.
- When your iCloud storage is full, the book itself goes on syncing while it fits; its originals wait until **Sync Now**, or until you open the book again.

**File → Sync → Sync Now** syncs the open book at once, and the status bar shows how it stands. With **Sync automatically** off, books sync only then: the status bar still shows **Changes to fetch** when you come back to the book, and an agent is told so before it saves. Sync Now on a book changed on two Macs at once keeps both versions: the other Mac's continues, and this Mac's is saved beside it as a copy.

## What syncs

What a photo syncs follows from where it comes from:

| Photo | Syncs | Original |
| --- | --- | --- |
| Copied into the book | Its details and a 1400-pixel preview | Uploads after the book syncs, and downloads on your other Macs |
| Linked file | Its details, a preview and its file name | Stays on its Mac; locate it on each Mac |
| Lightroom Classic | Its details and a preview | Stays in the catalog on its Mac |

The book's text, files, template, layout and settings always sync. On a Mac without a photo's original, the book shows its preview, and **Book check** says in one line that the originals are needed for printing. Exporting without them asks first and marks the pages.

Originals upload in the background after the book has synced, so the other Mac can open the book before they arrive; it shows those photos as **Original still uploading from another Mac**. With **Keep originals on this Mac** (Settings → Sync, on by default), originals download in the background after each sync; without it, only previews are kept until **File → Sync → Download Originals**. An original that a Mac added a week ago and never uploaded (the Mac was not opened again) is shown as **never uploaded from** that Mac: open the book there to upload it.

## The library

The Start window lists the books on this Mac and, once sync is set up, the books in your sync that are not on this Mac yet.

| A book… | Shows | You can |
| --- | --- | --- |
| On this Mac, syncing | **Synced** | Open |
| On this Mac, not syncing | **Not syncing** | Open |
| Only in your sync | Its cover, title and last change | Download |
| Deleted from sync on another Mac | **Removed from sync** | Keep Here Only, Sync Again |
| Synced by a newer ImageFlow | **Needs an update** | Update |

Right-click a book (or press Shift-F10) for its actions; **Manage Synced Books…** opens the Sync window, which lists the same books to turn them on and off. Right-click a book there for **Delete from Sync…** and the rest.

- **Download** asks where to save the book, with its title as the name, and opens it. It never replaces a book: if the name is taken there, choose another. A book Macs changed at once asks first which version to download. The book's row shows how much has arrived, with a button to cancel; a cancelled download leaves nothing on your Mac. The book arrives trusted; the first time its template loads maps or data, ImageFlow names the sites once.
- **Stop Syncing on This Mac** leaves the book and its copy in your sync as they are; your other Macs keep syncing it.
- **Delete from Sync** removes the book from your sync for every Mac, after asking. The copies on your Macs stay where they are, but only with what each Mac has: an original that no Mac downloaded (with **Keep originals** off, or still to download) is lost with the book, and a book that is on no Mac is gone for good. The question says how many originals of this Mac's copy are not on this Mac. Your other Macs show the book as **Removed from sync** and push nothing for it; there, **Keep Here Only** keeps it on that Mac without syncing, and **Sync Again** syncs it as a new book. A book synced by a newer ImageFlow can be deleted only from that version.
- **Update** checks for a newer ImageFlow in **Settings → General**, or restarts into one that is ready.

A book that syncs on this Mac stays in the list, however many books you open; to take it off, stop syncing it first. To remove a book from your Mac, move it to the Trash in Finder.

## Storage and Clean Up

The Sync window shows what each book takes up in your sync, and the total below. The figures fill in while it is open; over a bucket that takes a moment for each book. Point at a book's size to see what it is: previews, originals, covers, and its texts, files and history. The tooltip also says how much of it the book no longer uses, and from when Clean Up can free it.

Your sync keeps every version of every book, but not every photo. When you remove a photo, or a book gets a new cover, the old original, preview and cover stay in your sync until you choose **Clean Up…** in the Sync window:

- Clean Up first says how much it would free, and asks once more before it deletes anything, since what it deletes is gone for every Mac.
- It deletes originals, previews and covers that a book has not used for a week: the week starts when you remove the photo or change the cover, so your other Macs have that week to sync before the original goes. Anything uploaded in the last week stays too, so a Mac that is in the middle of syncing loses nothing. A book changed on two Macs keeps what either version uses, and a duplicate still copying an original keeps it in the book it was duplicated from.
- It also deletes what is left of books deleted from sync (a bucket only; iCloud removes them whole).
- A book's text, files, template and history stay. Clean Up leaves a book alone when it cannot read what the book uses (for example, one synced by a newer ImageFlow).
- If you add a photo back while Clean Up runs, its original stays. In the rare case that an original or preview goes anyway, a Mac that has it uploads it again at its next sync.

### Duplicating a synced book

**File → Duplicate…** makes a new book, which syncs as a book of its own. Over a bucket its originals are copied inside the bucket from the book you duplicated, so nothing is uploaded again, also when this Mac keeps only previews or is offline when you duplicate. iCloud cannot copy inside your storage: the duplicate's originals are uploaded again (from this Mac, or downloaded from the book you duplicated first, when this Mac keeps only previews) and count toward your iCloud storage a second time. The question before you duplicate says so.

## Your sync is yours

ImageFlow treats your sync as your own: books you download from it are trusted, and template changes that arrive through it may load the sites their template declares without asking. Keep it that way:

- Use a bucket and an access key only you and your Macs use. Do not give the key to anyone, and do not sync someone else's books through your bucket.
- Books you get from someone else open untrusted and do not sync until you trust them.
