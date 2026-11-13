import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { build } from 'esbuild';
import { readDependencyManifest, rebuildDependencies, templateImports } from '../desktop/dependencies';
import { bundleTemplate } from '../desktop/project';
import { checkTemplateTypes } from '../desktop/typecheck';

// npm dependencies of templates (ADR 0006): an explicit rebuild saves them into template/vendor/, and books use only
// that saved bundle, for rendering and type checking alike.

const template = `import { defineTemplate } from 'imageflow';
import tiny, { double } from 'tiny-lib';
import 'tiny-lib/tiny.css';
import untyped from 'untyped-lib';
export const value: number = double(tiny) + untyped.answer;
export default defineTemplate({ id: 'deps', version: '1', contract: 1, spreads: {} } as never);
`;

async function writePackages(root: string, version = '1.0.0', factor = 2) {
  const modules = join(root, 'node_modules');
  await mkdir(join(modules, 'tiny-lib'), { recursive: true });
  await writeFile(join(modules, 'tiny-lib/package.json'), JSON.stringify({ name: 'tiny-lib', version, type: 'module', main: 'index.js', types: 'index.d.ts' }));
  await writeFile(join(modules, 'tiny-lib/index.js'), `import { useState } from 'react';\nexport const hook = useState;\nexport const double = (n) => n * ${factor};\nexport default 21;\n`);
  await writeFile(join(modules, 'tiny-lib/index.d.ts'), `import type { Helper } from './helper';\nexport declare const double: Helper;\ndeclare const value: number;\nexport default value;\n`);
  await writeFile(join(modules, 'tiny-lib/helper.d.ts'), 'export type Helper = (n: number) => number;\n');
  await writeFile(join(modules, 'tiny-lib/tiny.css'), '.tiny { color: rgb(1, 2, 3); }\n');
  await writeFile(join(modules, 'tiny-lib/LICENSE'), 'MIT License, tiny-lib authors\n');
  await mkdir(join(modules, 'untyped-lib'), { recursive: true });
  await writeFile(join(modules, 'untyped-lib/package.json'), JSON.stringify({ name: 'untyped-lib', version: '0.3.0', main: 'index.js', license: 'ISC' }));
  await writeFile(join(modules, 'untyped-lib/index.js'), 'module.exports = { answer: 42 };\n');
}

async function fixture(t: TestContext) {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'imageflow-deps-')));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const root = join(folder, 'template');
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'index.tsx'), template);
  await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: { 'tiny-lib': '1.0.0', 'untyped-lib': '0.3.0' } }));
  await writeFile(join(root, 'package-lock.json'), '{"lockfileVersion":3,"v":1}');
  await writeFile(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, paths: { imageflow: ['./types/imageflow.d.ts'] } } }));
  await writePackages(root);
  return { folder, root };
}

