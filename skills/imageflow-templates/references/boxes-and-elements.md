# Boxes and elements

- `boxes` declares content boxes. `type: 'photo'` accepts a photo from the photo index; `type: 'markdown'` accepts a Markdown file. Boxes may declare their own `parameters`.
- Markdown boxes on a spread need a unique `flowOrder` when the spread has more than one. Continuation follows project spread order, then `flowOrder`.
- `elements` declares generated artwork (calendar, ornaments with options) that has parameters but no assigned content.
- Identifiers are stable keys: renaming one is a breaking change for projects using the template.

## Text metadata

A Markdown source may start with a YAML header. ImageFlow leaves it out of the flowed text and gives its fields to every box the text flows through as `ctx.boxes[id].text.meta`, so a chapter's title, a palette or the places a map marks travel with the file that holds the chapter:

```markdown
---
title: Crossing the Alps
eyebrow: Field notes
places:
  - { name: Bergün, latitude: 46.63, longitude: 9.75 }
  - { name: Albula Pass, latitude: 46.58, longitude: 9.84 }
---

We left before sunrise…
```

```tsx
render: (ctx) => {
  const text = ctx.boxes.story.text;
  const title = typeof text?.meta.title === 'string' ? text.meta.title : undefined;
  return <Spread>
    {text?.part === 1 && title && <h1 className="opener">{title}</h1>}
    {text && text.part > 1 && title && <header className="running">{title}</header>}
    <ctx.MarkdownBox id="story" />
  </Spread>;
},
```

- **Recognising a header.** The first line of the file is exactly `---`, a later line is `---` or `...`, and the lines between are a YAML mapping. Anything else, such as a file that starts with a thematic break followed by a paragraph, stays Markdown. A file that starts `---`, then `key: value` lines and `---`, is a header even though it would otherwise read as a rule and a heading.
- **Values.** `meta` holds what JSON can: strings, numbers, booleans, `null`, lists and objects. YAML 1.2's core schema applies, so `2024-05-01` and `no` stay strings. A source without a header has `meta: {}`. ImageFlow does not check the fields: read the keys your layout understands, check their shape, and fall back to the layout's normal rendering otherwise. Report a field you cannot use with [`issue()`](template-findings.md#template-findings).
- **One source, every box.** `meta` is read from the saved file before any spread renders and is the same object for every box of the chain, whatever the flow puts in it, so a layout may size or style its boxes from it. Two sources on a spread each keep their own `meta`; the layout decides which one, if any, styles the page around them. Other pages read it through [`ctx.book.texts`](anchors-and-index.md#texts), and `anchors` through `boxes`. In layout previews a Markdown box has no flow position, so its `text` is `null` there.
- **Unreadable headers.** A header whose YAML cannot be read is a `text-frontmatter-invalid` warning on the text's first box. The header is still left out of the text, and `meta` is `{}`.
- **Editing.** ImageFlow does not change the header. Edit it in the Markdown editor or the linked file.

## Composing a text

A `MarkdownBox` flows its Markdown as it is. A composition shapes the text first: a function in the template's `compositions` that receives the text's top-level blocks and returns what flows. It can add an element before or after the blocks, replace a block with its own element, or put several blocks in one. A Markdown box names the composition for the text that starts in it:

```tsx
export default defineTemplate({
  // …
  compositions: {
    story: ({ blocks, meta }) => <>
      {meta.date && <p className="story-date" data-keep-next>{String(meta.date)}</p>}
      <h3>{String(meta.title ?? '')}</h3>
      {blocks.map((block) => block.type === 'heading' && block.depth === 2
        ? <div key={block.key} className="day-head" data-keep-next>
            <span className="day">{block.text.split(' · ')[0]}</span>
            <h3>{block.text.split(' · ')[1] ?? block.content}</h3>
          </div>
        : block.node)}
      <p className="end-mark">❦</p>
    </>,
  },
  spreads: ({ spread }) => ({
    story: spread({
      label: 'Story',
      boxes: { body: box.markdown('Story', { composition: 'story' }) },
      render: (ctx) => <Spread><ctx.MarkdownBox id="body" /></Spread>,
    }),
  }),
});
```

- **Blocks.** Each block has a `type` (`paragraph`, `heading`, `blockquote`, `list` or `rule`), a heading's `depth`, a list's `ordered`, its `text` without Markdown syntax, and a `key`. `block.node` is the block as ImageFlow renders it; `block.content` is what is inside it, such as a heading's formatted words, for your own element. Place a block once. The Markdown stays plain: read what you need from a heading's `text`, or from the header through `meta`.
- **What it reads.** A composition receives the text (`blocks`, `meta`) and the document settings (`document`), never a spread: a text has one structure wherever it is placed, and no spread parameter can change pages further on. A text that needs another structure names it in its header, and the composition reads `meta`; a layout that needs another names another composition.
- **Which composition.** The box a text starts in decides for the whole text, and the result flows through the chain, so an element before the blocks appears where the text starts and one after them where it ends. Give the boxes a text continues in the same `composition`, so their CSS meets the structure it expects. When a later box of the chain names another, or none, the Book check warns with `text-composition-mixed`; the text keeps the first. Moving a text's start to a layout with another composition therefore restructures the whole text.
- **Flow.** What a composition returns is measured, broken across columns and boxes and counted towards overflow like Markdown. Return block elements (`p`, headings, `div`, `blockquote`, lists) next to each other. An element marked `data-keep-next` stays whole and with the one after it, as a heading does, and a run of them stays together: a date, its title and the paragraph below. A run that begins a box too small for it stays where it is, and may then split. An element split across two boxes gets `.split` and `.cont` like a Markdown block; set `break-inside: avoid` on one that must not split.
- **Static.** A composition renders once per text, off the page, before the flow. Use plain elements and your own helper components. Content that arrives later — such as a `<RenderedImage>` or an `<img>` without fixed dimensions (images are decoded before the flow runs) — and platform components (`PhotoBox`, `MarkdownBox`, `Element`, `ctx.Text`) are not supported inside it.
- **Errors.** A composition that throws is a `text-composition-failed` error on the text's first box, and the text flows as plain Markdown until it is fixed. A box that names a composition the template does not declare fails the template's validation.
