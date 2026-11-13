import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TemplateInfo } from '../src/desktop';
import { mm, printFormat } from '../src/format';
import { compareVersions, TemplateImportError, TemplateLibrary, templateFiles, templateHash } from '../desktop/template-library';

const format = printFormat({ label: 'Square', trim: { width: mm(200), height: mm(200) }, bleed: mm(3), safe: mm(10),
  pageCount: { min: 2, max: 20, step: 2 } });
// Stands in for loading the template in the renderer: reads `id`, `version` and `label` from index.tsx.
async function validate(folder: string): Promise<TemplateInfo> {
  const source = await readFile(join(folder, 'index.tsx'), 'utf8');
  if (source.includes('BROKEN')) throw new TemplateImportError('Template → spreads: Declare a spread.', ['spreads: Declare a spread.']);
  const field = (name: string) => new RegExp(name + ": '([^']*)'").exec(source)?.[1];
  return { id: field('id'), version: field('version')!, label: field('label'), parameters: {}, format, formatId: 'default', formats: {},
    spreads: { story: { label: 'Story', span: 'spread', parameters: {}, boxes: {}, elements: {} } },
    openingSpreads: [{ layout: 'story', params: {} }] };
}
async function template(root: string, name: string, fields: { id: string; version: string; label?: string; extra?: string }) {
  const folder = join(root, name);
  await mkdir(join(folder, 'fonts'), { recursive: true });
  await writeFile(join(folder, 'index.tsx'), `export default { id: '${fields.id}', version: '${fields.version}', ` +
    (fields.label ? `label: '${fields.label}', ` : '') + `}; // ${fields.extra ?? ''}`);
  await writeFile(join(folder, 'fonts', 'a.woff2'), 'font');
  return folder;
}
async function setup() {
  const work = await mkdtemp(join(tmpdir(), 'imageflow-library-'));
  const trashed: string[] = [];
  const builtIn = await template(work, 'builtin', { id: 'starter', version: '1.0.0', label: 'Photobook' });
  const library = new TemplateLibrary(join(work, 'Templates'), [{ template: builtIn, sample: join(work, 'sample'), defaultName: 'Untitled Photobook' }],
    validate, async (path) => { trashed.push(path); await rm(path, { recursive: true }); }, 'caps-1');
  return { work, trashed, library, done: () => rm(work, { recursive: true, force: true }) };
}
const yes = async () => true;
const no = async () => false;

test('template files leave out dotfiles and node_modules, refuse links, and hash the same wherever copied', async () => {
  const { work, done } = await setup();
  try {
    const folder = await template(work, 'one', { id: 'travel', version: '1' });
    await mkdir(join(folder, '.imageflow'));
    await writeFile(join(folder, '.imageflow', 'cache'), 'x');
    await writeFile(join(folder, '.DS_Store'), 'x');
    await mkdir(join(folder, 'node_modules', 'dep'), { recursive: true });
    await writeFile(join(folder, 'node_modules', 'dep', 'index.js'), 'x');
    assert.deepEqual(await templateFiles(folder), ['fonts/a.woff2', 'index.tsx']);
    const copy = await template(work, 'two', { id: 'travel', version: '1' });
    assert.equal(await templateHash(folder), await templateHash(copy));
    await writeFile(join(copy, 'fonts', 'a.woff2'), 'other');
    assert.notEqual(await templateHash(folder), await templateHash(copy));
    await symlink(join(work, 'builtin', 'index.tsx'), join(folder, 'linked.tsx'));
    await assert.rejects(templateFiles(folder), /linked\.tsx is a symbolic link/);
    await assert.rejects(templateFiles(join(work, 'builtin', 'fonts')), /no index\.tsx/);
  } finally { await done(); }
});

test('versions compare as numbers', () => {
  assert.equal(compareVersions('1.10.0', '1.9.2'), 1);
  assert.equal(compareVersions('2.0', '2.0.0'), 0);
  assert.equal(compareVersions('0.4.0', '0.5.0'), -1);
});

