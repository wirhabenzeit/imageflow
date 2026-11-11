# 0003: A template library for new projects

Status: proposed, 2026-11-11. Not implemented.

## Context

[v1-decisions.md](../v1-decisions.md) makes every project own its template. *New project* copies the bundled starter sample (template, photos, texts and spreads) into the new folder. `project.json` records `template: { id, version }`, and the renderer reports an error when the template in `template/` declares a different ID. An app update never rewrites a project's template folder.

That model stays. Copying the template into each project keeps books reproducible and portable, works with git, and lets authors edit a template with live preview. Two things are missing:

- **Choice.** *New project* only offers the starter. Users who write or receive more templates cannot start a book from them without copying folders by hand.
- **Sharing.** There is no supported way to hand a template to someone else, or to reuse a template from one project in the next.

Constraints from the current runtime:

- Templates are code. Their name, formats and layouts exist only in `index.tsx`. Reading them means bundling the template with esbuild (`bundleTemplate` in `desktop/project.ts`) and running it in the renderer.
- `defineTemplate` declares `id`, `version`, `contract` and `requires`, but no human-readable name.
- Opening a project runs its template. v1 has no sandbox beyond the renderer's and assumes users open only projects they trust.
- Layout fixtures (`desktop/fixtures.ts`) already render each layout with synthetic photos and text, without a real project.

## Decision

### Projects keep their own copy

A project's `template/` remains the only template the project uses. The library is only a source to copy from when a book is created. Nothing reads the library while rendering, checking or exporting, so deleting or replacing a library entry cannot change or break an existing book.

### Storage

User templates live in the app's data folder, `app.getPath('userData')/Templates`. In the packaged app that is `~/Library/Application Support/ImageFlow/Templates`.

```
Templates/
  imageflow-starter@0.3.0/
    index.tsx  styles.css  fonts/  assets/  types/  tsconfig.json
    .library.json
  travel@2.0.0/
    …
```

- **One folder per `id@version`.** The folder holds the template's source exactly as imported, plus `.library.json`, which the app writes (see below). After import an entry is never changed. Several versions of a template can coexist.
- **Built-in templates** stay in the app's resources (`sample/` today) and are not copied into the data folder, so an app update refreshes them. The library lists them as *Built-in*. If a user entry has the same ID and a higher version, it replaces the built-in entry in the list.
- **No editing in the library.** Authors keep working in a project's `template/`, where they get live preview, or in their own folder or git repository. The library holds published snapshots. *Reveal in Finder* is offered for inspection only.
- **Override for development and tests.** An environment variable (for example `IMAGEFLOW_TEMPLATES`) sets the library folder, like `IMAGEFLOW_DEV_SAMPLE` does for the samples.

### Import validates once and records metadata

Listing templates must not run their code every time. Import therefore does the expensive work once:

1. **Copy** the template's source into a staging folder inside `Templates/`. Dotfiles, `.imageflow/`, `node_modules/` and generated bundles are skipped. Symbolic links and paths outside the template folder are rejected, as the bundler already rejects imports outside `template/`.
2. **Bundle and load** the template with the same rules as a project, then validate it: declarations, formats, and `contract` and `requires` against this app's capabilities. A template that fails is not imported. Its diagnostics are shown in the same form as a project's template errors.
3. **Render thumbnails** for each layout with the fixture pipeline.
4. **Write `.library.json`:** ID, version, label, description, contract, `requires`, formats with trim sizes, layout labels with their footprints, thumbnail paths, a hash of the source files, and when and from where the template was imported.
5. **Move** the staged folder to `id@version/` atomically.

`.library.json` is a cache that the app derives from the source. If it is missing or was written by an older app, the app rebuilds it from the source the next time it lists the library. When the current app no longer supports an entry (its `contract` or `requires`), the entry stays listed but cannot be selected, and the reason is shown.

### Template metadata

`defineTemplate` gains two optional fields:

```ts
defineTemplate({
  id: 'travel',
  label: 'Travel journal',
  description: 'Full-bleed photos with a field-notes text column.',
  version: '2.0.0',
  contract: 1,
  …
})
```

Both fields are additive and change nothing in rendering, so they need no `requires` capability. Without `label`, the library shows the ID.

### Ways into the library

