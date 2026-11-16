import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { loadProject } from '../desktop/project';
import { configureSourceStore } from '../desktop/source-store';
import { bookFormatVersion, projectSchema } from '../src/project';

// The compatibility books (tests/compat/README.md) keep opening with the current app without being rewritten.
// Rendering, checking and exporting them is covered by scripts/smoke-compat-books.mjs in the desktop suite.
const books = resolve('tests/compat/books');

// Every file of a book except the app's private `.imageflow/` folder, with its content hash.
async function contents(folder: string) {
  const files: Record<string, string> = {};
  const walk = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (path !== join(folder, '.imageflow')) await walk(path);
      } else {
        files[relative(folder, path).split(sep).join('/')] = createHash('sha256').update(await readFile(path)).digest('hex');
      }
    }
  };
  await walk(folder);
  return files;
}

async function copy(t: TestContext, name: string) {
  const work = await realpath(await mkdtemp(join(tmpdir(), 'imageflow-compat-')));
  t.after(() => rm(work, { recursive: true, force: true }));
  configureSourceStore(join(work, 'source-cache'));
  const folder = join(work, name);
  await cp(join(books, name), folder, { recursive: true });
  return { folder, cache: join(work, 'cache') };
}

const names = await readdir(books);

test('there is a compatibility book for every built-in starter', async () => {
  const starters = JSON.parse(await readFile(resolve('sample/starters.json'), 'utf8')) as { folder: string }[];
  assert.deepEqual([...names].sort(), starters.map(({ folder }) => folder).sort());
  // scripts/smoke-compat-books.mjs renders and exports each of them against these expectations.
  const expected = JSON.parse(await readFile(resolve('tests/compat/expected.json'), 'utf8')) as Record<string, unknown>;
  assert.deepEqual(Object.keys(expected).sort(), [...names].sort());
});

for (const name of names) {
  test(name + ' compatibility book opens with every source and its template, and opening it changes no file', async (t) => {
    const { folder, cache } = await copy(t, name);
    const before = await contents(folder);
    const book = await loadProject(folder, cache);
    // Books without page states stay in format 1, which every released version reads.
    assert.equal(book.project.schemaVersion, 1);
    assert.deepEqual(book.problems, []);
    assert.ok(book.project.spreads.length > 0);
    // Every registered source resolved.
    assert.equal(book.photos.size, Object.keys(book.photoIndex).length);
    assert.deepEqual(Object.keys(book.texts).sort(), Object.keys(book.project.texts).sort());
    assert.deepEqual(Object.entries(book.files).filter(([, file]) => file.problem), []);
    // The book's own template copy still bundles, and still has the hash the book recorded when it was made.
    assert.ok(book.assets.files.get('template.js')?.length);
    assert.deepEqual(book.assets.warnings ?? [], []);
    assert.equal(book.templateHash, book.project.template.hash);
    assert.deepEqual(await contents(folder), before);
  });
}

test('a book saved in a newer book format asks for an ImageFlow update and is left unchanged', async (t) => {
  const { folder, cache } = await copy(t, names[0]);
  const file = join(folder, 'project.json');
  const project = JSON.parse(await readFile(file, 'utf8'));
  await writeFile(file, JSON.stringify({ ...project, schemaVersion: bookFormatVersion + 1, futureField: true }, null, 2) + '\n');
  const before = await contents(folder);
  await assert.rejects(loadProject(folder, cache), (error: Error) => {
    assert.match(error.message, /saved by a newer version of ImageFlow/);
    assert.match(error.message, /Update ImageFlow/);
    assert.doesNotMatch(error.message, /schemaVersion/);
    return true;
  });
  assert.deepEqual(await contents(folder), before);
  // Validation elsewhere (saves, revisions) gives the same guidance.
  const parsed = projectSchema.safeParse({ ...project, schemaVersion: bookFormatVersion + 1 });
  assert.equal(parsed.success, false);
  assert.match(parsed.error!.issues[0].message, /Update ImageFlow/);
  // An older or malformed version is not mistaken for a newer book.
  assert.doesNotMatch(projectSchema.safeParse({ ...project, schemaVersion: 0 }).error!.issues[0].message, /newer/);
});
