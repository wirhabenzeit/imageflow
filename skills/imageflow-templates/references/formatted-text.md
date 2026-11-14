# Formatted text (`formatted-text`)

Declare a string with `markdown: 'inline'` to let its value carry inline formatting:

```tsx
heading: p.string({ label: 'Heading', multiline: true, default: '', markdown: 'inline' }),
// …
<ctx.Text parameter="heading" presentation="inline" as="h1" />
```

- **Saved value:** the string, with a small Markdown subset: `**bold**`, `*italic*`, `***bold italic***` and `~~strikethrough~~`. A backslash keeps a marker literal (`\*`, `\~`, `\\`). Markers that do not pair up, or that touch a space on the wrong side (`5 * 3`), stay as typed. Nothing else is Markdown: `#`, `_`, links, code and HTML are shown as typed. Headings, lists and links belong in Markdown boxes.
- **Opt-in:** without the flag a string is plain, as before, so existing values never change meaning. The flag may differ between layouts like other constraints, but a value written with markers shows them literally where the flag is off.
- **Rendering:** `ctx.Text` shows the value as `<strong>`, `<em>` and `<s>` inside its node, never as HTML. Style them in the template's CSS, for example `h1 strong { font-weight: 800; }` for a heading that is already semibold. Display-only `fallback` text is shown plain. Where a template shows the value with its own markup, `<FormattedText value={ctx.params.heading} />` renders the same elements, and `plainText(value)` gives the visible text without markers, for anchor titles and other places where formatting cannot show. `ctx.params` holds the saved string with its markers. The starter template formats its headings (contents entries use `plainText`) and its map title (with `<FormattedText>`).
- **Length:** `maxLength` counts the visible characters, not the markers, in validation, the generated field and the inline editor.
- **Inline editing:** the text shows its formatting while you type. Typing a closing marker that matches its opener on the same line converts it: `**word**` turns bold once the second closing `*` is typed, `*word*` italic, `~~word~~` struck through. ⌘B, ⌘I and ⇧⌘X (Ctrl on other systems) toggle the selection, the word at the caret, or the style of the next typed text; the toolbar has the same three buttons. Undo right after a conversion brings the typed markers back as literal text, so a footnote star or `2*3*4` can stay. This editor keeps its own Undo history while typing; each applied edit is still one book Undo entry. Paste inserts plain text, whose markers are kept literally.
- **Other surfaces:** the generated text field and agents (`apply_project_changes`) read and write the saved string with its markers.

`node scripts/smoke-inline-text.mjs` checks the desktop workflow after building and staging the app. It is included in `npm run test:desktop`, run by the manual Full desktop suite; the automatic core smoke suite stays small.
