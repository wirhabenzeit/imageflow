# Editing a book

## Spreads

Add, duplicate, move or delete spreads from the left sidebar or the **Book** menu. Drag a thumbnail to an insertion line to reorder, or use ⌥⌘↑ / ⌥⌘↓. Single-page book ends stay in place. Moves can be undone.

**New Spread** adds an empty spread after the selected one, in the same layout: the same spread layout, or for a spread shown as two pages, the same two page layouts. A single opening or closing page is not repeated. Where the selected layout does not fit, the new spread takes the template's first layout that does.

Select a spread to choose its layout and settings in the Inspector. **On this spread** lists its content. **Set aside** holds content from previous layouts, ready to restore when you switch back.

## Independent pages

The Photobook starter uses spread templates only for a photo across the fold (Panorama and Chapter opener) or a full-spread Map. Contents, stories, notes, quotes, grids, inset maps and picture lists are reusable page templates that you can pair freely.

The layout picker shows all designs together: double-page designs span two slots, and single-page designs take one, with four page slots across. The patterned blank tile represents an intentionally empty page. Every starter page design works on either side. Picture list is one reusable design with optional closing text; additional occurrences continue the list.

Click the left or right half of a sheet to select that side. Choose a single-page design in the layout picker to split a spread into independent pages. The other side keeps its remembered page or starts blank. The Inspector’s **Templates** section edits the selected page; **On this page** lists its content. Left/right arrows move between pages. The filmstrip, duplicate, delete and reorder continue to act on whole sheets.

- Choose another page layout to change only the selected page, or drag a layout onto either half to apply it there.
- Choose **Blank page** to leave a full-sheet side blank while keeping its content stored.
- Choose a double-page design to merge the pages. When both pages have content for the same box, the selected side wins.
- Use **Book → Swap Pages** to exchange both complete page designs and their content. It is disabled when a design is restricted to its current side.
- **Set aside** and **Replaced** identify where content came from. **Place in…** moves it into a compatible shown box, including a box on the facing page; an occupied box swaps its content back. **Discard** removes the assignment. Sources remain available, and Undo restores the change.

Single opening and closing pages accept designs allowed on their side and remain single units. The blank-page choice is available for full-sheet positions.

### A quick beta test

Use a fresh copy of the Photobook starter. Pair a photo page with a story, quote or grid page, then try the same design on both sides. Edit the right page and confirm the left is unchanged. Crop a photo, switch layouts and return, merge and split, swap, place/discard set-aside content and Undo. Save, close and reopen the book, then export a PDF and check page order, text continuation, photo crops and folios in each offered format.

These flows can be tested in the editor now. Page-level MCP mutation commands are still pending; use the editor for individual page edits rather than passing undocumented page arguments to commands.

## Photos

- **Import:** use **Assets → Import…**, the Sources strip's **Import** menu, or drop JPEG, PNG, WebP, AVIF or HEIC files onto the strip or a photo box. HEIC photos, as iPhones take them, are linked or stored as they are, like any photo; macOS draws them, and an export prints them at full resolution. Photos in Apple Photos are better added from there (drag them in), which also brings along the edits made in Photos.
- **Place:** drag a photo from the strip onto a photo box. Drag an unselected placed photo onto another box to swap them.
- **Crop:** click a placed photo, then drag to reposition it. Pinch, Control-scroll or use the toolbar slider to zoom. Each gesture is one undoable edit.
- **Caption:** click a caption printed on the page to type it there (an empty one shows "Add caption" while **Show caption** is on), select a placed photo and choose **Caption…**, or right-click it and choose **Edit Caption…**. Typing on the page works in templates whose pages mark their captions, such as the starter. The caption belongs to the photo, wherever it is placed; whether a page prints it is a setting of the template.
- **Check resolution:** the crop toolbar compares print resolution with the template's minimum and target.
- **Replace or remove:** use **More photo actions** for **Replace photo…**, **Remove photo** and **Crop values…**. With a photo selected, Backspace or Delete removes it from the box too; the photo stays in the book, and Undo brings it back with its crop. Empty boxes offer **Choose photo…**.

Escape, **Done** or a click elsewhere deselects the photo. Select a photo in the Sources strip to edit its title, caption, credit and alt text in the Inspector. To get there from a placed photo, right-click it on the page, or its row under **On this page** (or **On this spread**) in the Inspector, and choose **Show in Assets**; **Quick Look** is in the same menu. Texts offer both too.

## Text

Drop a Markdown file onto a text box, or click the box to assign or import a source. Assign the same source to several boxes to continue its text through the book.

Drag a text box that holds a text onto another text box to swap the two texts, or onto an empty text box to move it there. Only the dragged box's assignment moves: other boxes the text continues through keep it. Undo reverts the swap in one step.

**New Text** in the Texts strip creates a source inside the book. A source's pencil button opens a Markdown editor with a live preview. Changes save after a short pause. Linked sources offer a choice to edit the original or copy it into the book first.

External changes reload automatically unless you have pending edits; then the editor asks you to resolve the conflict. Changes made to a text or template file outside ImageFlow, by you or an agent, are not steps of the book's Undo: Undo only goes back through the book's own edits. Keep a copy of the files before a larger outside pass.

## Settings and on-page editing

Book settings are in the left sidebar. Spread or page, box and element settings are in the Inspector. Click an item on the page, or select it under **On this spread** / **On this page**, to open its controls. Templates can provide a popover, an on-page editor (such as the Photobook map) or direct text editing.

Typed settings apply on Enter or when you leave the field; Escape discards pending text. Choices apply immediately. Changes can be undone.
