# Click-to-edit

`ctx.edit(...paths)` marks the node that shows parameters, so clicking it in the editor opens a popover with a control for each parameter (text field, month or date picker, segmented choice, slider, colour). Spread the result onto the node:

```tsx
<h2 {...ctx.edit('heading')}>{ctx.params.heading}</h2>
<Element id="grid" {...ctx.edit('month')}>…</Element>
```

Paths name a spread parameter (`heading`), a document parameter (`document.paper`), an element parameter (`elements.grid.firstWeekday`), or a box parameter (`boxes.hero.showCaption`). With the `spread` builder, paths are type-checked. `<Element>` is an edit target for its own parameters without marking; marks on it add more. Outside the editor the marker stays as an invisible `data-edit` attribute, so checks can name the parameter a text block shows (for example in `text-overflows-box`); the Book check warns about paths the layout does not declare. Set `precision: 'month'` on a date parameter to edit it with a month picker; the value is the month's first day.

For the common case of one string parameter shown as text, `ctx.Text` reads the value and marks the node in one step:

```tsx
<ctx.Text parameter="heading" as="h2" presentation="inline" rect={ctx.geometry.page('right', 'safe')} />
<ctx.Text parameter="boxes.hero.credit" as="figcaption" presentation="inline" placeholder="Photo credit" />
```

Prefer `presentation="inline"` for a single user-written string printed on the page, such as a heading, label or caption: the user types it where it prints, in its own type ([inline-text](inline-text.md)). Leave it out (the panel) when the string is better edited beside other controls, or is not visible text. At a zoom where the text is small on screen, ImageFlow opens the panel instead and offers to zoom in so it can be edited on the page.

`parameter` takes the same paths as `ctx.edit`, limited to string parameters. `as` is one of `h1`–`h6`, `p` (default), `span`, `div`, `blockquote` or `figcaption`; `className`, `style`, `rect` and `issue()` markers work as on the platform components. When the value is empty, the editing canvas shows a dimmed placeholder in the template's own type (`placeholder`, else the parameter's `placeholder`, else its label) and marks the node `data-empty`; the exported book shows the empty node. The value is rendered as text, never as HTML, and newlines follow the node's CSS `white-space`. `fallback` displays inherited text when the saved value is empty or whitespace-only, without saving it. Set `fallbackLabel` to name its source: inherited text has a dotted underline on the canvas and the popover explains what clearing the override does. `hidden` suppresses the node explicitly; whitespace never means hidden. A template can bind it to a separate visibility parameter, as the calendar does with `showPlace`. Use `ctx.edit` for nodes that combine several parameters or show more than the value.

Templates read photo metadata (for captions) and page numbers through the context; they never receive file paths, image data, or Markdown source, and they cannot change project data.
