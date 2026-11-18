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
