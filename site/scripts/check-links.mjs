import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Checks every internal link and anchor in the built site. VitePress already fails the build on links to missing
// pages; this also catches missing anchors and links into the base path that VitePress does not resolve.
const dist = fileURLToPath(new URL('../.vitepress/dist/', import.meta.url));
const base = process.env.DOCS_BASE ?? '/imageflow/';

async function htmlFiles(folder) {
  const entries = await readdir(folder, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const path = join(folder, entry.name);
    return entry.isDirectory() ? htmlFiles(path) : entry.name.endsWith('.html') ? [path] : [];
  }));
  return nested.flat();
}

const decode = (text) => text.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const pages = new Map();
for (const file of await htmlFiles(dist)) {
  const html = await readFile(file, 'utf8');
  const main = html.match(/<main[\s\S]*<\/main>/)?.[0] ?? html;
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => decode(match[1])));
  const links = [...main.matchAll(/<a\s[^>]*href="([^"]+)"/g)].map((match) => decode(match[1]));
  pages.set(file, { ids, links });
}

function targetFile(path) {
  const rel = path.slice(base.length).replace(/(^|\/)$/, '$1index');
  for (const candidate of [rel, rel + '.html', rel.replace(/\.html$/, '') + '.html']) {
    const file = join(dist, candidate);
    if (pages.has(file) || (candidate && existsSync(file) && !file.endsWith('/'))) return file;
  }
  return undefined;
}

const problems = [];
for (const [file, { links }] of pages) {
  const from = '/' + relative(dist, file);
  for (const href of links) {
    if (/^(https?:|mailto:)/.test(href)) continue;
    const [path, anchor] = href.split('#');
    let target = file;
    if (path) {
      const absolute = new URL(path, 'https://site' + base + relative(dist, file)).pathname;
      if (!absolute.startsWith(base)) { problems.push(from + ': ' + href + ' is outside ' + base); continue; }
      target = targetFile(decodeURI(absolute));
      if (!target) { problems.push(from + ': ' + href + ' has no page'); continue; }
    }
    if (anchor && pages.has(target) && !pages.get(target).ids.has(decodeURIComponent(anchor))) {
      problems.push(from + ': ' + href + ' has no anchor #' + anchor);
    }
  }
}
if (problems.length) {
  console.error(problems.length + ' broken links:\n' + problems.join('\n'));
  process.exit(1);
}
console.log('Checked links on ' + pages.size + ' pages.');
