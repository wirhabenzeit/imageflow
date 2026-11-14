# Getting started

ImageFlow is a Mac app for designing photobooks and wall calendars. A book combines your photos, text written in Markdown and a template that defines its layouts and print format. ImageFlow checks the book as you work and exports proof and print-ready PDFs.

## Requirements and installation

ImageFlow runs on Macs with Apple silicon.

::: info Before the first release
Signed downloads will be published on the [GitHub Releases page](https://github.com/wirhabenzeit/imageflow/releases): download the `.dmg`, open it and drag **ImageFlow** to **Applications**. Until the first release is out, build the app from source as described in [Setup](../development/setup.md).
:::

## Your first book

1. **Open ImageFlow.** Without a book open, the start window shows your recent books, **New Book…** and **Open…**.
2. **Choose New Book….** Pick a template from the library, then choose the book's name and where to save it. The built-in **Photobook** and **Wall calendar** templates can include their sample photos, texts and spreads, so you can explore a finished book first. Other templates start with their opening spreads, or empty.
3. **Import your photos.** Use **File → Import** or the **Import** menu in the Sources strip, or drop JPEG, PNG and WebP files onto the photo strip or a photo box. Drag photos from the strip onto the photo boxes of a spread. See [Editing a book](editing.md).
4. **Add text.** Drop a Markdown file onto a text box, or choose **New Text** in the Texts strip to write one inside the book.
5. **Check the book.** The [Book check](checking-and-export.md#book-check) runs after every change. The icon at the right of the status bar shows its progress and the number of issues.
6. **Export a proof.** **File → Export PDF…** saves the book for review. When it is ready to order, **File → Export for Print…** checks it against the print format first. See [Checking and exporting](checking-and-export.md).

Every book opens in its own window. Closing the last one returns to the start window, and **Window → Welcome to ImageFlow** brings it back at any time.

::: warning Sample photos
The Photobook starter's four sample photos are placeholders upscaled from small originals. They pass the resolution check but print soft, so replace them before you order a proof.
:::

## The built-in templates

**Photobook** is a travel journal in two square and landscape formats. Its book settings choose a colour theme (light or dark), serif or sans headings, the text size of stories, the photo spacing of grids and collages, and page numbers. Its layouts include title pages, a contents page, chapter openers, photo and story spreads, quotes, panoramas, photo grids, a map with GPX tracks and a closing list of every photo with its pages and credits.

![The Photobook starter in its light theme](../images/photobook-starter-light.jpg)

**Wall calendar** is a landscape calendar without facing pages, in A3 and A2: an optional cover, then one page per month with a full-bleed photo and a strip holding the place, the month and its days. Book settings choose the first month, the language of month and day names, and the strip colour. **Marked days** are dates such as `25.12` every year or `2027-04-16` once. **Marked days from calendar** takes an `.ics` file exported from a calendar app and marks its all-day events, including yearly repeats. Clicking a month's days opens the day picker: a click marks a date once, and Option-click toggles a yearly mark.

## Templates run code

A template is a small program that draws the book's pages. Only open books and templates from people you trust.

## Next steps

- [Books and sources](books-and-sources.md): what a `.imageflow` document contains, and copying or linking files.
- [The workspace](workspace.md): toolbar, sidebars, canvas and keyboard shortcuts.
- [Writing templates](../templates/index.md): make your own layouts.
- [Connecting agents](agents.md): let Claude, ChatGPT or Codex work on an open book.
