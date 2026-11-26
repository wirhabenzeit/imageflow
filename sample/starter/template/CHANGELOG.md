# Photobook starter: changes

What changed in each version of the built-in starter (`imageflow-starter`), so a book whose template was copied from
an earlier version can bring over what it wants. A book's template is its own copy: updating ImageFlow never changes
it. Compare the two with the `read_library_template` agent tool, port the parts you want by hand, and then raise
`basedOn.version` in your template.

## 0.13.4

- Photo captions use `<ctx.Caption box="hero" />` instead of a helper of their own: clicking a caption on the page
  types it there, saved with the photo as **Edit Caption…** saves it. With **Show caption** on and no caption yet, the
  editor shows "Add caption" where it will print; thumbnails and export do not.

## 0.13.3

- **Show caption** declares `shows: 'caption'`: entering the first caption of a photo switches it on. Its description
  says where captions are edited.

## 0.13.2

- The **Show caption** setting's description says where captions are edited: right-click the photo, on the page or in
  the Inspector's list, and choose **Show in Assets**.

## 0.13.1

- Measured print presets in `print-presets.ts`: WhiteWall Gallery Square (three papers) and Blurb Large Square (six
  papers, ImageWrap or dust jacket). Each returns the interior format and its cover together, with the research date
  and sources. The starter's own formats are unchanged.
- The photo and photo grid families use the built-in `choice` picker instead of a component (`Photo style`, `Grid
  size`).
- Maps: a list of country names set at given points, for countries the base map labels outside a regional map; the
  base map's labels give way to them.
- Maps: line labels follow winding lines (`maplibre-svg:features-of`) and sit on their straightest stretch; the Lines
  style labels contour heights; point and line labels the map's edge would cut are left out.

## 0.13.0

- Exterior covers: `coverFormats` for the Square (WhiteWall) and Blurb Large Square dust jacket formats, and a
  **Photo wrap** cover layout with a cover photo, title, spine title, back cover text and flap texts.

## 0.12.0

- Story pages take the text's YAML `title` as their heading, running head and contents entry.
- The Inset map marks the places named in the story beside it.
- Maps: Mapterhorn's no-data replies count as sea level, and map errors name the site and status that failed.
