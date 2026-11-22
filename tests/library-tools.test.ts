import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TemplateInfo } from '../src/desktop';
import { mm, printFormat } from '../src/format';
import { TemplateImportError, TemplateLibrary } from '../desktop/template-library';
import { agentLibraryEntry, readLibraryTemplate, saveTemplateToLibrary } from '../desktop/library-tools';
import { AuthoringError } from '../desktop/authoring-service';
import { mcpOutputSchemas } from '../src/mcp-contract';

const format = printFormat({ label: 'Square', trim: { width: mm(200), height: mm(200) }, bleed: mm(3), safe: mm(10),
  pageCount: { min: 2, max: 20, step: 2 } });
// Stands in for loading the template in the renderer: reads `id`, `version` and `network` from index.tsx.
async function validate(folder: string): Promise<TemplateInfo> {
  const source = await readFile(join(folder, 'index.tsx'), 'utf8');
  if (source.includes('BROKEN')) throw new TemplateImportError('Template → spreads: Declare a spread.', ['spreads: Declare a spread.']);
  const field = (name: string) => new RegExp(name + ": '([^']*)'").exec(source)?.[1];
  const network = field('network');
  return { id: field('id'), version: field('version')!, label: field('label'), ...(network ? { network: [network] } : {}),
    parameters: {}, format, formatId: 'default', formats: {},
    spreads: { story: { label: 'Story', span: 'spread', parameters: {}, boxes: {}, elements: {} } },
    openingSpreads: [{ layout: 'story', params: {} }] };
}
async function template(folder: string, fields: { id: string; version: string; extra?: string; network?: string }) {
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'index.tsx'), `export default { id: '${fields.id}', version: '${fields.version}', ` +
    (fields.network ? `network: '${fields.network}', ` : '') + `}; // ${fields.extra ?? ''}`);
  return folder;
}
async function setup() {
  const work = await mkdtemp(join(tmpdir(), 'imageflow-library-tools-'));
  const builtIn = await template(join(work, 'builtin'), { id: 'starter', version: '1.0.0' });
  const library = new TemplateLibrary(join(work, 'Templates'), [{ template: builtIn }], validate,
    async (path) => { await rm(path, { recursive: true }); }, 'caps-1');
  return { work, library, book: join(work, 'book', 'template'), done: () => rm(work, { recursive: true, force: true }) };
}
const signal = new AbortController().signal;
const save = (library: TemplateLibrary, folder: string, replaceHash?: string) => {
  const result = saveTemplateToLibrary(library, folder, replaceHash, signal);
  // Every result matches the advertised output schema.
  return result.then((value) => { assert.ok(mcpOutputSchemas.save_template_to_library.safeParse(value).success, JSON.stringify(value)); return value; });
};

test('list entries leave out local paths and match the advertised schema', async () => {
  const { library, book, done } = await setup();
  try {
    await template(book, { id: 'travel', version: '1' });
    await save(library, book);
    const listed = (await library.list()).map(agentLibraryEntry);
    assert.deepEqual(listed.map(({ id, source }) => [id, source]), [['starter', 'built-in'], ['travel', 'imported']]);
    assert.ok(listed.every((entry) => !('importedFrom' in entry) && !('render' in entry)));
    assert.ok(mcpOutputSchemas.list_templates.safeParse({ templates: listed }).success);
  } finally { await done(); }
});

test('a new ID and a newer version save at once; the same files are unchanged', async () => {
  const { library, book, done } = await setup();
  try {
    await template(book, { id: 'travel', version: '1', network: 'https://tiles.example.com' });
    const first = await save(library, book);
    assert.equal(first.status, 'saved');
    assert.match(String('notice' in first && first.notice), /does not allow the sites/);
    assert.equal((await save(library, book)).status, 'unchanged');
    await template(book, { id: 'travel', version: '2' });
    const second = await save(library, book);
    assert.equal(second.status, 'replaced');
    assert.equal('replaced' in second && second.replaced?.version, '1');
    assert.deepEqual((await library.list()).filter(({ id }) => id === 'travel').map(({ version }) => version), ['2']);
  } finally { await done(); }
});

