# File parameters

A parameter can refer to a file the user adds to the project, for input that is not photos or Markdown, such as a GPX track for a map:

```tsx
import { file, p } from 'imageflow';

elements: { route: { label: 'Route map', parameters: { track: p.file({ label: 'GPX track', accept: ['.gpx'] }) } } },
render: (ctx) => {
  const track = file(ctx.elements.route.params.track);   // { name, extension, text } or undefined
  …
},
```

- **Choosing:** the generated control lists the project's files with an accepted extension, offers **Choose file…** to add one and **Remove** to clear the assignment. Imports follow **Settings → General → New imports** and register a copied or linked file in `project.json`; assigning it is a normal edit. Undo removes the assignment and keeps the file; clearing never deletes a file.
- **Value:** the file's ID in the project's `files` registry, or `''`. Paths in the registry are relative to the project, so moving the project folder keeps its files.
- **Content:** `file(id)` returns the file's name, extension and UTF-8 text, read when the project loads (files are limited to 20 MB). Preview and export render from the same text. It returns `undefined` when nothing is assigned or the assigned file cannot be read.
- **Diagnostics:** ImageFlow reports an assigned file that is no longer registered, missing or unreadable, or whose extension is not in `accept`, as a Book check error for that element, which blocks print export. An unassigned file parameter is valid. The template parses the content. If it cannot, it should render without it and report a [template finding](template-findings.md#template-findings) that names the element, parameter and file.
- **Example:** the starter's Map layout draws a list of GPX tracks ([List parameters](list-parameters.md#list-parameters)) over a basemap it renders (see [Element editors](element-editors.md#element-editors)). The Panorama layout has a Route map element that draws an assigned GPX track as a line in an inset (`sample/starter/files/senja-road.gpx`), without a basemap.
