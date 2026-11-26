# 0014: Source properties, overlays and filtering

Status: proposed, 2026-11-26. Builds on [0011](0011-lightroom-classic.md) (the source provider contract and `AssetFact.extra`) and [0013](0013-apple-photos.md) (Apple Photos provider).

## Problem

Laying out a photo book is largely selection and sequencing: photographers import dozens or hundreds of candidate photos from Lightroom Classic or Apple Photos and rely on the curation work they already did there — star ratings, pick/reject flags, colour labels, favourites — to separate hero spreads from supporting shots and rejects.

Today those marks are invisible inside ImageFlow. Users have to switch back to Lightroom or Photos to remember which photos they starred, hearted or rejected, and cannot narrow the filmstrip or Manage Assets by those properties — or even isolate one source (such as "Lightroom Classic only") in a book that mixes photos from several sources.

## Decision

Let source providers **declaratively describe read-only curation properties** stored in `AssetFact.extra`, while the **host** renders them consistently across four places:

1. **Per-provider View submenus** (native **View** menu and inline **View ▾** popup) to toggle thumbnail overlays.
2. **Thumbnail overlays** in the Sources strip (plus Manage Assets rows and Quick Look).
3. **A dedicated Filter popover** outside the View menu, combining placement, source and per-provider property filters with removable inline chips.
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

export type SourceFilterKind =
  | { type: 'boolean'; label: string; chipLabel: string }
  | { type: 'min-rating'; label: string }       // 1..5 stars (≥ N★)
  | { type: 'flag'; label: string }             // Picked / Hide Rejected / Rejected
  | { type: 'color-set'; label: string; colors: readonly SourceColor[] };

