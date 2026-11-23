# Syncing books between Macs

ImageFlow can keep your books in sync between your Macs. Each Mac syncs through one place you choose in **Settings → Sync**: an S3-compatible bucket you bring, or iCloud where your version of ImageFlow offers it. Sync is off until you choose one, and nothing leaves your Mac before that.

Every Mac that syncs needs this version of ImageFlow or a later one: an older version cannot read what this one syncs, and asks to be updated instead of syncing.

## Set up sync

### An S3-compatible bucket

Any S3-compatible service works: Amazon S3, Cloudflare R2, Backblaze B2, MinIO or Wasabi.

1. Create a bucket for ImageFlow at your provider, and an access key that can read, write, list and delete in it (or under a prefix in it).
2. In **Settings → Sync**, choose **S3-compatible bucket**. Enter the endpoint, the bucket and its region (`auto` for R2), and an optional prefix if the bucket holds other things. You can paste the URL your provider shows, with the bucket in it; ImageFlow takes the bucket from it.
3. Enter the access key ID and the secret access key, then choose **Test Connection**. It says whether the service refuses to replace objects and whether it checks uploads, which ImageFlow makes up for when it does not.
4. Choose **Save**.

The secret access key is encrypted with a key in your Mac's keychain and kept apart from the other settings. ImageFlow never shows it again; to change it, enter a new one and save. **Turn Off** stops syncing on this Mac and forgets the key.

On your other Macs, enter the same bucket and key. That is all a Mac needs to see and download every book you synced.

### iCloud

Where your version of ImageFlow offers iCloud, choose **iCloud** in **Settings → Sync** and **Use iCloud**. There is nothing else to set up: the Mac's Apple Account is the sign-in, and your books go into ImageFlow's private storage in your iCloud, which only you can reach.

- Books count toward your iCloud storage (5 GB on the free plan). Settings → Sync says how much ImageFlow uses.
- When your iCloud storage is full, the book itself still syncs as long as it fits; originals that do not fit wait, and the status bar says so with **Manage Storage…**. They upload once there is room.
- macOS keeps a copy of the originals ImageFlow uploads and downloads in iCloud's own cache until it needs the space.
- Signing in with another Apple Account is syncing with another iCloud: books that synced with the first ask before they sync with the second.
- If you delete ImageFlow's data in **System Settings → Apple Account → iCloud → Manage Storage**, every book goes from iCloud, with the record of which books you deleted from sync. Books you had deleted from sync are then treated like any book that synced somewhere else: your Macs ask before they sync them again.

### Which books sync

When you first set up sync, ImageFlow lists your recent books with what their originals take up and asks which to sync. Nothing is uploaded until you choose. From then on, every book you open or create syncs, except:

- books you left out or stopped syncing on this Mac;
- the sample book, template previews and books opened read-only;
- books you do not trust. A book you did not make on this Mac syncs only once you trust it: **File → Sync → Start Syncing** asks once. **Templates → Stop Trusting This Book's Template…** also stops syncing it on this Mac.

**File → Sync → Sync Now** syncs the open book, and the status bar shows how it stands. A book changed on two Macs at once keeps both versions: the other Mac's continues, and this Mac's is saved beside it as a copy.

## What syncs

What a photo syncs follows from where it comes from:

| Photo | Syncs | Original |
| --- | --- | --- |
| Copied into the book | Its details and a 1400-pixel preview | Uploads after the book syncs, and downloads on your other Macs |
| Linked file | Its details, a preview and its file name | Stays on its Mac; locate it on each Mac |
| Lightroom Classic | Its details and a preview | Stays in the catalog on its Mac |

The book's text, files, template, layout and settings always sync. On a Mac without a photo's original, the book shows its preview, and **Book check** says before an export that the original is needed for print.

Originals upload in the background after the book has synced, so the other Mac can open the book before they arrive; it shows those photos as **Original still uploading from another Mac**. With **Keep originals of synced books on this Mac** (Settings → Sync, on by default), originals download in the background after each sync; without it, only previews are kept until **File → Sync → Download Originals**. An original that a Mac added a week ago and never uploaded (the Mac was not opened again) is shown as **never uploaded from** that Mac: open the book there to upload it.

## The library

The Start window lists the books on this Mac and, once sync is set up, the books in your sync that are not on this Mac yet.

| A book… | Shows | You can |
| --- | --- | --- |
| On this Mac, syncing | **Synced** | Open, Stop Syncing on This Mac, Delete from Sync |
| On this Mac, not syncing | **Not syncing** | Open, Start Syncing |
| Only in your sync | Its cover, title and last change | Download, Delete from Sync |
| Deleted from sync on another Mac | **Removed from sync** | Keep Here Only, Sync Again |
| Synced by a newer ImageFlow | **Needs an update** | Update |

Right-click a book (or press Shift-F10) for its actions.

- **Download** saves the book in **Documents → ImageFlow** (change the folder in **Settings → Sync**), with a number added if a book of that name is there, and opens it. A book Macs changed at once asks which version to download. The book arrives trusted; the first time its template loads maps or data, ImageFlow names the sites once.
- **Stop Syncing on This Mac** leaves the book and its copy in your sync as they are; your other Macs keep syncing it.
- **Delete from Sync** removes the book from your sync for every Mac, after asking. The copies on your Macs stay where they are, but only with what each Mac has: an original that no Mac downloaded (with **Keep originals** off, or still to download) is lost with the book, and a book that is on no Mac is gone for good. The question says how many originals of this Mac's copy are not on this Mac. Your other Macs show the book as **Removed from sync** and push nothing for it; there, **Keep Here Only** keeps it on that Mac without syncing, and **Sync Again** syncs it as a new book. A book synced by a newer ImageFlow can be deleted only from that version.
- **Update** checks for a newer ImageFlow in **Settings → General**, or restarts into one that is ready.

A book that syncs on this Mac stays in the list, however many books you open; to take it off, stop syncing it first. To remove a book from your Mac, move it to the Trash in Finder.

## Your sync is yours

ImageFlow treats your sync as your own: books you download from it are trusted, and template changes that arrive through it may load the sites their template declares without asking. Keep it that way:

- Use a bucket and an access key only you and your Macs use. Do not give the key to anyone, and do not sync someone else's books through your bucket.
- Books you get from someone else open untrusted and do not sync until you trust them.
