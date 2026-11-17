import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { DependencyInstallError, findNpm, rebuildTemplateDependencies } from '../desktop/dependency-install';
import { readDependencyManifest } from '../desktop/dependencies';

// A template's packages are installed outside its book, in an app-managed cache (ADR 0006): the book keeps only the
// saved bundle in template/vendor/. These tests use the npm on this machine and a local `file:` package, so they need
// no network.

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'imageflow-install-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const library = join(root, 'tiny-local');
  await mkdir(library);
  await writeFile(join(library, 'package.json'), JSON.stringify({ name: 'tiny-local', version: '1.2.3', type: 'module',
    main: 'index.js', types: 'index.d.ts', license: 'MIT' }));
  await writeFile(join(library, 'index.js'), 'export const double = (value) => value * 2 + 0.5;\n');
  await writeFile(join(library, 'index.d.ts'), 'export declare const double: (value: number) => number;\n');
  const template = join(root, 'book.imageflow', 'template');
  await mkdir(template, { recursive: true });
  await writeFile(join(template, 'index.tsx'), "import { double } from 'tiny-local';\nexport const value = double(2);\n");
  await writeFile(join(template, 'package.json'), JSON.stringify({ private: true, dependencies: { 'tiny-local': 'file:../../tiny-local' } }));
  return { root, template, cache: join(root, 'cache') };
}

test('packages install outside the book, a stale template/node_modules is ignored, and a second rebuild reuses the install', async (t) => {
  if (!await findNpm()) { t.skip('npm is not installed'); return; }
  const { template, cache } = await fixture(t);
  // A leftover install in the template with different code: the rebuild must not bundle it.
  await mkdir(join(template, 'node_modules', 'tiny-local'), { recursive: true });
  await writeFile(join(template, 'node_modules', 'tiny-local', 'package.json'), JSON.stringify({ name: 'tiny-local', version: '0.0.1', main: 'index.js' }));
  await writeFile(join(template, 'node_modules', 'tiny-local', 'index.js'), 'export const double = () => "stale";\n');

  const first = await rebuildTemplateDependencies(template, cache);
  assert.equal(first.reused, false);
  assert.equal(first.lockfileUpdated, false, 'a lockfile with linked folders is not written back from the cache');
  assert.equal(first.leftoverNodeModules, true);
  const manifest = await readDependencyManifest(template);
  assert.ok(manifest?.modules['tiny-local']?.js);
  const bundle = await readFile(join(template, 'vendor', manifest!.modules['tiny-local'].js!), 'utf8');
  assert.match(bundle, /\.5/, 'the bundle holds the linked package');
  assert.doesNotMatch(bundle, /stale/, 'the template’s own node_modules was not used');
  assert.equal(manifest!.types?.['tiny-local'], 'types/packages/tiny-local/index.d.ts', 'declarations come from the install');

  const [install] = (await readdir(cache)).filter((name) => !name.endsWith('.tmp'));
  const installed = JSON.parse(await readFile(join(cache, install, 'template', 'package.json'), 'utf8'));
  assert.match(installed.dependencies['tiny-local'], /^file:\/.*tiny-local$/, 'file: paths point at the same folder, absolutely');
  await assert.rejects(stat(join(template, 'package-lock.json')), 'nothing but vendor/ changed in the template');

  const second = await rebuildTemplateDependencies(template, cache);
  assert.equal(second.reused, true);
});

test('a template that imports packages needs a package.json; one without imports needs no install', async (t) => {
  const { template, cache } = await fixture(t);
  await rm(join(template, 'package.json'));
  await assert.rejects(rebuildTemplateDependencies(template, cache),
    (error: unknown) => error instanceof DependencyInstallError && error.code === 'package-invalid' && /no package\.json/.test(error.message));
  await writeFile(join(template, 'index.tsx'), 'export const value = 4;\n');
  const result = await rebuildTemplateDependencies(template, cache);
  assert.deepEqual(result.packages, {});
  await assert.rejects(stat(cache), 'nothing was installed');
});

test('an explicit rebuild refreshes book-local SDK and skill even without npm dependencies', async (t) => {
  const { root, template, cache } = await fixture(t);
  await writeFile(join(template, 'index.tsx'), 'export const value = 4;\n');
  const types = join(root, 'installed-types'), skills = join(root, 'installed-skills');
  await mkdir(types);
  await mkdir(join(skills, 'imageflow-templates', 'references'), { recursive: true });
  await writeFile(join(types, 'imageflow.d.ts'), '// Current SDK');
  await writeFile(join(skills, 'imageflow-templates', 'SKILL.md'), 'Current skill');
  const localSkill = join(root, 'book.imageflow', '.claude', 'skills', 'imageflow-templates');
  await mkdir(localSkill, { recursive: true });
  await writeFile(join(localSkill, 'obsolete.md'), 'Stale reference');
  await rebuildTemplateDependencies(template, cache, { authoringTypes: types, authoringSkills: skills });
  assert.equal(await readFile(join(template, '.imageflow-sdk', 'imageflow.d.ts'), 'utf8'), '// Current SDK');
  assert.equal(await readFile(join(localSkill, 'SKILL.md'), 'utf8'), 'Current skill');
  await assert.rejects(stat(join(localSkill, 'obsolete.md')));
  assert.equal(await readFile(join(template, 'index.tsx'), 'utf8'), 'export const value = 4;\n');
});
