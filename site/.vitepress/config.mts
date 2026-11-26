import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type DefaultTheme } from 'vitepress';
// @ts-expect-error Plain ES module shared with the docs generator and the MCP docs.
import { slug } from '../../scripts/docs-topics.mjs';

// The site is built straight from docs/. The template API pages are the topic files in docs/template-api/, the
// same files the MCP server and the agent skill serve, so the site cannot drift from them. docs/template-api.md
// (the generated one-page copy for GitHub) is left out.

const repo = 'https://github.com/wirhabenzeit/imageflow';
const root = fileURLToPath(new URL('../../', import.meta.url));
const docs = join(root, 'docs');
const site = join(root, 'site');
const base = process.env.DOCS_BASE ?? '/imageflow/';

type Topic = { id: string; title: string; summary: string };
const topics: Topic[] = JSON.parse(readFileSync(join(docs, 'template-api/topics.json'), 'utf8'));

// Which topic page holds each heading, so links to anchors on the one-page template-api.md land on the topic page.
const anchorPage = new Map<string, string>();
for (const { id } of topics) {
  let code = false;
  for (const line of readFileSync(join(docs, 'template-api', id + '.md'), 'utf8').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) code = !code;
    const heading = !code && line.match(/^#{1,6} (.+)$/);
    if (heading && !anchorPage.has(slug(heading[1]))) anchorPage.set(slug(heading[1]), id);
  }
}

