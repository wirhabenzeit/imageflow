# Template library

New books are made from the templates in the library: the built-in starter and the templates imported with **Templates → Manage Templates… → Import…**. Import loads the template like a book would and refuses one that fails to load. Before a template that bundles npm packages or declares `network` sites enters the library, the import lists the packages with their versions and licences and the sites its editors connect to, and **Templates → Manage Templates…** keeps showing them ([Dependencies](dependencies.md#dependencies), [Element editors](element-editors.md#element-editors)). The library keeps one entry per `id`, compared by `version` as dot-separated numbers: a newer version replaces the entry, while an older version, or the same version with other files, asks first. So bump `version` when you change a template you have shared. `label` (up to 80 characters) and `description` (up to 300) are what the library shows; without a label it shows the ID. A book copies its template when it is created, and `project.json` records the source's hash as `template.hash`; the library is never read while a book renders.

## Forks and starter updates

A book's template is its own copy. An app update never changes it, even when the library holds a newer version of the template it came from; `project.json` records that template's `id`, `version` and `hash` as provenance, and nothing updates them later. So once you change a book's template, it is a fork.

Give a fork an `id` of its own and start its `version` again, and name the template it was copied from, at the version copied, as `basedOn: { id: 'imageflow-starter', version: '0.11.1' }`. A book made from that template opens with the fork, because its ID check also accepts `basedOn.id`, and a fork saved to the library is a separate entry beside the original. Agents see `basedOn` in `templateIdentity`, so they can tell a fork from an unchanged copy, and an older `version` of the same ID from a newer template. Included in the contract-1 baseline (`template-lineage`).

To bring changes from a newer starter into a fork, compare the two rather than replacing the fork's `template/` folder, which would discard its changes. The starter's `CHANGELOG.md` lists what each version changed. Agents read a library template's files with `read_library_template`, and with `project` it lists which files differ from the book's `template/`. Port what you want by hand, check the book, and raise `basedOn.version` to the version you compared with.

## Template previews

New Book and **Manage Templates…** show a picture of each template. By default it is a render of the first opening spread (or, when that is blank, an illustrated sample spread), made once per version and saved: built-in templates ship theirs with the app, and an imported template is rendered when it is imported and kept with it in the library. Both are tied to the [template hash](#template-library), so any change to the template's files makes a new one, and removing the template removes its render. A template that declares `network` sites is saved only once those sites are allowed, so the picture never lacks a map; until then it is rendered again in each session.

When the opening spread doesn't sell the template well, set `preview` to an image inside the template folder, such as `preview: './preview.jpg'`. New Book shows it instead of the render, cropped to fill a tile with the shape of the default format's trimmed page, never letterboxed. **Manage Templates…** keeps showing the render in its details, so you can compare. The image must be PNG, JPEG or WebP with a matching extension, at most 2 MB (about 1200 pixels on the long edge is plenty), and inside the template folder: no `..`, no dot folders, no symbolic links. It is part of the template's files and hash, so a book copies it and an export includes it. When the file is missing, too large or cannot be read, New Book falls back to the render. The Book check, and `check_book` and `get_authoring_context` for agents, report a `template-preview-invalid` warning for such a file and a `template-preview-aspect` warning when its width-to-height ratio differs from the default format's page by more than 5%. Update the image when you change the layouts it shows. The wall calendar sample uses `preview` to show a month page instead of its cover. Included in the contract-1 baseline.

To share a template, export it as an `.imageflow-template` file: **Export…** in **Templates → Manage Templates…** saves a library entry, built-in ones included. To share an edited book template, import its template folder into the library first; an agent can save it with the `save_template_to_library` tool. The file is a zip of the template's files, leaving out dotfiles and `node_modules/`, and exporting the same files always gives the same bytes. Importing it, from **Import Templates…** or by opening it in Finder, gives the same hash as the folder it came from. A zip made with Finder's **Compress** works too, when it holds the template folder or its contents. Files with paths outside the template, links, encrypted entries or damaged data are refused before anything is written.

## Opening spreads

`openingSpreads` lists the units a new book starts with, in order. Creating a book from a library template applies these defaults; the editor also offers them in an empty book. An entry either names one layout with optional layout parameters, or supplies independent page states for a full facing sheet:

```ts
defineTemplate({
  …,
  spreads: ({ spread, page }) => ({
    title: page({ label: 'Title', sides: ['right'], … }),
    photo: page({ label: 'Photo', … }),
    story: page({ label: 'Story', parameters: { heading }, … }),
    panorama: spread({ label: 'Panorama', … }),
    closing: page({ label: 'Closing', sides: ['left'], … }),
  }),
  openingSpreads: [
    { layout: 'title' },
    { pages: { left: { layout: 'photo' }, right: { layout: 'story', params: { heading: 'Day one' } } } },
    { layout: 'panorama' },
    { layout: 'closing' },
  ],
});
```

- A `{ layout, params? }` entry creates one ordinary layout state: a spread, a single end page, or a unit without facing pages, according to the layout and format. A `{ pages }` entry creates a sheet shown as independent pages, with page parameters stored separately. It is available only for facing formats and full-sheet positions.
- Each `pages.left`/`pages.right` state can name a page layout and its own `params`. Omit a side, or use `{}` for that side, to leave it blank. Layout IDs must name page designs, and side restrictions must allow their placement.
- The template fails to load if an entry names an undeclared layout, sets a parameter the layout does not have, or sets a value the parameter does not allow. Parameter checks are per page for a page pair. TypeScript also checks declared layout IDs.
- Single opening and closing pages use ordinary page layouts allowed on the required side, or compatible legacy `right`/`left` layouts. They are not page pairs.
- The opening sequence need not meet the format's page-count rule; books can be built up from it. Validation checks its layouts and page composition against the formats of the default format's kind.
- Without `openingSpreads`, a new book starts with no spreads. An empty book offers every layout that can start it, including reusable page designs. In a facing full-sheet position, a page design starts on an allowed side with the other side blank. The Book check reports `book-empty` until a unit is added.

The starter includes ordinary opening and closing pages and composed photo/story pages in its new-book defaults. Only the Panorama, Chapter opener and full-spread Map are spread templates; contents, inset maps, picture lists and the other designs are independent page templates. Template files are copied into each new book; changing the built-in starter never rewrites an existing book's template.