| Source | Typical use | Phase |
| --- | --- | --- |
| **Save Template to Library…** in the File menu | Publish the open project's `template/` after editing it there | 1 |
| **Import Template Folder…** | Import a folder with `index.tsx`, such as an author's repository | 1 |
| **`.imageflow-template` file** | Share a template by email or AirDrop. The file is a zip of the template folder without `.library.json`. *Export…* creates one, and double-clicking one opens the import. | 2 |

Rules for conflicts with an existing entry:

- **Same ID, same version, same hash:** nothing to do. The UI says the template is already in the library.
- **Same ID, same version, different hash:** the user chooses *Replace* or *Cancel*. The message suggests bumping `version`. Replacing is safe because no project reads the library.
- **Same ID, other version:** both are kept.

### Trust

Importing extends the v1 trust rule. Validation runs the template once, and every book created from it runs it again. The import sheet says so: *Templates contain code. Only import templates from people you trust.* The sandbox is the renderer's, the same as when a project is opened. Signed or sandboxed third-party templates stay deferred, as in v1.

### New Project

*New project…* opens a picker before the folder dialog. The picker shows each template's thumbnail, label, version and formats, with the newest version of each ID selected. Older versions are available behind a disclosure. After the user picks a template and a folder:

- the app copies the entry's source into `template/` (without `.library.json`);
- it writes a `project.json` with the folder's name as title, `template: { id, version }`, the template's default format and **no spreads**;
- it creates empty `photos.json`, `photos/`, `texts/` and `files/`.

The built-in starter keeps an **Include sample content** option, checked by default. With the option, *New project* copies the starter sample exactly as it does today.

`project.json` also records the template's source hash at creation, as `template.hash`. Nothing uses it yet. It lets a later version tell whether a project's copy was edited, which a template update needs (see Deferred).

### Library window

A *Templates* window, opened from the Window menu and from the project picker, lists the entries and offers *Import…*, *Export…* (phase 2), *Reveal in Finder* and *Delete*. Deleting moves the entry to the Trash. The built-in templates cannot be deleted.

## Consequences

- Books stay self-contained, as before. The library adds no dependency between a project and the machine it was created on.
- Users see a picker instead of an immediate save dialog. For a library with only the starter, the picker can preselect it so that creating a book takes no extra click beyond confirming.
- An empty book needs a usable empty state in the editor: no spreads, and a prompt to add the first layout.
- Template code runs at import, not only when a project opens. Import errors need the same quality of diagnostics as project load errors.
- The `Templates/` folder grows with every imported version. The window shows the size of each entry so that users can remove old versions.

## Deferred

- **Updating a project's template.** If the library has a newer version of a project's template ID, offer *Update Template to 2.1.0*. It replaces `template/` and applies the existing layout switching rules: identical IDs carry over, and everything else is kept in `project.json` and reported. If `template.hash` shows that the project's copy was edited, the update warns before overwriting.
- **Switching to another template ID**, using the same switching rules.
- **Example books in templates:** a template could ship sample spreads, texts and placeholder photos the way the starter does.
- **MCP:** `list_templates` and creating a book from a library entry, so that agents can start projects.
- **Remote catalogues** and signed templates.

## Validation plan

- Unit tests:
  - import filtering, including skipped files and rejected links and outside paths;
  - hash and conflict handling for same and different content;
  - rebuilding `.library.json` when it is missing or stale;
  - selecting the newest version per ID, and user entries overriding built-ins;
  - entries the app does not support are listed but cannot be selected.
- Lifecycle smoke test (extends `smoke-project-lifecycle.mjs`): save the open project's template to a temporary library, create a new project from it, and check that the new project's `template/` matches the source and that `project.json` names the ID, version and hash. Delete the library entry and reopen the project, which must still load and render.
- Import failure test: a template with a compile error, and one whose `requires` lists an unknown capability, are both rejected with diagnostics, and nothing is left in `Templates/`.
- Phase 2: an exported `.imageflow-template` round-trips to an identical hash.

## Open questions

- Should every template be able to ship an example book, or is the starter's sample content enough for now? This proposal defers example books.
- Should the library keep every imported version, or keep one entry per ID and replace it on a newer import? This proposal keeps every version, because it costs little and makes template updates possible later.
- Should the built-in starter keep its sample content as the default, or should an empty book be the default for every template?