export type SourcePropertySpec = {
  /** Stable key used in PhotoView persistence and commands, e.g. 'lightroom:rating'. */
  id: string;
  provider: string;                             // 'lightroom' | 'photos'
  providerLabel: string;                        // 'Lightroom Classic' | 'Apple Photos'
  /** Label inside View → <Provider> → … */
  viewLabel: string;
  /** Default overlay visibility when the user has not toggled this property. */
  defaultVisible: boolean;
  /** Label in the photo Inspector's facts list. */
  inspectorLabel: string;
  /** Extracts the mark from `AssetFact.extra`; undefined when unset (renders nothing). */
  read(extra: Record<string, unknown> | undefined): SourceBadgeMark | undefined;
  /** Human-readable Inspector value when set (e.g. '★★★★☆', 'Green (Select)', 'Yes'). */
  formatInspector(mark: SourceBadgeMark): string;
  /** Optional filter facet contributed to the Filter popover for this provider. */
  filter?: SourceFilterKind;
};
```

Initial declarations:

| Provider | Property ID | `extra` key(s) | View menu item | Default overlay | Filter control |
| --- | --- | --- | --- | --- | --- |
| Apple Photos | `photos:favorite` | `favorite?: true` | `View → Apple Photos → Show Favorites` | **On** | `Favorites only` toggle |
| Lightroom Classic | `lightroom:rating` | `rating?: 1 \| 2 \| 3 \| 4 \| 5` | `View → Lightroom Classic → Show Stars` | **On** | Minimum rating (`★`–`★★★★★`, click active star to clear) |
| Lightroom Classic | `lightroom:flag` | `flag?: 'pick' \| 'reject'` | `View → Lightroom Classic → Show Flags` | **On** | `Picked only`, `Hide Rejected`, `Rejected only` |
| Lightroom Classic | `lightroom:color` | `color?: SourceColor`, `colorLabel?: string` | `View → Lightroom Classic → Show Color Labels` | **Off** | Multi-select colour swatches (`red`, `yellow`, `green`, `blue`, `purple`) |

Unset values (`favorite: false`, `rating: 0`, `pickStatus: 0`, `colorNameForLabel: 'none'`) are omitted from `extra` so unmarked photos stay clean in `assets-meta.json` and render no overlay.

### 2. Storage, sync, providers and live updates

- **Storage and sync (`src/asset-facts.ts`, `desktop/project.ts`).** `AssetFact.extra` already persists in `assets-meta.json` and syncs between Macs (ADR 0010/0011). A second Mac without Lightroom Classic or Photos still sees stars, flags, colours and hearts from the synced facts. `ProjectPhoto` (and `unavailablePhotos`) carry `extra` through to a new optional `photoExtra?: Record<string, Record<string, unknown>>` on `ProjectSummary` (`src/desktop.ts`). `renderData` never includes `extra`, so templates never see it.
- **Live updates without invalidating previews or cached originals (`desktop/provided-photos.ts`).**
  - `visibleChange()` currently ignores `extra`. Extend it to compare the normalized values of declared `SourcePropertySpec` entries for the photo's provider so changing a star, flag, colour or favourite reloads the book summary immediately while skipping preview generation (`contentRevision` is unchanged).
  - **Do not invalidate full-resolution materializations for curation-only changes.** Today `revision` keys full-resolution files in the source cache (`desktop/source-provider.ts`). For Apple Photos, `favorite` must **not** be hashed into `revision` (or `contentRevision`), otherwise tapping Favourite in Photos would discard a cached full-resolution iCloud download. Instead, `recordReported()` and `providedChanges()` treat a `visibleChange()` in `extra` as a metadata update (`change: 'metadata'`) that writes the updated fact and reloads the renderer even when `revision` is unchanged.
- **Apple Photos (`desktop/native/photos.mm`, `desktop/providers/photos.ts`).**
  - Read `asset.isFavorite` in `Facts()` (standard PhotoKit property on macOS 15.2+; does not require macOS 27 `extendedMetadata`). Emit `favorite: true` when true.
  - `PHPhotoLibraryChangeObserver` already fires within ~1 s when Favourite is toggled ([`spikes/apple-photos/README.md`](../../spikes/apple-photos/README.md)).
- **Lightroom Classic (`resources/ImageFlow.lrplugin/Catalog.lua`, `desktop/lightroom/protocol.ts`, `desktop/providers/lightroom.ts`).**
  - Add `rating`, `pickStatus` and `colorNameForLabel` to `optionalRaw`, and `label` to `optionalFormatted` in `Catalog.lua` (plugin version `1.3.0`; `rating` and `pickStatus` are already verified in the spike, and `optionalRaw`/`optionalFormatted` probe keys individually).
  - Map `rating` (`1..5`), `pickStatus` (`1 → 'pick'`, `-1 → 'reject'`), `colorNameForLabel` (`'red' | 'yellow' | 'green' | 'blue' | 'purple'`), and optional formatted `label` (when it differs from the colour name, e.g. custom label sets) into `extra`.
  - Older installed plugins (`< 1.3.0`) omit these fields; `photoRowSchema` accepts them as optional, so older plugins continue working without error.
  - Include `rating`, `pickStatus` and `colorNameForLabel` in the watch poll's comparison token in `Catalog.lua` (not in the materialization `revision` if separable, or verified against `lastEditTime`) so a star/flag/colour change in Lightroom triggers `/lightroom/changes` within the existing 1.5 s poll even if Lightroom does not bump `lastEditTime` for one of them.
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
- **Manage Assets (`src/SourceManager.tsx`) & Quick Look (`src/Sources.tsx`).** Render active marks inline in `.asset-status` on photo rows (respecting the same `PhotoView` toggles or always visible in Manage Assets) and in the Quick Look footer details.

### 5. Filtering (outside the View menu)

Filtering moves out of `View ▾` (including the existing `All assets / Unused only` toggle in `src/Sources.tsx`) into a dedicated **`Filter ▾`** control:

- **Toolbar at rest:** `[Photos 42 | Texts 3]   …   [Filter ▾] [View ▾] [Import…]`.
- **Active filters:** Removable chips sit inline in `.sources-bar`'s spacer (`[Unused ×] [Lr Lightroom ×] [★★★+ ×] [No Rejects ×]`), the `Filter` button highlights subtly, and the active tab shows filtered count (`Photos 14/42`). Clicking `×` removes one filter immediately.
- **Compact Filter popover:** Clicking `Filter ▾` opens an anchored upward popover (styled like `.pc-list-popover` in `src/styles.css`, closing on outside click or Escape) so users can combine multiple filters in one open while watching the strip live-filter:
  - **Placement:** Segmented control `All | Unused | Used` (Photos and Texts tabs).
  - **Source:** Multi-select toggle pills using `SourceBadge` icons (`In Book`, `Linked`, `Lightroom Classic`, `Apple Photos`) — shown **only when the active tab has 2 or more distinct sources**.
  - **Provider property sections** *(Photos tab only, for providers present in the book and not excluded by the active Source pills)*:
    - *Apple Photos:* `Favorites only` toggle.
    - *Lightroom Classic:* Clickable 5-star row (`≥ 1★`…`5★`, clicking the active star clears it), flag toggles (`Picked only`, `Hide Rejected`, `Rejected only`), and 5 multi-select colour circles (`red`, `yellow`, `green`, `blue`, `purple`).
  - **Footer:** `Clear Filters` button (enabled when any filter is active).
- **Mixed-source semantics:**
  - Positive property filters (`Favorites only`, `≥ N★`, `Picked only`, `Rejected only`, `Color`) require the photo to match that property (hiding photos from other sources).
  - Negative filters (`Hide Rejected`) exclude only photos explicitly marked Rejected; photos from Apple Photos, `package`, or `linked` remain visible.
- **Quick Look alignment:** Quick Look in `src/Sources.tsx` steps through the currently filtered photo list (`items`) rather than the unfiltered `sourceList`, so filtering to `4★+` lets you flip through only those candidates with Space and arrow keys.
- **Manage Assets (`src/SourceManager.tsx`):** Expand the current `Linked / In Book` filter into the actual sources present in the book (`In Book`, `Linked Files`, `Lightroom Classic`, `Apple Photos`) and support the same provider property filters (e.g. to select all Lightroom photos or all 5★ photos for `Copy into Book…`).
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

## Implementation plan

### Phase 1: Contract, facts plumbing and provider readers
1. Add `src/source-properties.ts` with `SourcePropertySpec`, badge/filter types, initial Lightroom Classic and Apple Photos specs, and pure helpers (`readPhotoMarks`, `photoFilterPredicate`, `activeProvidersOf`).
2. Plumb `extra` from `AssetFact` through `ProjectPhoto` / `unavailablePhotos` into `ProjectSummary.photoExtra` (`desktop/project.ts`, `src/desktop.ts`). Keep `renderData` untouched.
3. Update `visibleChange()`, `recordReported()` and `providedChanges()` in `desktop/provided-photos.ts` so changes to declared `extra` properties trigger a metadata update and reload without refetching previews or invalidating materialization revisions.
4. **Apple Photos:** Read `asset.isFavorite` in `desktop/native/photos.mm` (`Facts`), add `favorite?: boolean` to `PhotosFacts` (`desktop/photos-library.ts`), and map it into `extra.favorite` in `photosFacts()` (`desktop/providers/photos.ts`) without changing `photosRevisions()`.
5. **Lightroom Classic:** Add `rating`, `pickStatus`, `colorNameForLabel`, and `label` to `resources/ImageFlow.lrplugin/Catalog.lua` (bump plugin version to `1.3.0`), extend `photoRowSchema` in `desktop/lightroom/protocol.ts`, map them into `extra` in `lightroomFacts()` (`desktop/providers/lightroom.ts`), and include them in the plugin's watch comparison so live edits propagate within 1.5 s.
6. Unit tests for property readers, filter predicates (including mixed-source positive vs. negative rules), `visibleChange` on `extra`, Photos provider `favorite` preservation across unchanged `revision`, and Lightroom protocol/provider parsing (including older plugins omitting the new keys).

### Phase 2: View menus, thumbnails and Inspector
1. Extend `PhotoView` (`src/photo-view.ts`) with `sourceProps?: Record<string, boolean>`, validation, and toggle commands.
2. Add per-provider submenus to `PhotoViewMenu` (`src/PhotoViewMenu.tsx`) and native **View** menu (`src/commands.ts`, `desktop/main.ts`), gated on the providers present in the open book (`BookMenuState.photoProviders`).
3. Unify `.source-photo`'s bottom overlay row in `src/Sources.tsx` and `src/styles.css`, render active marks (stars, heart, Pick/Reject flag + Reject dimming, colour stripe/dot), and show marks in `SourceManager.tsx` rows and `QuickLook` footer.
4. Render read-only property rows in `SourceInspector.tsx` (`si-facts`).

### Phase 3: Filter popover, Source filter and Manage Assets
1. Extract a reusable `PhotoFilterPopover` + inline chip bar (`src/PhotoFilter.tsx`), move `Unused only` out of `PhotoViewMenu`, and wire `Placement`, `Source` (when 2+ sources exist), and provider property filters into `src/Sources.tsx`.
2. Update `SourceTabs` to show filtered counts (`14/42`) when filters are active, and update `QuickLook` in `src/Sources.tsx` / `src/App.tsx` to navigate the filtered list.
3. Upgrade `SourceManager.tsx` (`Manage Assets`) to replace the coarse `Linked` filter with per-source filters (`In Book`, `Linked Files`, `Lightroom Classic`, `Apple Photos`) and integrate provider property filters into its filter menu/chips.
4. Add unit and UI smoke tests covering View toggles, thumbnail overlays, Reject dimming, combined filters, Source filtering, Quick Look navigation on filtered subsets, and Inspector rows.

## Consequences and open points

- **No book format bump needed:** `AssetFact.extra` is already part of `assets-meta.json` v1 and preserved by older builds (ADR 0010/0011).
- **Open — Lightroom plugin verification:** Confirm in a live Lightroom Classic catalog whether changing `rating`, `pickStatus` or `colorNameForLabel` bumps `lastEditTime`/`editCount`, or whether `Bridge.lua`'s watch loop should track a separate metadata token so live updates don't invalidate materialized renders either.
- **Open — Pick vs. Reject toggle granularity:** Decide during UI polish whether one `Show Flags` toggle (on by default, showing both Pick `⚑` and Reject dimmed/`✕`) feels right, or whether Pick flags are noisy enough to separate `Show Picks` (off) and `Show Rejects` (on).
- **Open — Future extensions:** Because raw typed values (`rating`, `favorite`, `flag`, `color`) live in `extra`, adding **Sort by Rating** or reading XMP `xmp:Rating` for `package`/`linked` files later requires no schema change.