test('the library lists built-ins, imports a template once, and replaces it with a newer version', async () => {
  const { work, trashed, library, done } = await setup();
  try {
    let changes = 0;
    library.onChange(() => changes++);
    const [builtIn] = await library.list();
    assert.equal(builtIn.source, 'built-in');
    assert.equal(builtIn.label, 'Photobook');
    assert.equal(builtIn.sample, true);
    assert.equal(builtIn.openingSpreads, 1);

    const v1 = await template(work, 'travel-1', { id: 'travel', version: '1.0.0', label: 'Travel' });
    assert.equal((await library.import(v1, no)).status, 'imported');
    assert.equal((await library.import(v1, no)).status, 'unchanged', 'the same files import once');
    let listed = await library.list();
    assert.deepEqual(listed.map(({ id, source }) => id + ':' + source), ['starter:built-in', 'travel:imported']);
    assert.equal(listed[1].importedFrom, v1);
    // The library keeps its own copy: changing the source does not change the entry.
    await writeFile(join(v1, 'index.tsx'), "export default { id: 'travel', version: '1.0.0', label: 'Edited' };");
    assert.equal((await library.list())[1].label, 'Travel');

    const v2 = await template(work, 'travel-2', { id: 'travel', version: '1.1.0', label: 'Travel' });
    assert.equal((await library.import(v2, no)).status, 'replaced', 'a newer version needs no confirmation');
    listed = await library.list();
    assert.deepEqual(listed.map(({ id, version }) => id + '@' + version), ['starter@1.0.0', 'travel@1.1.0']);
    assert.equal(trashed.length, 1, 'the replaced entry went to the Trash');
    assert.equal(changes, 2);
    assert.deepEqual((await readdir(join(work, 'Templates'))).sort(), ['travel'], 'no staging folders are left');
  } finally { await done(); }
});

test('an older version, or the same version with other files, asks before replacing', async () => {
  const { work, library, done } = await setup();
  try {
    await library.import(await template(work, 'new', { id: 'travel', version: '2.0.0' }), no);
    const older = await template(work, 'old', { id: 'travel', version: '1.0.0' });
    const asked: string[] = [];
    const answer = (value: boolean) => async (plan: { kind: string }) => { asked.push(plan.kind); return value; };
    assert.equal((await library.import(older, answer(false))).status, 'cancelled');
    assert.equal((await library.list())[1].version, '2.0.0');
    const changed = await template(work, 'changed', { id: 'travel', version: '2.0.0', extra: 'edited' });
    assert.equal((await library.import(changed, answer(true))).status, 'replaced');
    assert.deepEqual(asked, ['older', 'changed']);
    // A template with a built-in's ID asks the same way, and then replaces the built-in in the list.
    const starter = await template(work, 'starter', { id: 'starter', version: '0.9.0', label: 'My photobook' });
    assert.equal((await library.import(starter, yes)).status, 'imported');
    const listed = await library.list();
    assert.deepEqual(listed.map(({ id, source, replacesBuiltIn }) => [id, source, !!replacesBuiltIn]),
      [['starter', 'imported', true], ['travel', 'imported', false]]);
    // Removing it brings the built-in back; built-ins cannot be removed.
    await library.remove('starter');
    assert.equal((await library.list())[0].source, 'built-in');
    await assert.rejects(library.remove('starter'), /Built-in templates cannot be removed/);
  } finally { await done(); }
});

test('a template that fails to load is not imported and leaves nothing behind', async () => {
  const { work, library, done } = await setup();
  try {
    const broken = await template(work, 'broken', { id: 'broken', version: '1', extra: 'BROKEN' });
    const result = await library.import(broken, yes);
    assert.equal(result.status, 'failed');
    assert.match(result.message!, /Declare a spread/);
    assert.deepEqual(result.details, ['spreads: Declare a spread.']);
    assert.equal(await readdir(join(work, 'Templates')).catch(() => []).then((names) => names.length), 0);
  } finally { await done(); }
});

test('a missing or outdated cache is rebuilt from the source, and an entry this app cannot use is listed with the reason', async () => {
  const { work, library, done } = await setup();
  try {
    await library.import(await template(work, 'travel', { id: 'travel', version: '1.0.0', label: 'Travel' }), no);
    await rm(join(work, 'Templates', 'travel', 'library.json'));
    assert.equal((await library.list())[1].label, 'Travel');
    const metadata = JSON.parse(await readFile(join(work, 'Templates', 'travel', 'library.json'), 'utf8'));
    assert.equal(metadata.capabilities, 'caps-1');
    // A newer app with other capabilities checks the entry again: here it no longer loads.
    await writeFile(join(work, 'Templates', 'travel', 'template', 'index.tsx'), "export default { id: 'travel', version: '1.0.0' }; // BROKEN");
    const later = new TemplateLibrary(join(work, 'Templates'), [], validate, async () => {}, 'caps-2');
    const [entry] = await later.list();
    assert.equal(entry.id, 'travel');
    assert.match(entry.unavailable!, /Declare a spread/);
    await assert.rejects(later.resolve('travel'), /Declare a spread/);
  } finally { await done(); }
});

