# Documentation site

This site is built with [VitePress](https://vitepress.dev) straight from the `docs/` folder. Its configuration and theme live in `site/`, with their own `package.json`, so the app's dependencies stay separate.

```sh
cd site
npm ci
npm run dev       # live preview at http://localhost:5173/imageflow/
npm run build     # build into site/.vitepress/dist and check links
```

## What goes where

| Section | Files |
| --- | --- |
| Guide | `docs/guide/` |
| Writing templates | `docs/templates/`, `docs/mcp.md`, and the topic files in `docs/template-api/` |
| Development | `docs/development/`, `docs/releasing.md`, `docs/signing.md`, `docs/decisions/` |
| History | design notes kept for background; each shows a "historical" banner |

The template API pages and their sidebar come from `docs/template-api/topics.json` and the topic files, the same files the MCP server and the agent skill serve, so the site never needs a separate copy. The generated `docs/template-api.md` is left out of the site. Links in the Markdown stay relative so they also work on GitHub: links to the one-page `template-api.md` land on the matching topic page, and links to files outside `docs/` (source files, examples, the skill) open on GitHub.

New pages need an entry in the sidebar in `site/.vitepress/config.mts`. Pages listed there as history get the historical banner.

## Checks and publishing

The **Docs** workflow builds the site for every pull request and push to `main`. The build fails on links to pages that do not exist, and `site/scripts/check-links.mjs` then checks every internal link and anchor in the built HTML.

On pushes to `main`, the same workflow publishes the site to GitHub Pages at <https://wirhabenzeit.github.io/imageflow/>. It needs **Settings → Pages → Build and deployment → Source** set to **GitHub Actions** once. The site describes `main`; before the first release, `main` and the released version are the same, and a release branch or versioned docs can follow later if they diverge.
