import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashTemplateFiles, listTemplateFiles } from '../desktop/template-hash.mjs';
import { copySample } from '../desktop/sample-book.mjs';

// Recreates the compatibility books in tests/compat/books/ from the built-in starters, as a book made with
// File › New from each starter's sample would be: the sample with its template copy and the template's hash. Photos and
// template files are byte-identical to the samples', so git stores them once. Run it deliberately, because it replaces books that
// CI expects to keep opening unchanged: `node scripts/compat-books.mjs --write`. See tests/compat/README.md.
const root = fileURLToPath(new URL('../', import.meta.url));
if (!process.argv.includes('--write')) {
  console.error('This replaces tests/compat/books/. Run it with --write once you mean to (see tests/compat/README.md).');
  process.exit(1);
}
const starters = JSON.parse(await readFile(join(root, 'sample', 'starters.json'), 'utf8'));
const books = join(root, 'tests', 'compat', 'books');
await rm(books, { recursive: true, force: true });
await mkdir(books, { recursive: true });
for (const { folder } of starters) {
  const source = join(root, 'sample', folder);
  const target = join(books, folder);
  await copySample(source, target);
  const template = join(target, 'template');
  const file = join(target, 'project.json');
  const project = JSON.parse(await readFile(file, 'utf8'));
  project.template = { ...project.template, hash: await hashTemplateFiles(template, await listTemplateFiles(template)) };
  await writeFile(file, JSON.stringify(project, null, 2) + '\n');
  console.log('Wrote tests/compat/books/' + folder);
}