test('the rebuild saves bundled modules, CSS, versions, licences and declarations, and books use only that bundle', async (t) => {
  const { folder, root } = await fixture(t);
  assert.deepEqual(await templateImports(root), ['tiny-lib', 'tiny-lib/tiny.css', 'untyped-lib']);
  // Before a rebuild, installed packages are not used.
  await assert.rejects(bundleTemplate(folder), /tiny-lib, which is not in its saved dependency bundle/);

  const manifest = await rebuildDependencies(root);
  assert.ok(manifest);
  assert.deepEqual(manifest.packages, { 'tiny-lib': '1.0.0', 'untyped-lib': '0.3.0' });
  assert.deepEqual(manifest.modules['tiny-lib'].exports, ['default', 'double', 'hook']);
  assert.ok(manifest.modules['tiny-lib/tiny.css'].css);
  assert.deepEqual(manifest.untyped, ['untyped-lib']);
  assert.equal(manifest.licenses['tiny-lib'], 'LICENSES/tiny-lib.txt');
  assert.equal(manifest.licenses['untyped-lib'], 'ISC');
  assert.match(await readFile(join(root, 'vendor/LICENSES/tiny-lib.txt'), 'utf8'), /tiny-lib authors/);
  assert.equal(await readFile(join(root, 'vendor/types/node_modules/tiny-lib/helper.d.ts'), 'utf8'), 'export type Helper = (n: number) => number;\n');
  const tsconfig = JSON.parse(await readFile(join(root, 'tsconfig.json'), 'utf8'));
  assert.deepEqual(tsconfig.compilerOptions.paths['*'], ['./vendor/types/node_modules/*', './vendor/types/node_modules/@types/*']);
  assert.equal(tsconfig.compilerOptions.paths.imageflow[0], './types/imageflow.d.ts');
  assert.deepEqual(tsconfig.exclude, ['node_modules', 'vendor']);

  const bundled = async () => {
    const assets = await bundleTemplate(folder);
    return { js: Buffer.from(assets.files.get('template.js')!).toString(), css: Buffer.from(assets.files.get('template.css') ?? []).toString(), assets };
  };
  const first = await bundled();
  // React comes from the host, with its hooks; the dependency's code and CSS are inside the template bundle.
  assert.match(first.js, /globalThis\.ImageFlowReact/);
  assert.match(first.js, /\* 2;/);
  assert.match(first.css, /\.tiny \{\s*color: #010203;/);
  assert.equal(first.assets.warnings?.length, 1, 'untyped dependencies are reported');

  // Changed installed packages do not change the book until the next rebuild; the check warns instead.
  await writePackages(root, '1.1.0', 3);
  await writeFile(join(root, 'package-lock.json'), '{"lockfileVersion":3,"v":2}');
  const stale = await bundled();
  assert.match(stale.js, /\* 2;/);
  assert.match(stale.assets.warnings![0], /package-lock\.json changed/);
  // Nor does removing them.
  await rm(join(root, 'node_modules'), { recursive: true });
  assert.match((await bundled()).js, /\* 2;/);

  // A template without packages has no vendor folder.
  await writeFile(join(root, 'index.tsx'), `import { defineTemplate } from 'imageflow';\nexport default defineTemplate({ id: 'deps', version: '1', contract: 1, spreads: {} } as never);\n`);
  assert.equal(await rebuildDependencies(root), undefined);
  assert.equal(await readDependencyManifest(root), undefined);
});

test('React and imageflow cannot be bundled, and a rebuild needs installed packages', async (t) => {
  const { root } = await fixture(t);
  await writeFile(join(root, 'index.tsx'), `import { createRoot } from 'react-dom/client';\nexport const root = createRoot;\n`);
  await assert.rejects(rebuildDependencies(root), /ImageFlow provides React and imageflow/);
  await writeFile(join(root, 'index.tsx'), template);
  await rm(join(root, 'node_modules'), { recursive: true });
  await assert.rejects(rebuildDependencies(root), /node_modules is missing\. Run npm install/);
});

test('the type check resolves packages from the saved declarations, without node_modules', async (t) => {
  const { folder, root } = await fixture(t);
  await rebuildDependencies(root);
  await rm(join(root, 'node_modules'), { recursive: true });
  const runtime = join(folder, '..', 'runtime-' + Date.now());
  t.after(() => rm(runtime, { recursive: true, force: true }));
  await mkdir(runtime);
  await cp(resolve('sample/starter/template/types'), join(runtime, 'authoring-types'), { recursive: true });
  await cp(resolve('authoring'), join(runtime, 'authoring-types'), { recursive: true });
  await cp(resolve('node_modules/@types/react'), join(runtime, 'authoring-types/react-runtime'), { recursive: true });
  await cp(resolve('node_modules/csstype'), join(runtime, 'authoring-types/csstype'), { recursive: true });
  await symlink(resolve('node_modules'), join(runtime, 'node_modules'));
  await build({ entryPoints: ['desktop/typecheck-worker.ts'], outfile: join(runtime, 'typecheck-worker.cjs'),
    bundle: true, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent' });
  const check = () => checkTemplateTypes(folder, new AbortController().signal, runtime, 15_000);
  assert.deepEqual((await check()).diagnostics, []);
  // A wrong use of a vendored type is reported in template code.
  await writeFile(join(root, 'index.tsx'), template.replace('double(tiny)', "double('tiny')"));
  const result = await check();
  assert.equal(result.diagnostics.length, 1, JSON.stringify(result.diagnostics));
  assert.equal(result.diagnostics[0].location?.path, 'template/index.tsx');
  assert.ok(!result.files.some((path) => path.includes('vendor')));
});
