# Documentation site

[VitePress](https://vitepress.dev) builds the site from `docs/`. Configuration, theme and separate dependencies live in `site/`.

```sh
cd site
npm ci
npm run dev       # preview at http://localhost:5173/imageflow/
npm run build     # build and check links
```

Output is written to `site/.vitepress/dist/`.

## Content and navigation

| Section | Sources |
| --- | --- |
| Guide | `docs/guide/` |
| Templates | `docs/templates/`, `docs/mcp.md`, `docs/template-api/` |
| Development | `docs/development/`, `docs/releasing.md`, `docs/signing.md`, `docs/decisions/` |
| History | Design notes marked with a historical banner |

The template API sidebar and topic table use `docs/template-api/topics.json`. Topic files are shared with the MCP server and template skill. The generated single-page `docs/template-api.md` is excluded.

Keep Markdown links relative for GitHub. The site redirects single-page API links to matching topics and links outside `docs/` to GitHub.

Add pages to the sidebar in `site/.vitepress/config.mts`. Its `history` list controls the historical banner.

## Checks and publishing

The **Docs** workflow builds every pull request and push to `main`. VitePress rejects missing page links; `site/scripts/check-links.mjs` checks internal links and anchors in the built page content.

Pushes to `main` publish to [GitHub Pages](https://wirhabenzeit.github.io/imageflow/). Set **Settings → Pages → Build and deployment → Source** to **GitHub Actions**. Set `DOCS_BASE` to override the default `/imageflow/` base path.