/** Where a relative link from a docs page points on the site, or undefined to leave it alone. */
function siteLink(page: string, href: string): string | undefined {
  if (/^([a-z]+:|#|\/)/i.test(href)) return undefined;
  const [path, anchor] = href.split('#') as [string, string | undefined];
  const target = resolve(dirname(page), decodeURI(path));
  const rel = relative(root, target).split('\\').join('/');
  const hash = anchor ? '#' + anchor : '';
  if (rel === 'docs/template-api.md') {
    const id = anchor && anchorPage.get(anchor);
    return id ? '/template-api/' + id + hash : '/templates/';
  }
  if (rel === 'docs/template-api') return '/templates/';
  if (rel.startsWith('docs/') && /\.(md|png|jpe?g|svg|webp|gif)$/i.test(rel) && !rel.startsWith('docs/benchmarks/')) return undefined;
  if (rel.startsWith('..')) return undefined;
  const kind = existsSync(target) && statSync(target).isDirectory() ? 'tree' : 'blob';
  return repo + '/' + kind + '/main/' + rel + hash;
}

const history = ['content-template-contract', 'v1-decisions', 'v1-implementation-plan', 'validation-plan', 'print-targets', 'authoring-foundations'];

const sidebar: DefaultTheme.Sidebar = {
  '/guide/': [
    {
      text: 'Using ImageFlow',
      items: [
        { text: 'Getting started', link: '/guide/getting-started' },
        { text: 'Books and sources', link: '/guide/books-and-sources' },
        { text: 'Syncing between Macs', link: '/guide/sync' },
        { text: 'Editing a book', link: '/guide/editing' },
        { text: 'The workspace', link: '/guide/workspace' },
        { text: 'Checking and exporting', link: '/guide/checking-and-export' },
        { text: 'Template library', link: '/guide/templates' },
        { text: 'Connecting agents', link: '/guide/agents' },
      ],
    },
  ],
  '/templates/': [
    {
      text: 'Writing templates',
      items: [
        { text: 'Overview', link: '/templates/' },
        { text: 'Agent connection and tools', link: '/mcp' },
      ],
    },
    {
      text: 'Template API (contract 1)',
      collapsed: false,
      items: topics.map(({ id, title }) => ({ text: title.replace(/`/g, ''), link: '/template-api/' + id })),
    },
  ],
  '/development/': [
    {
      text: 'Working on ImageFlow',
      items: [
        { text: 'Setup', link: '/development/setup' },
        { text: 'Testing and CI', link: '/development/testing' },
        { text: 'Documentation site', link: '/development/docs-site' },
        { text: 'Releasing', link: '/releasing' },
        { text: 'Signing and notarization', link: '/signing' },
        { text: 'Authoring performance', link: '/authoring-performance' },
      ],
    },
    {
      text: 'Decisions',
      items: [
        { text: '0001 Rendering', link: '/decisions/0001-rendering' },
        { text: '0002 Custom dimensions', link: '/decisions/0002-custom-dimensions' },
        { text: '0003 Template library', link: '/decisions/0003-template-library' },
        { text: '0004 Document packages', link: '/decisions/0004-document-packages' },
        { text: '0005 Linked sources', link: '/decisions/0005-linked-sources' },
        { text: '0006 Template capabilities', link: '/decisions/0006-template-capabilities' },
        { text: '0007 Template v1 baseline', link: '/decisions/0007-template-v1-baseline' },
        { text: '0008 Baseline freeze at release', link: '/decisions/0008-baseline-freeze-at-release' },
        { text: '0009 Page templates', link: '/decisions/0009-page-templates' },
        { text: '0010 Sync, revisions and cloud assets', link: '/decisions/0010-sync-revisions-and-cloud-assets' },
        { text: '0011 Lightroom Classic integration', link: '/decisions/0011-lightroom-classic' },
        { text: '0012 Sync backend and library', link: '/decisions/0012-sync-backend-and-library' },
        { text: '0013 Apple Photos', link: '/decisions/0013-apple-photos' },
      ],
    },
    {
      text: 'History',
      collapsed: true,
      items: [
        { text: 'Authoring feedback foundations', link: '/authoring-foundations' },
        { text: 'Print targets research', link: '/print-targets' },
        { text: 'v1 decisions', link: '/v1-decisions' },
        { text: 'v1 implementation plan', link: '/v1-implementation-plan' },
        { text: 'Validation plan', link: '/validation-plan' },
        { text: 'Content and template contract', link: '/content-template-contract' },
      ],
    },
  ],
};
// Development pages that live at the docs root use the development sidebar too.
const devPages = ['releasing', 'signing', 'authoring-performance', ...history];
for (const page of devPages) sidebar['/' + page] = sidebar['/development/'];
sidebar['/decisions/'] = sidebar['/development/'];
sidebar['/template-api/'] = sidebar['/templates/'];
sidebar['/mcp'] = sidebar['/templates/'];

export default defineConfig({
  title: 'ImageFlow',
  description: 'Designed in code. Composed by eye. Design photobooks and calendars on macOS from photos, Markdown and editable templates.',
  srcDir: '../docs',
  srcExclude: ['template-api.md', 'benchmarks/**', 'README.md'],
  base,
  cleanUrls: true,
  lastUpdated: true,
  head: [
    ['meta', { name: 'theme-color', content: '#14a687' }],
    ['link', { rel: 'icon', type: 'image/svg+xml', href: base.replace(/\/?$/, '/') + 'imageflow-mark.svg' }],
  ],
  markdown: {
    anchor: { slugify: slug },
    config(md) {
      // Template code is full of {{ }} (React style objects). Keep Vue from reading it as interpolation.
      const inline = md.renderer.rules.code_inline!;
      md.renderer.rules.code_inline = (...args) => inline(...args).replace(/^<code/, '<code v-pre');
      const text = md.renderer.rules.text!;
      md.renderer.rules.text = (...args) => text(...args).replace(/\{\{/g, '&#123;&#123;');
      const open = md.renderer.rules.link_open;
      md.renderer.rules.link_open = (tokens, index, options, env, self) => {
        const href = tokens[index].attrGet('href');
        const page = env.realPath ?? env.path;
        const target = href && page ? siteLink(page, href) : undefined;
        if (target) {
          tokens[index].attrSet('href', target);
          if (/^https?:/.test(target)) tokens[index].attrSet('target', '_blank');
        }
        return open ? open(tokens, index, options, env, self) : self.renderToken(tokens, index, options);
      };
    },
  },
  vite: {
    // Serve/copy the canonical brand SVGs directly; do not keep another logo copy in docs/.
    publicDir: join(root, 'resources/brand/logo'),
    // The pages live in docs/, outside this package, so point their imports at site/node_modules.
    resolve: {
      alias: [
        // Package folders, not files, so Vite still picks the browser or server entry from package.json.
        { find: /^vue\/server-renderer$/, replacement: join(site, 'node_modules/vue/server-renderer') },
        { find: /^vue$/, replacement: join(site, 'node_modules/vue') },
      ],
    },
    server: { fs: { allow: [root] } },
  },
  transformPageData(pageData) {
    const page = pageData.relativePath.replace(/\.md$/, '');
    if (history.includes(page)) pageData.frontmatter.history = true;
  },
  themeConfig: {
    logo: {
      light: '/imageflow-horizontal-light.svg',
      dark: '/imageflow-horizontal-dark.svg',
      alt: 'ImageFlow',
    },
    siteTitle: false,
    nav: [
      { text: 'Guide', link: '/guide/getting-started', activeMatch: '^/guide/' },
      { text: 'Templates', link: '/templates/', activeMatch: '^/(templates|template-api|mcp)' },
      { text: 'Development', link: '/development/setup', activeMatch: '^/(development|decisions|releasing|signing|authoring-|print-targets|v1-|validation-plan|content-template)' },
    ],
    sidebar,
    search: { provider: 'local' },
    outline: { level: [2, 3] },
    socialLinks: [{ icon: 'github', link: repo }],
    editLink: { pattern: repo + '/edit/main/docs/:path', text: 'Edit this page on GitHub' },
  },
});