test('other files under the same version, an older version and a built-in ID conflict until replaceHash names the entry', async () => {
  const { library, book, done } = await setup();
  try {
    await template(book, { id: 'travel', version: '2' });
    await save(library, book);
    const current = (await library.list()).find(({ id }) => id === 'travel')!;

    await template(book, { id: 'travel', version: '2', extra: 'edited' });
    const changed = await save(library, book);
    assert.equal(changed.status, 'conflict');
    assert.equal('reason' in changed && changed.reason, 'changed');
    assert.equal('current' in changed && changed.current?.hash, current.hash);

    await template(book, { id: 'travel', version: '1' });
    const older = await save(library, book);
    assert.equal('reason' in older && older.reason, 'older');
    assert.equal((await library.list()).find(({ id }) => id === 'travel')!.hash, current.hash, 'nothing was saved');

    const stale = await save(library, book, 'f'.repeat(64));
    assert.equal('reason' in stale && stale.reason, 'replaced-meanwhile');
    assert.equal((await save(library, book, current.hash)).status, 'replaced');
    assert.equal((await library.list()).find(({ id }) => id === 'travel')!.version, '1');

    await template(book, { id: 'starter', version: '9' });
    const builtIn = await save(library, book);
    assert.equal('reason' in builtIn && builtIn.reason, 'built-in');
    const starter = (await library.list()).find(({ id }) => id === 'starter')!;
    assert.equal(starter.source, 'built-in');
    assert.equal((await save(library, book, starter.hash)).status, 'replaced');
    assert.equal((await library.list()).find(({ id }) => id === 'starter')!.replacesBuiltIn, true);
  } finally { await done(); }
});

test('a newer version still rejects a stale replaceHash', async () => {
  const { library, book, done } = await setup();
  try {
    await template(book, { id: 'travel', version: '1' });
    await save(library, book);
    const current = (await library.list()).find(({ id }) => id === 'travel')!;
    await template(book, { id: 'travel', version: '2' });
    const stale = await save(library, book, 'f'.repeat(64));
    assert.equal(stale.status, 'conflict');
    assert.equal('reason' in stale && stale.reason, 'replaced-meanwhile');
    assert.equal('current' in stale && stale.current?.hash, current.hash);
    assert.equal((await library.list()).find(({ id }) => id === 'travel')!.hash, current.hash);
    assert.equal((await save(library, book, current.hash)).status, 'replaced');
  } finally { await done(); }
});

test('concurrent saves reconsider conflicts against the entry that actually won', async () => {
  // Cover both a new ID and upgrades, with and without explicit permission to replace the original entry.
  for (const mode of ['new', 'upgrade', 'replace'] as const) {
    const { library, book, work, done } = await setup();
    try {
      let replaceHash: string | undefined;
      if (mode !== 'new') {
        await template(book, { id: 'travel', version: '1' });
        await save(library, book);
        if (mode === 'replace') replaceHash = (await library.list()).find(({ id }) => id === 'travel')!.hash;
      }
      await template(book, { id: 'travel', version: '2', extra: 'first book' });
      const other = await template(join(work, 'other'), { id: 'travel', version: '2', extra: 'second book' });
      // Both requests finish planning against the same entry before either can proceed to commit.
      const plan = library.plan.bind(library);
      let planned = 0;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      library.plan = async (folder) => {
        const result = await plan(folder);
        if (++planned === 2) release();
        await gate;
        return result;
      };
      const results = await Promise.all([save(library, book, replaceHash), save(library, other, replaceHash)]);
      const winner = results.find((result) => result.status === (mode === 'new' ? 'saved' : 'replaced'))!;
      const loser = results.find((result) => result.status === 'conflict')!;
      assert.ok(winner, mode);
      assert.ok(loser, mode);
      assert.equal('reason' in loser && loser.reason, mode === 'replace' ? 'replaced-meanwhile' : 'changed');
      assert.equal('current' in loser && loser.current?.hash, winner.template.hash);
      assert.equal((await library.list()).find(({ id }) => id === 'travel')!.hash, winner.template.hash);
    } finally { await done(); }
  }
});

