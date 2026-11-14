# Editing on the page

An element editor or a document editor can ask to be shown on the page instead of in the panel, with `presentation: 'inline'`:

```tsx
export default defineTemplate({
  contract: 1,
  // ...
  elements: { map: { label: 'Map', parameters: mapParameters,
    editor: { parameters: ['longitude', 'latitude', 'zoom'], component: MapEditor, presentation: 'inline' } } },
});
```

- **Where it is drawn:** the component runs in its own sandboxed frame, as in the panel, placed over what it was opened from: the element, or for a document editor the marked node that was clicked (the calendar's column of days). The frame has that rectangle's printed size in CSS pixels, so the template's CSS in millimetres and points applies as on the page, and ImageFlow scales it with the page. It follows the page as it scrolls, zooms, resizes and re-renders, and as the format or layout changes the rectangle. Nothing in it is remounted by saving, by the book redrawing or by moving the canvas: a map keeps its camera, a field its focus. While the editor shows, the page hides that occurrence's own artwork, so nothing is drawn twice; the rest of the page stays visible around it, and shows through wherever the editor draws nothing. Artwork drawn over the rectangle by other nodes (a title over a map) is covered by the frame; draw it in the editor too if it matters for the composition, as the starter's map does with its title.
- **What the component receives:** the same props as in the panel, plus `presentation` (`'inline'` or `'dialog'`), so one component can serve both, such as the calendar's day column on the page and its month grid in the panel. Fill the frame (`position: absolute; inset: 0`), draw what the page draws, and make it interactive. The frame's background is transparent and its content uses light artwork colours; the panel's `--if-editor-*` appearance variables do not apply to page artwork. `--if-inline-scale` on the frame's root is the page's current scale, for UI that should keep its screen size whatever the zoom, such as map buttons: `zoom: calc(1 / var(--if-inline-scale))`.
- **Appearing without a flicker:** the page keeps its artwork, and the editor stays out of view, until the editor has mounted, its fonts have loaded and it has painted; closing removes the editor only once the page shows its artwork again. An editor that still loads something to draw, such as a map's first tiles, passes it to `waitUntil(promise)` while mounting; the editor appears when it settles, after a few seconds at most. `waitUntil` does nothing in the panel.
- **The other parameters:** an element's parameters the editor does not own are generated controls in a toolbar under the canvas, like the photo toolbar, with *Done*. A problem (a rejected change, a conflict, a failure, read-only) shows above the toolbar; nothing on the page moves.
- **Gestures and keys:** pointer, wheel and pinch gestures and keys inside the frame belong to the editor: they never select, crop or move what is under it, and book shortcuts do not run. The page outside it scrolls as usual. The frame takes focus when it opens. Escape closes it, discarding only unfinished typing; ⌘↩ and *Done* finish the active field and close. Clicking elsewhere on the page finishes the active field first, then acts on that click. Changes already applied stay saved, and each is one Undo step, as in the panel.
- **Where it falls back to the panel:** an element whose template CSS rotates, skews or mirrors it (its on-page rectangle is only a bounding box), one too small to use on screen, or one not on the page opens in the panel, with the same component and `presentation: 'dialog'`. So does every editor of a template that does not ask for `'inline'`. The sidebar's list of a spread's elements opens the same editor as a click on the page.
- **Output stays pure:** the inline editor exists only in the editing view. Thumbnails, the Book check, clean MCP artwork and proof and print export never contain it or its toolbar, and always draw the saved values with `render`.

## Appearance in custom editors

Custom editor frames follow the app's appearance automatically, including changes while a dialog is open. The app's Settings offer Light, Dark, or System (the default, following macOS). No appearance attribute or opt-in is needed. Editors must support both light and dark appearances: inherit the host's text and background colors, and use its CSS variables for custom surfaces, controls and states:

```tsx
<div style={{
  color: 'var(--if-editor-text)',
  background: 'var(--if-editor-background)',
}}>…</div>
```

Available variables: `--if-editor-background`, `--if-editor-text`, `--if-editor-muted`, `--if-editor-control`, `--if-editor-border`, `--if-editor-selection`, `--if-editor-accent`, `--if-editor-focus`, `--if-editor-marked-background` and `--if-editor-marked-text`. They update live without recreating the editor or committing its draft. The calendar starter's day picker and the photobook's route editor demonstrate both surfaces and selected states. Theme variables are scoped to the editor host; use explicit authored colors for book artwork. Never apply editor appearance styles to `.if-sheet`, print output, or template artwork.
