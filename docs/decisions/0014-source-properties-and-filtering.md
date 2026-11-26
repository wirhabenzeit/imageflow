# 0014: Source properties, overlays and filtering

Status: proposed, 2026-11-26. Builds on [0011](0011-lightroom-classic.md) (the source provider contract and `AssetFact.extra`) and [0013](0013-apple-photos.md) (Apple Photos provider).

## Problem

Laying out a photo book is largely selection and sequencing: photographers import dozens or hundreds of candidate photos from Lightroom Classic or Apple Photos and rely on the curation work they already did there — star ratings, pick/reject flags, colour labels, favourites — to separate hero spreads from supporting shots and rejects.

Today those marks are invisible inside ImageFlow. Users have to switch back to Lightroom or Photos to remember which photos they starred, hearted or rejected, and cannot narrow the filmstrip or Manage Assets by those properties — or even isolate one source (such as "Lightroom Classic only") in a book that mixes photos from several sources.

## Decision

Let source providers **declaratively describe read-only curation properties** stored in `AssetFact.extra`, while the **host** renders them consistently across four places:

1. **Per-provider View submenus** (native **View** menu and inline **View ▾** popup) to toggle thumbnail overlays.
2. **Thumbnail overlays** in the Sources strip (plus Manage Assets rows and Quick Look).
3. **A dedicated Filter popover** outside the View menu, combining placement, source and per-provider property filters with removable inline chips. A provider's property filters narrow that provider's photos only; photos from every other source are untouched by them.
4. **Read-only rows in the photo Inspector.**

Properties are strictly editorial cues for the person laying out the book: they stay read-only toward external libraries, never reach templates, and never enter the portable book-state revision.

### 1. Declarative provider property contract

Following the two-half split of ADR 0011 (`SourceProvider` in `desktop/`, pure `LocatorKind` in `src/`), providers do not supply React components or Electron menu code. Instead, a pure shared registry (`src/source-properties.ts`) declares each provider's displayable and filterable properties using a small host-owned vocabulary:

```ts
export type SourceColor = 'red' | 'yellow' | 'green' | 'blue' | 'purple';

export type SourceBadgeMark =
  | { kind: 'stars'; value: number }            // 1..5
  | { kind: 'heart' }                           // favourite
  | { kind: 'flag'; value: 'pick' | 'reject' }
  | { kind: 'color'; value: SourceColor; label?: string };

export type SourcePropertySpec = {
  /** Stable key used in PhotoView persistence and commands, e.g. 'lightroom:rating'. */
  id: string;
  /** The mark this property reads. It decides the overlay, the Inspector row and the filter control. */
  kind: SourceBadgeMark['kind'];
  /** Label inside View → <Provider> → … */
  viewLabel: string;
  /** Default overlay visibility when the user has not toggled this property. */
  defaultVisible: boolean;
  /** Label in the photo Inspector's facts list. */
  inspectorLabel: string;
  /** Extracts the mark from `AssetFact.extra`; undefined when unset or not a value of the vocabulary (renders nothing). */
  read(extra: Record<string, unknown> | undefined): SourceBadgeMark | undefined;
};

/** One provider's properties, declared once: its label heads the View submenu and the Filter section. */
export type SourceProviderProperties = {
  provider: string;                             // 'lightroom' | 'photos'
  label: string;                                // 'Lightroom Classic' | 'Apple Photos'
  properties: readonly SourcePropertySpec[];
};
```

The host owns everything a mark's kind implies, so a provider declares neither a filter nor a formatter: `stars` gets a minimum-rating filter, `heart` an only-these toggle, `flag` one four-way choice and `color` a multi-select of swatches (section 5), and the host formats the Inspector value and its accessible text (section 6).

Initial declarations:

| Provider | Property ID | `extra` key(s) | View menu item | Default overlay | Filter control |
| --- | --- | --- | --- | --- | --- |
| Apple Photos | `photos:favorite` | `favorite?: true` | `View → Apple Photos → Show Favorites` | **On** | `Favorites only` toggle |
| Lightroom Classic | `lightroom:rating` | `rating?: 1 \| 2 \| 3 \| 4 \| 5` | `View → Lightroom Classic → Show Stars` | **On** | Minimum rating (`★`–`★★★★★`, click active star to clear) |
| Lightroom Classic | `lightroom:flag` | `flag?: 'pick' \| 'reject'` | `View → Lightroom Classic → Show Flags` | **On** | One choice: `Any`, `Picked`, `Not Rejected`, `Rejected` |
| Lightroom Classic | `lightroom:color` | `color?: SourceColor`, `colorLabel?: string` | `View → Lightroom Classic → Show Color Labels` | **Off** | Multi-select colour swatches (`red`, `yellow`, `green`, `blue`, `purple`) |