test('a template that fails to load is an error with its diagnostics', async () => {
  const { library, book, done } = await setup();
  try {
    await template(book, { id: 'travel', version: '1', extra: 'BROKEN' });
    await assert.rejects(saveTemplateToLibrary(library, book, undefined, signal), (error: unknown) =>
      error instanceof AuthoringError && error.code === 'TEMPLATE_INVALID' && Array.isArray(error.details?.details));
  } finally { await done(); }
});

test('agents read a library template\'s files and compare them with a book\'s fork (API-002)', async () => {
  const { work, library, done } = await setup();
  try {
    const builtIn = join(work, 'builtin');
    await writeFile(join(builtIn, 'CHANGELOG.md'), '# Changes\n');
    await writeFile(join(builtIn, 'map.tsx'), 'export const map = 1;\n');
    await mkdir(join(builtIn, 'vendor', 'modules'), { recursive: true });
    await writeFile(join(builtIn, 'vendor', 'modules', 'a.js'), 'a');
    await writeFile(join(builtIn, 'vendor', 'modules', 'b.js'), 'b');
    // The fork: the same index.tsx, a changed map, a file of its own, and one vendored module rebuilt.
    const fork = join(work, 'book');
    await mkdir(join(fork, 'template', 'vendor', 'modules'), { recursive: true });
    await writeFile(join(fork, 'template', 'index.tsx'), await readFile(join(builtIn, 'index.tsx')));
    await writeFile(join(fork, 'template', 'map.tsx'), 'export const map = 2;\n');
    await writeFile(join(fork, 'template', 'quote.tsx'), 'export const quote = 1;\n');
    await writeFile(join(fork, 'template', 'vendor', 'modules', 'a.js'), 'a');
    await writeFile(join(fork, 'template', 'vendor', 'modules', 'b.js'), 'changed');
    const check = (value: Record<string, unknown>) => {
      assert.ok(mcpOutputSchemas.read_library_template.safeParse(value).success, JSON.stringify(value));
      return value;
    };
    const listed = check(await readLibraryTemplate(library, { template: 'starter' }));
    assert.deepEqual(listed.files, [{ path: 'CHANGELOG.md' }, { path: 'index.tsx' }, { path: 'map.tsx' }, { path: 'vendor/', files: 2 }]);
    assert.equal(listed.changelog, 'CHANGELOG.md');
    assert.equal((listed.template as { id: string }).id, 'starter');
    const compared = check(await readLibraryTemplate(library, { template: 'starter' }, fork));
    assert.deepEqual(compared.files, [
      { path: 'CHANGELOG.md', status: 'library-only' }, { path: 'index.tsx', status: 'same' }, { path: 'map.tsx', status: 'changed' },
      { path: 'quote.tsx', status: 'book-only' }, { path: 'vendor/', files: 2, status: 'changed' },
    ]);
    const read = check(await readLibraryTemplate(library, { template: 'starter', path: 'map.tsx' }));
    assert.equal(read.text, 'export const map = 1;\n');
    assert.equal(read.truncated, false);
    for (const [path, code] of [['../secret.ts', 'PATH_NOT_ALLOWED'], ['.hidden/a.ts', 'PATH_NOT_ALLOWED'], ['photo.jpg', 'SOURCE_TYPE_NOT_SUPPORTED'],
      ['missing.tsx', 'SOURCE_NOT_FOUND']] as const) {
      await assert.rejects(readLibraryTemplate(library, { template: 'starter', path }), (error) => error instanceof AuthoringError && error.code === code);
    }
    await assert.rejects(readLibraryTemplate(library, { template: 'nope' }),
      (error) => error instanceof AuthoringError && error.code === 'TEMPLATE_NOT_FOUND' && error.message.includes('starter'));
  } finally { await done(); }
});
