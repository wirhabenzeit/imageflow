# Template library

New books are made from the templates in the library: the built-in starter and the templates imported with **Templates → Manage Templates… → Import…**. Import loads the template like a book would and refuses one that fails to load. Before a template that bundles npm packages or declares `network` sites enters the library, the import lists the packages with their versions and licences and the sites its editors connect to, and **Templates → Manage Templates…** keeps showing them ([Dependencies](dependencies.md#dependencies), [Element editors](element-editors.md#element-editors)). The library keeps one entry per `id`, compared by `version` as dot-separated numbers: a newer version replaces the entry, while an older version, or the same version with other files, asks first. So bump `version` when you change a template you have shared. `label` (up to 80 characters) and `description` (up to 300) are what the library shows; without a label it shows the ID. A book copies its template when it is created, and `project.json` records the source's hash as `template.hash`; the library is never read while a book renders.

## Template previews

New Book and **Manage Templates…** show a picture of each template. By default it is a render of the first opening spread (or, when that is blank, an illustrated sample spread), made once per version and saved: built-in templates ship theirs with the app, and an imported template is rendered when it is imported and kept with it in the library. Both are tied to the [template hash](#template-library), so any change to the template's files makes a new one, and removing the template removes its render. A template that declares `network` sites is saved only once those sites are allowed, so the picture never lacks a map; until then it is rendered again in each session.

When the opening spread doesn't sell the template well, set `preview` to an image inside the template folder, such as `preview: './preview.jpg'`. New Book shows it instead of the render, cropped to fill a tile with the shape of the default format's trimmed page, never letterboxed. **Manage Templates…** keeps showing the render in its details, so you can compare. The image must be PNG, JPEG or WebP with a matching extension, at most 2 MB (about 1200 pixels on the long edge is plenty), and inside the template folder: no `..`, no dot folders, no symbolic links. It is part of the template's files and hash, so a book copies it and an export includes it. When the file is missing, too large or cannot be read, New Book falls back to the render. The Book check, and `check_book` and `get_authoring_context` for agents, report a `template-preview-invalid` warning for such a file and a `template-preview-aspect` warning when its width-to-height ratio differs from the default format's page by more than 5%. Update the image when you change the layouts it shows. The wall calendar sample uses `preview` to show a month page instead of its cover. Included in the contract-1 baseline.

To share a template, export it as an `.imageflow-template` file: **Export…** in **Templates → Manage Templates…** saves a library entry, built-in ones included. To share an edited book template, import its template folder into the library first. The file is a zip of the template's files, leaving out dotfiles and `node_modules/`, and exporting the same files always gives the same bytes. Importing it, from **Import Templates…** or by opening it in Finder, gives the same hash as the folder it came from. A zip made with Finder's **Compress** works too, when it holds the template folder or its contents. Files with paths outside the template, links, encrypted entries or damaged data are refused before anything is written.

## Opening spreads

`openingSpreads` lists the spreads a new book starts with, in order. Creating a book from a library template applies these defaults; the editor also offers them in an empty book. Each entry names a layout and may set some of that layout's own parameters:

```ts
defineTemplate({
  …,
  spreads: ({ spread }) => ({ title: spread({ span: 'right', … }), story: spread({ … }), closing: spread({ span: 'left', … }) }),
  openingSpreads: [{ layout: 'title' }, { layout: 'story', params: { heading: 'Day one' } }, { layout: 'closing' }],
});
```

- The template fails to load if an entry names a layout that `spreads` does not declare, sets a parameter the layout does not have, or sets a value the parameter does not allow. TypeScript reports an undeclared layout as a property missing from `spreads`.
- Single pages must sit at a book end that every declared format allows: a `right` page only first and a `left` page only last, in formats with `ends: 'single-pages'`.
- The opening spreads don't need to meet the format's page count. Books are built up from them.
- Without `openingSpreads`, a new book starts with no spreads. A book with no spreads is valid: the editor shows an empty state that offers the opening spreads, if the template has any, and every layout that can start a book. The Book check reports `book-empty` as an error, so neither proof nor print export is possible yet. Deleting the last spread also leaves an empty book.

The starter declares a title page, one *Photo and story* spread and the closing page.
