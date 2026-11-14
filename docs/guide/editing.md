# Editing a book

## Spreads

Add, duplicate, reorder or delete spreads in the left sidebar. Drag a thumbnail to the insertion line to move it, or use the move buttons or ⌥⌘↑ / ⌥⌘↓ on a focused thumbnail. Single-page book ends such as covers stay in place. Every move is one undoable step.

Select a spread to choose its layout and edit its settings in the Inspector. The Inspector lists what is **On this spread** first; **Set aside** keeps content from layouts the spread used before, so switching back restores it.

## Photos

- **Import** JPEG, PNG and WebP photos with **File → Import** or the Sources strip's **Import** menu, or drop them onto the photo strip or a photo box.
- **Place** a photo by dragging it from the strip onto a photo box. Dragging a placed photo onto another photo box, on any spread, swaps the two.
- **Crop** by clicking a placed photo: drag it to move it inside its frame, and pinch, Control-scroll or use the toolbar slider to zoom. Each gesture is one undoable step.
- The toolbar shows the photo's **print resolution** against the template's minimum and target, and the **More photo actions** menu holds **Replace photo…**, **Remove photo** and **Crop values…**.
- An empty photo box offers **Choose photo…**. Escape, **Done** or a click elsewhere deselects.

A photo's title, caption, credit and alt text are edited in its own Inspector.

## Text

Text comes from Markdown sources.

- Drop a Markdown file onto a text box, or click the box to assign a source or import one.
- Assign the same source to several boxes, and the text continues from one box to the next through the book.
- **New Text** in the Texts strip creates a Markdown source inside the book.
- A source's pencil button opens an editor with the Markdown and a live formatted preview side by side. Text saves itself after a short pause.
- For a linked source, the editor asks whether to edit the original file or copy it into the book first.

When the file changes on disk while nothing is pending, the editor reloads it; otherwise it shows the conflict for you to resolve.

## Settings and on-page editing

Templates offer settings for the whole book (in the left sidebar) and for each spread, box and element (in the Inspector). Clicking on the page selects what is drawn on top:

- a photo is selected for moving and zooming;
- an element with its own editor, such as the Photobook's map, opens that editor;
- text or an element the template marks as editable opens a small popover, or lets you type directly on the page.

Every setting is also in the Inspector. Typed values apply on Enter or when you click elsewhere, and Escape discards what you typed. Choices apply immediately, and every change can be undone.
