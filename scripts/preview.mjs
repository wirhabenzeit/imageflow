import { readFile, readdir, writeFile } from 'node:fs/promises';

const build = new URL('../dist/', import.meta.url);
let html = await readFile(new URL('index.html', build), 'utf8');
const script = html.match(/<script type="module" crossorigin src="\/([^"]+)"><\/script>/);
const stylesheet = html.match(/<link rel="stylesheet" crossorigin href="\/([^"]+)">/);
if (!script || !stylesheet) throw new Error('The standalone preview needs the Vite script and stylesheet.');

const [js, css] = await Promise.all([
  readFile(new URL(script[1], build), 'utf8'),
  readFile(new URL(stylesheet[1], build), 'utf8'),
]);
const assets = new URL('assets/', build);
const photos = await Promise.all((await readdir(assets))
  .filter((name) => name.endsWith('.jpg'))
  .map(async (name) => [name, await readFile(new URL(name, assets), 'base64')]));
let embedded = js;
for (const [name, data] of photos) {
  embedded = embedded.replaceAll('/assets/' + name, 'data:image/jpeg;base64,' + data);
}
html = html.replace(script[0], '').replace(stylesheet[0], () => '<style>' + css + '</style>');
html = html.replace('</body>', () => '<script>' + embedded.replace(/<\/script/gi, '<\\/script') + '</script></body>');
await writeFile(new URL('senja-preview.html', build), html);
console.log('Standalone editor preview: dist/senja-preview.html');