Unset values (`favorite: false`, `rating: 0`, `pickStatus: 0`, `colorNameForLabel: 'none'`) are omitted from `extra` so unmarked photos stay clean in `assets-meta.json` and render no overlay.

**This changes what `extra` is.** ADR 0011 and the comments in `desktop/source-provider.ts` and `src/asset-facts.ts` call it the provider's own, which the host does not read; it already holds `orientation` and `fileName` (Lightroom Classic) and `type` and `fileName` (Apple Photos). From here on the host reads the keys a provider's specs declare, through `read()` only, and those keys (`rating`, `flag`, `color`, `colorLabel`, `favorite`) are reserved for that meaning. Every other key stays the provider's own. Both comments are updated with the code. `read()` returns undefined for a value outside the vocabulary (a colour that is none of the five, a rating of 7), so a malformed or newer fact renders nothing rather than something wrong.

### 2. Storage, sync, providers and live updates

- **Storage (`src/asset-facts.ts`, `desktop/project.ts`).** `AssetFact.extra` already persists in `assets-meta.json`. `ProjectPhoto` (and `unavailablePhotos`) carry `extra`, and a new optional `photoExtra?: Record<string, Record<string, unknown>>` on `ProjectSummary` (`src/desktop.ts`) hands the renderer the declared keys of it, for the photos that have a mark. The provider's own keys stay in the main process. `renderData` never includes `extra`, so templates never see it.
- **Sync (`desktop/sync-engine.ts`, `src/sync-snapshot.ts`).** Facts sync between Macs (ADR 0010/0011), so a second Mac without Lightroom Classic or Photos sees stars, flags, colours and hearts. As sync works today it would see them only as they were at the photo's last visual edit: a photo without a file pushes its fact only when its content key moved since the last sync (`changedOriginals`), and a mark moves no content key. So the rule gains one case, for the declared properties alone:
  - On a push, a photo whose provider answered on this Mac in this sync run and whose content key is unchanged goes up as the snapshot's fact with this Mac's values of the declared properties. Nothing else of the fact is taken from here, so the reason for the existing rule (another Mac may show another version of the photo for good) still holds for digest, size and revisions.
  - Declared properties that differ from the last synced snapshot count as facts ahead (`factsAhead`), so a change of marks alone is pushed with the next sync and does not wait for an edit of the book. As with every fact, it never makes a book diverge.
  - **What this Mac shows of the marks comes from the observation, not from the fact.** `refreshFacts()` observes the photos without a file at the start of every sync but keeps only their content key; what they report besides is dropped, and the fact in `assets-meta.json` is the one from the book's last load or watch report (or another Mac's, after a pull). So `refreshFacts()` reads the declared properties from `reported.facts.extra` of every photo its provider reports as available, whether or not the stored preview is of that content, and keeps them beside `context.here`. A sync started right after starring a photo, before the book reloaded, then carries the new star. It records nothing in the fact: the push takes the values from the observation, and the session records them with its next look.
  - **What the marks are compared with is in the sync record.** `factsAhead()` runs before any snapshot is loaded and sees only `SyncedCommit`. It gets `localProps?: Record<string, string>`, a digest of the declared properties this Mac's provider showed per photo, kept exactly as `localKeys` is: written by a push, by a pull (`stagePull`'s marker, for what this Mac's provider shows then, not for what was pulled) and where a Mac sees a photo for the first time. A photo's marks changed here when their digest differs from `localProps`. So a Mac that pulled another Mac's marks while its own provider shows others (an older copy of the catalog, say) does not push its own back: they are what it showed at the pull. A record without an entry for the photo (a book synced before this build) counts as changed only where the photo has a mark here, so marks go up once after the update.
  - **The digests are kept beside the sync record, not in it.** `syncedSchema` and the pull marker's schema (`desktop/sync-pull.ts`) are strict, and `loadProject` reads the sync record when a book opens: a build before this one would refuse to open a book whose `sync.json` has a key it does not know. So `localProps` is part of `SyncedCommit` and the marker in memory only, and is stored in `sync-marks.json` beside `sync.json`, with the SHA-256 of the `sync.json` it belongs to. `readSyncState` merges it in only while that hash matches. After an older build rewrote `sync.json`, or a crash between the two writes, it is ignored and the record reads as one from before marks synced: photos with marks are pushed once more, and nothing else changes.
  - A Mac that can read the provider always shows what it observes itself. Marks have no order between Macs: the Mac that observed and pushed last wins, which is right for a value only its source library can change.
