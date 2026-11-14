import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { docsOutputs, skillFolder } from './docs-topics.mjs';

// Writes docs/template-api.md and the skill's references and examples from docs/template-api/*.md.
// With --check, only reports stale or extra files and exits with an error.
const root = fileURLToPath(new URL('../', import.meta.url));
const check = process.argv.includes('--check');
const outputs = await docsOutputs(root);
const stale = [];
for (const [path, text] of Object.entries(outputs)) {
  const current = await readFile(join(root, path), 'utf8').catch(() => undefined);
  if (current === text) continue;
  stale.push(path);
  if (!check) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
}
for (const folder of ['references', 'examples']) {
  const names = await readdir(join(root, skillFolder, folder)).catch(() => []);
  for (const name of names) {
    const path = skillFolder + '/' + folder + '/' + name;
    if (path in outputs) continue;
    stale.push(path);
    if (!check) await rm(join(root, path));
  }
}
if (check && stale.length) {
  console.error('Generated docs are stale. Run npm run generate:docs.\n' + stale.join('\n'));
  process.exit(1);
}
console.log(stale.length ? (check ? '' : 'Updated ' + stale.join(', ')) : 'Generated docs are up to date.');
