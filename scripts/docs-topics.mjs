import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

// The template API reference lives in one Markdown file per topic under docs/template-api/, in the order of
// topics.json. The MCP server serves these files on request, the agent skill ships them as its references, and
// docs/template-api.md is generated from them as one page. `npm run generate:docs` writes every copy;
// tests/docs-topics.test.ts fails when a copy is stale.

const intro = `Status: implemented reference for the v1 runtime. The executable schemas in \`src/template.tsx\`, \`src/parameters.ts\`, \`src/format.ts\`, and \`src/project.ts\` govern validation. The authoring declarations are in \`authoring/imageflow.d.ts\`; the complete working example is \`sample/starter/template/index.tsx\`. Historical proposals are not alternative supported APIs.

This page is generated from the topic files in [\`template-api/\`](template-api), which the ImageFlow MCP server (\`get_authoring_context\` with \`docs\`) and the [agent skill](../skills/imageflow-templates/SKILL.md) serve one at a time. Edit those files and run \`npm run generate:docs\`.`;

export const skillFolder = 'skills/imageflow-templates';

const fence = (line) => /^\s*(```|~~~)/.test(line);

/** GitHub's heading anchor: lower case, punctuation removed, spaces as hyphens. */
export function slug(heading) {
  return heading.trim().toLowerCase().replace(/[^\p{L}\p{N}_\- ]/gu, '').replace(/ /g, '-');
}

export async function readTopics(root) {
  const folder = join(root, 'docs/template-api');
  const manifest = JSON.parse(await readFile(join(folder, 'topics.json'), 'utf8'));
  const files = (await readdir(folder)).filter((name) => name.endsWith('.md')).sort();
  const listed = manifest.map(({ id }) => id + '.md').sort();
  if (JSON.stringify(files) !== JSON.stringify(listed)) {
    throw new Error('docs/template-api/topics.json must list every topic file exactly once.');
  }
  return Promise.all(manifest.map(async ({ id, title, summary }) => {
    const text = await readFile(join(folder, id + '.md'), 'utf8');
    if (text.match(/^# (.+)\n/)?.[1] !== title) throw new Error('Topic ' + id + ' must start with its title, # ' + title + '.');
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)) throw new Error('Topic ID ' + id + ' must be kebab-case.');
    if (!summary || summary.length > 200) throw new Error('Topic ' + id + ' needs a one-line summary of at most 200 characters.');
    return { id, title, summary, text };
  }));
}

/** One page: topic headings move down a level, and links between topic files become anchors on the page. */
export function combinedPage(topics) {
  const titles = Object.fromEntries(topics.map(({ id, title }) => [id, slug(title)]));
  const link = (line) => line
    .replace(/\]\(([a-z0-9-]+)\.md(#[^)]*)?\)/g, (match, id, anchor) => titles[id] ? '](' + (anchor ?? '#' + titles[id]) + ')' : match)
    .replace(/\]\(\.\.\/examples/g, '](examples');
  const sections = topics.map(({ text }) => {
    let code = false;
    return text.trimEnd().split('\n').map((line) => {
      if (fence(line)) { code = !code; return line; }
      if (code) return line;
      return link(/^#{1,5} /.test(line) ? '#' + line : line);
    }).join('\n');
  });
  const contents = topics.map(({ title, summary }) => '- [' + title + '](#' + slug(title) + '): ' + summary).join('\n');
  return ['# Template API (contract 1)', intro, '## Topics', contents, ...sections].join('\n\n') + '\n';
}

/** Every generated file, by repository path. */
export async function docsOutputs(root) {
  const topics = await readTopics(root);
  const examples = (await readdir(join(root, 'docs/examples'))).filter((name) => name.endsWith('.tsx')).sort();
  const outputs = { 'docs/template-api.md': combinedPage(topics) };
  for (const { id, text } of topics) outputs[skillFolder + '/references/' + id + '.md'] = text;
  for (const name of examples) outputs[skillFolder + '/examples/' + name] = await readFile(join(root, 'docs/examples', name), 'utf8');
  return outputs;
}