- **Live updates without invalidating previews, cached originals or render inputs (`desktop/provided-photos.ts`).**
  - `visibleChange()` currently ignores `extra`. Extend it to compare the values `read()` gives for the specs of the photo's provider, so changing a star, flag, colour or favourite reloads the book summary at once without a new preview (`contentRevision` is unchanged). Keys of `extra` no spec declares never count.
  - **A mark is no change of the photo's revision.** Today `revision` keys full-resolution files in the source cache (`desktop/source-provider.ts`). For Apple Photos, `favorite` must **not** be hashed into `revision` (or `contentRevision`), otherwise tapping Favourite in Photos would discard a cached full-resolution iCloud download. `facts.provide()` already records a fact whose `extra` differs at an unchanged revision, so nothing new has to be recorded. What is missing is the reload: `shownDifferently()` asks for one only where `change` is `metadata`, that is, where the revision moved. It drops that condition and reloads wherever `visibleChange()` holds against the fact before.
  - `change` itself stays as it is (`unchanged` at an unchanged revision). It feeds `revised`, which tells the session that render inputs changed (`inputs.providedChanged()`); a heart changes no render input and must not say so.
- **Apple Photos (`desktop/native/photos.mm`, `desktop/providers/photos.ts`).**
  - Read `asset.isFavorite` in `Facts()` (a PhotoKit property far older than the provider's own minimum of macOS 15.2, so it needs no check; it does not require macOS 27 `extendedMetadata`). Emit `favorite: true` when true, as a boolean: the addon's row converter sent every `NSNumber` as a number before.
  - `PHPhotoLibraryChangeObserver` already fires within ~1 s when Favourite is toggled ([`spikes/apple-photos/README.md`](../../spikes/apple-photos/README.md)).
- **Lightroom Classic (`resources/ImageFlow.lrplugin/Catalog.lua`, `desktop/lightroom/protocol.ts`, `desktop/providers/lightroom.ts`).**
  - Add `rating`, `pickStatus` and `colorNameForLabel` to `optionalRaw`, and `label` to `optionalFormatted` in `Catalog.lua` (plugin version `1.3.0`; `rating` and `pickStatus` are already verified in the spike, and `optionalRaw`/`optionalFormatted` probe keys individually).
  - Map `rating` (`1..5`), `pickStatus` (`1 → 'pick'`, `-1 → 'reject'`), `colorNameForLabel` (`'red' | 'yellow' | 'green' | 'blue' | 'purple'`), and optional formatted `label` (when it differs from the colour name, e.g. custom label sets) into `extra`. Any other colour name (a label outside the active label set, say) is left out, as `none` is.
  - Older installed plugins (`< 1.3.0`) omit these fields; `photoRowSchema` accepts them as optional, so older plugins continue working without error and show no marks. Settings → Sources compares the installed plugin's version with the bundled one and offers **Update Plugin** there, and nowhere else: a user who does not open that pane sees no marks and is not told why. Phase 2 adds a line to the `Lightroom Classic` View submenu while the connected plugin is older than 1.3.0 (`Update the plugin to show stars, flags and labels…`, which opens that pane). A mark outside its range in a row is dropped by itself and does not fail the metadata job, unlike every other field of the protocol: marks only decorate a photo, and one odd value must not make a batch of 500 photos unreadable.
  - **Revision.** `lrRevision` is `uuid : lastEditTime : editCount : cropped size`, and ADR 0011 (section 3, point 4) keys full-resolution renders on it and accepts a wasted render after a rating change as the price of never printing a stale image. That stays: a star, flag or colour change in Lightroom moves the revision where Lightroom bumps `lastEditTime`, reaches ImageFlow through the existing 1.5 s poll, and costs a placed photo one full render at the next export. This is unlike Apple Photos, where a favourite costs nothing, and it is accepted. The spike saw metadata-only edits move both `lastEditTime` and `editCount` but did not record which ones, so the first step of the plan checks rating, flag and colour label each. Only for one that does not move `lastEditTime` does `Bridge.lua`'s watch loop compare its value besides the revision, so the change is still posted to `/lightroom/changes`; it then arrives with an unchanged revision and is shown by the same path as a favourite.
- **Copy into Book.** When a Lightroom or Photos photo is copied into `package`, its provider becomes `package` and its provider-specific `extra` properties are not carried forward (they would be frozen and misleading once detached from the source library).

### 3. Per-provider View menu

- **State (`src/photo-view.ts`).** Add `sourceProps?: Record<string, boolean>` to `PhotoView` (persisted per book in `localStorage` under `imageflow.photo-view.v1`). Unset keys fall back to `spec.defaultVisible`, so existing saved preferences migrate cleanly and new properties adopt their defaults automatically.
- **Inline `PhotoViewMenu` (`src/PhotoViewMenu.tsx`).** Using `ActionMenu`'s existing `<Submenu>`, append one submenu per provider that has declared properties **and** at least one photo in the current book:
  - `Lightroom Classic` → `Show Stars`, `Show Flags`, `Show Color Labels`
  - `Apple Photos` → `Show Favorites`
- **Native macOS `View` menu (`desktop/main.ts`, `src/commands.ts`).** Register the built-in provider submenus and checkbox commands statically under **View** (below `Show Source Indicators`), and set each submenu's `visible` in `updateMenus()` from a new `photoProviders?: string[]` field on `BookMenuState`. Books without Lightroom or Photos photos never see irrelevant submenus, and the app menu does not have to be rebuilt on every focus switch.

### 4. Thumbnail display, Manage Assets rows and Quick Look

A filmstrip thumbnail (`.source-photo` in `src/styles.css`) is `114px` tall and often only `~76px` wide for portrait photos, with all four corners already occupied (`SourceBadge` top-left, placement `.badge` top-right, `.source-storage` status pill bottom-left, `.photo-capture-time` bottom-right).

- **Unified bottom overlay row:** Replace the two independent bottom corner elements on `.source-photo` with a single bottom flex row (`left: 3px; right: 3px; bottom: 3px; justify-content: space-between; align-items: flex-end; gap: 3px`) so marks and capture time never collide. When a status pill (`Loading`, `Out of date`, `Offline`, `Linked`) is shown, it sits above the mark pill or takes precedence on very narrow tiles.
- **Mark visuals:**
  - **Stars:** Compact dark pill showing only filled stars (`★` to `★★★★★`), never empty star slots.
  - **Heart:** Compact pill with a filled heart glyph (`♥`).
  - **Flags:** Pick shows a subtle white flag badge (`⚑`); **Reject dims the thumbnail** (reduced opacity and slight desaturation, matching Lightroom) and shows a dark `✕` flag pill so rejected photos stand out immediately before being dragged onto a spread.
  - **Colour label:** A crisp 3 px bottom accent stripe (or small colour dot inside the mark pill) using Lightroom's five label colours — never tinting the image itself so colour judgement stays accurate.
- **Manage Assets (`src/SourceManager.tsx`) & Quick Look (`src/Sources.tsx`).** Render a photo's marks inline in `.asset-status` on photo rows and in the Quick Look footer details. Both show every mark that is set, as the Inspector does: the `PhotoView` toggles decide what the thumbnails show, not what a closer look at one photo shows.

### 5. Filtering (outside the View menu)

Filtering moves out of `View ▾` (including the existing `All assets / Unused only` toggle in `src/Sources.tsx`) into a dedicated **`Filter ▾`** control:

- **Toolbar at rest:** `[Photos 42 | Texts 3]   …   [Filter ▾] [View ▾] [Import…]`.
- **Active filters:** Removable chips sit inline in `.sources-bar`'s spacer (`[Unused ×] [Lr ★★★+ ×] [Lr Not Rejected ×] [Photos ♥ ×]`), the `Filter` button highlights subtly, and the active tab shows filtered count (`Photos 14/42`). Clicking `×` removes one filter immediately. A property chip always starts with its provider's `SourceBadge` icon, and its tooltip and accessible name spell the scope out (`Lightroom Classic photos: 3 stars or more`).
- **Compact Filter popover:** Clicking `Filter ▾` opens an anchored upward popover (styled like `.pc-list-popover` in `src/styles.css`, closing on outside click or Escape) so users can combine multiple filters in one open while watching the strip live-filter:
  - **Placement:** Segmented control `All | Unused | Used` (Photos and Texts tabs).
  - **Source:** Multi-select toggle pills using `SourceBadge` icons (`In Book`, `Linked`, `Lightroom Classic`, `Apple Photos`) — shown **only when the active tab has 2 or more distinct sources**.
  - **Provider property sections** *(Photos tab only, for providers present in the book and not excluded by the active Source pills)*. Each section is headed by the provider's `SourceBadge` icon and `<Provider> photos` (`Lightroom Classic photos`, `Apple Photos photos`), so its scope is read before its controls:
    - *Apple Photos photos:* `Favorites only` toggle.
    - *Lightroom Classic photos:* Clickable 5-star row (`≥ 1★`…`5★`, clicking the active star clears it), one flag choice (`Any | Picked | Not Rejected | Rejected`), and 5 multi-select colour circles (`red`, `yellow`, `green`, `blue`, `purple`).
    - In a book that mixes sources, a section with an active filter shows one line under its heading: `Photos from other sources stay visible.`
  - **Footer:** `Clear Filters` button (enabled when any filter is active).
- **Semantics: a provider's filters apply to that provider's photos only.** A photo is shown when it passes all three, in this order:
  1. **Placement** (`All | Unused | Used`), which applies to every photo.
  2. **Source**, which applies to every photo: with any pill selected, only photos of the selected sources.
  3. **The property filters of its own provider**, all of them together (`≥ 3★` and `Not Rejected` and a colour). A provider's filters are never asked of another source's photo: with `≥ 4★` set, a Lightroom Classic photo needs four stars, and every Apple Photos, `In Book` and `Linked` photo is shown as before.
  - So `≥ 4★` with `Favorites only` shows the four-star Lightroom photos together with the Apple Photos favourites, and everything from the other sources. Nothing a user can set makes two providers' filters exclude each other.
  - To see only the four-star Lightroom photos, select the `Lightroom Classic` Source pill as well. There is no filter that does both: narrowing to one source is always the Source pill, and it is said so in the section's line above.
  - The flag choice is one value, not three toggles: `Picked` and `Rejected` exclude each other, and `Picked` already leaves the rejected out.
  - Deselecting a provider's Source pill hides its section and its chips, and its property filters rest while none of its photos are shown. They are kept, and apply again when the source is selected again or the Source filter is cleared. `Clear Filters` clears them too.
  - A provider whose photos have all left the book loses its section, and its filters are dropped.
- **Quick Look alignment:** Quick Look in `src/Sources.tsx` steps through the currently filtered photo list (`items`) rather than the unfiltered `sourceList`, so filtering to `4★+` lets you flip through only those candidates with Space and arrow keys.
- **Manage Assets (`src/SourceManager.tsx`):** It has a filter of its own today, an `ActionMenu` with chips (`Kind`, `Used / Unused`, `Linked / In Book`, `Needs attention`). It moves to the same popover and chips as the Sources strip, so there is one filter to learn: `Used / Unused` becomes Placement, `Linked / In Book` becomes the Source pills of the sources present in the book (`In Book`, `Linked Files`, `Lightroom Classic`, `Apple Photos`), and `Kind` and `Needs attention` are two sections only Manage Assets shows. The provider property sections and their semantics are the same (e.g. to select all 5★ Lightroom photos for `Copy into Book…`). Its filter state is its own, not the strip's.
- **Lifetime:** Filters are ephemeral window state (reset when closing/reopening a book), unlike `PhotoView` preferences which persist per book.

### 6. Photo Inspector (`src/SourceInspector.tsx`)

When a selected photo has any set provider properties, render them as read-only `<dt>/<dd>` rows inside `<dl className="si-facts">` (below Captured / Size / Prints up to):

- `Rating`: `★★★★☆` (with accessible text `4 of 5 stars`)
- `Flag`: `Picked` or `Rejected`
- `Color label`: colour dot + colour name (plus custom `colorLabel` in parentheses when it differs)
- `Favorite`: `Yes` (with `♥`)

Unset properties are omitted so the Inspector stays quiet for unrated/unmarked photos.

## Alternatives considered

- **Single host-normalized toggle (`View → Show Ratings & Favorites`).** Keeps the View menu flat, but cannot toggle Lightroom stars, flags and colour labels independently once a provider exposes multiple marks. Per-provider submenus hidden when unused keep the menu clean for single-source books while scaling cleanly.
- **Arbitrary provider React components and menu callbacks.** Would duplicate thumbnail corner layout, dark/light styling, Manage Assets rows and Quick Look formatting across providers. Declarative descriptors with host-rendered primitives keep every surface visually consistent.
- **Native `ActionMenu` for filtering.** Matches `View ▾`, but closes after every single click and cannot render interactive star rows or colour swatches. A compact upward popover matches existing editor popovers and makes combining filters effortless.
- **Including `favorite` in Apple Photos' `revision`.** Simpler change propagation, but toggling a heart would invalidate cached full-resolution iCloud originals and trigger unnecessary re-downloads at export.
- **A property filter that hides the photos of other sources** (`≥ 4★` shows four-star Lightroom photos and nothing else). It reads naturally in a book from one source, but in a mixed book a rating filter would silently act as a source filter too, and two providers' filters together (`≥ 4★` with `Favorites only`) would show nothing. Keeping each provider's filters to its own photos leaves one control, the Source pills, for which sources are shown.
- **Keeping the marks when a photo is copied into the book.** These are the photos a user makes portable, and they lose their stars. But a copy is cut off from its source, so the marks could never change again and would look current. Reading `xmp:Rating` from the copied file later (see open points) gives such photos marks of their own.
- **Leaving sync as it is.** Marks would reach another Mac only with the photo's next visual edit, so a Mac without the source library would show stars from weeks ago with nothing saying so. Pushing whole facts whenever they differ would undo the rule that keeps one Mac's view of a photo from overwriting another's.

## Implementation plan

### Phase 1: Contract, facts plumbing and provider readers
1. **Check Lightroom first, in a live catalog** (with the spike's watch in `spikes/lightroom-classic`): whether a change of `rating`, `pickStatus` and `colorNameForLabel` each moves `lastEditTime` or `editCount`, which values `colorNameForLabel` takes for a label outside the active label set, and that `colorNameForLabel` and formatted `label` are accepted keys. Record the result in the spike's README and here. It decides whether step 6 touches `Bridge.lua`'s watch loop at all.
2. Add `src/source-properties.ts` with `SourcePropertySpec`, `SourceProviderProperties`, the badge types, the Lightroom Classic and Apple Photos declarations, and pure helpers (`readPhotoMarks`, `photoFilterPredicate`, `activeProvidersOf`). `photoFilterPredicate` takes the photo's provider and asks only that provider's filters of it. Update the comments on `extra` in `desktop/source-provider.ts` and `src/asset-facts.ts`.
3. Plumb `extra` from `AssetFact` through `ProjectPhoto` / `unavailablePhotos` into `ProjectSummary.photoExtra` (`desktop/project.ts`, `src/desktop.ts`). Keep `renderData` untouched.
4. In `desktop/provided-photos.ts`, extend `visibleChange()` to the declared properties and drop the `change === 'metadata'` condition in `shownDifferently()`, so a mark changed at an unchanged revision reloads the book. `change`, `revised` and the revisions stay as they are: no preview, no materialization and no render input is touched.
5. **Apple Photos:** Read `asset.isFavorite` in `desktop/native/photos.mm` (`Facts`), add `favorite?: boolean` to `PhotosFacts` (`desktop/photos-library.ts`), and map it into `extra.favorite` in `photosFacts()` (`desktop/providers/photos.ts`) without changing `photosRevisions()`.
6. **Lightroom Classic:** Add `rating`, `pickStatus`, `colorNameForLabel`, and `label` to `resources/ImageFlow.lrplugin/Catalog.lua` (bump plugin version to `1.3.0`), extend `photoRowSchema` in `desktop/lightroom/protocol.ts`, and map them into `extra` in `lightroomFacts()` (`desktop/providers/lightroom.ts`). `Catalog.revision` is not changed. Only if step 1 found a property that does not move `lastEditTime`: compare its value in the watch loop besides the revision.
7. **Sync:**
   - In `refreshFacts()` (`desktop/sync-engine.ts`), keep the declared properties of each photo its provider reports as available, read from `reported.facts.extra`.
   - Add `localProps` to `SyncedCommit` (`src/sync-snapshot.ts`) and to the pull marker, stored in `sync-marks.json` beside `sync.json` (`desktop/sync-pull.ts`), and write it wherever `localKeys` is written: after a push, in `stagePull`'s marker and its adoption, and where a photo is seen for the first time.
   - In `push`, give a photo whose content key is unchanged the snapshot's fact with the observed declared properties, and count a difference from `localProps` in `factsAhead`.
   - In an adopt, record the marks only where this Mac shows them as the snapshot has them.
8. Unit tests for property readers (values outside the vocabulary included), filter predicates (a provider's filter leaves other sources' photos alone; two providers' filters together; the four flag choices; a deselected source), `visibleChange` on `extra`, a favourite changed at an unchanged `revision` (reloaded, not in `revised`), the sync rule (marks pushed without a content change; digest, size and revisions not; a mark changed just before a sync, without a reload; no push back after a pull on a Mac whose provider shows other marks; one push after the update), and Lightroom protocol/provider parsing (including older plugins omitting the new keys).

### Phase 2: View menus, thumbnails and Inspector
1. Extend `PhotoView` (`src/photo-view.ts`) with `sourceProps?: Record<string, boolean>`, validation, and toggle commands.
2. Add per-provider submenus to `PhotoViewMenu` (`src/PhotoViewMenu.tsx`) and native **View** menu (`src/commands.ts`, `desktop/main.ts`), gated on the providers present in the open book (`BookMenuState.photoProviders`). While the connected Lightroom plugin is older than 1.3.0, the `Lightroom Classic` submenu has a line that opens Settings → Sources to update it.
3. Unify `.source-photo`'s bottom overlay row in `src/Sources.tsx` and `src/styles.css`, render active marks (stars, heart, Pick/Reject flag + Reject dimming, colour stripe/dot), and show marks in `SourceManager.tsx` rows and `QuickLook` footer.
4. Render read-only property rows in `SourceInspector.tsx` (`si-facts`).

### Phase 3: Filter popover, Source filter and Manage Assets
1. Extract a reusable `PhotoFilterPopover` + inline chip bar (`src/PhotoFilter.tsx`), move `Unused only` out of `PhotoViewMenu`, and wire `Placement`, `Source` (when 2+ sources exist), and provider property filters into `src/Sources.tsx`. Sections are headed `<Provider> photos`, chips carry the provider's icon, and a section with an active filter in a mixed book says that other sources stay visible.
2. Lift the strip's filter state from `SourceStrip` to `src/App.tsx`, update `SourceTabs` to show filtered counts (`14/42`) when filters are active, and have `QuickLook` navigate the filtered list.
3. Replace the `ActionMenu` filter and its tokens in `SourceManager.tsx` (`Manage Assets`) with the same popover and chips, with its own state and its two extra sections (`Kind`, `Needs attention`), and per-source pills in place of `Linked / In Book`.
4. Add unit and UI smoke tests covering View toggles, thumbnail overlays, Reject dimming, a provider's filter in a mixed book, Source filtering, a filter resting while its source is deselected, Quick Look navigation on filtered subsets, and Inspector rows. The UI tests go to the nightly suite, not the PR checks.
5. Describe marks, the View submenus and the Filter in the guide (`docs/guide`), with the rule that a provider's filters apply to its own photos.

## Consequences and open points

- **No book format bump needed:** `AssetFact.extra` is already part of `assets-meta.json` v1 and preserved by older builds (ADR 0010/0011).
- **The meaning of `extra` and one sync rule change:** the host now reads the declared keys of `extra` (section 1), and marks are pushed without a content change (section 2). Both amend ADR 0011 and ADR 0010/0012 in a small, stated way.
- **A mark changed in Lightroom still costs a placed photo one full render at export** (ADR 0011), unlike a favourite in Apple Photos. Phase 1, step 1 settles what the plugin has to watch; it does not reopen that.
- **Open — Pick vs. Reject toggle granularity:** Decide during UI polish whether one `Show Flags` toggle (on by default, showing both Pick `⚑` and Reject dimmed/`✕`) feels right, or whether Pick flags are noisy enough to separate `Show Picks` (off) and `Show Rejects` (on).
- **Open — Future extensions:** Because raw typed values (`rating`, `favorite`, `flag`, `color`) live in `extra`, adding **Sort by Rating** or reading XMP `xmp:Rating` for `package`/`linked` files later requires no schema change.