test('resolve returns the source folder, declarations and, for a built-in, its sample book', async () => {
  const { work, library, done } = await setup();
  try {
    const starter = await library.resolve('starter');
    assert.equal(starter.folder, join(work, 'builtin'));
    assert.equal(starter.sample, join(work, 'sample'));
    assert.equal(starter.defaultName, 'Untitled Photobook');
    await library.import(await template(work, 'travel', { id: 'travel', version: '1.0.0' }), no);
    const travel = await library.resolve('travel');
    assert.equal(travel.folder, join(work, 'Templates', 'travel', 'template'));
    assert.equal(travel.sample, undefined);
    await assert.rejects(library.resolve('missing'), /no longer in the library/);
  } finally { await done(); }
});

test('a book is made from one snapshot: an import waits until the template has been copied', async () => {
  const { work, library, done } = await setup();
  try {
    await library.import(await template(work, 'v1', { id: 'travel', version: '1.0.0' }), no);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const copied = library.withTemplate('travel', async ({ entry, folder }) => {
      await gate;
      return { version: entry.version, source: await readFile(join(folder, 'index.tsx'), 'utf8') };
    });
    const replacing = library.import(await template(work, 'v2', { id: 'travel', version: '2.0.0' }), no);
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    const snapshot = await copied;
    assert.equal(snapshot.version, '1.0.0');
    assert.match(snapshot.source, /version: '1\.0\.0'/, 'the files match the version');
    assert.equal((await replacing).status, 'replaced');
    assert.equal((await library.withTemplate('travel', async ({ entry }) => entry.version)), '2.0.0');
  } finally { await done(); }
});

test('imports are reviewed with their packages and network sites, and a declined review imports nothing', async () => {
  const { work, library, done } = await setup();
  try {
    const folder = await template(work, 'maps', { id: 'maps', version: '1.0.0', label: 'Maps' });
    await mkdir(join(folder, 'vendor'), { recursive: true });
    await writeFile(join(folder, 'vendor', 'manifest.json'), JSON.stringify({ version: 1, lockfile: '', packages: { 'map-lib': '2.1.0', 'b-lib': '1.0.0' },
      modules: {}, untyped: [], licenses: { 'map-lib': 'LICENSES/map-lib.txt', 'b-lib': 'MIT' }, licenseNames: { 'map-lib': 'BSD-3-Clause' } }));
    const seen: { kind: string; packages: unknown; hash: string }[] = [];
    const review = (answer: boolean) => async (plan: Parameters<Parameters<TemplateLibrary['import']>[2] & {}>[0]) => {
      seen.push({ kind: plan.kind, packages: plan.packages, hash: plan.hash });
      return answer;
    };
    assert.equal((await library.import(folder, no, review(false))).status, 'cancelled');
    assert.deepEqual(await readdir(join(work, 'Templates')).catch(() => []), []);
    assert.equal((await library.import(folder, no, review(true))).status, 'imported');
    assert.deepEqual(seen.map(({ kind }) => kind), ['new', 'new']);
    assert.deepEqual(seen[0].packages, [{ name: 'b-lib', version: '1.0.0', license: 'MIT' }, { name: 'map-lib', version: '2.1.0', license: 'BSD-3-Clause' }]);
    const entry = (await library.list()).find(({ id }) => id === 'maps')!;
    assert.deepEqual(entry.packages, seen[0].packages);
    assert.equal(entry.hash, seen[0].hash);
    // The same files again change nothing, so there is nothing to review.
    assert.equal((await library.import(folder, no, review(true))).status, 'unchanged');
    assert.equal(seen.length, 2);
    assert.equal(await library.isBuiltIn(entry.hash), false);
    assert.equal(await library.isBuiltIn((await library.list())[0].hash), true);
  } finally { await done(); }
});
