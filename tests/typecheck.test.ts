import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { build } from 'esbuild';
import { checkTemplateTypes } from '../desktop/typecheck';

async function fixture(t: TestContext) {
  const work = await realpath(await mkdtemp(join(tmpdir(), 'imageflow-types-')));
  t.after(() => rm(work, { recursive: true, force: true }));
  const runtime = join(work, 'runtime'), folder = join(work, 'book');
  await mkdir(join(folder, 'template'), { recursive: true });
  await mkdir(runtime);
  await cp(resolve('sample/starter/template/types'), join(runtime, 'authoring-types'), { recursive: true });
  await cp(resolve('authoring'), join(runtime, 'authoring-types'), { recursive: true });
  await cp(resolve('node_modules/@types/react'), join(runtime, 'authoring-types/react-runtime'), { recursive: true });
  await cp(resolve('node_modules/csstype'), join(runtime, 'authoring-types/csstype'), { recursive: true });
  await symlink(resolve('node_modules'), join(runtime, 'node_modules'));
  await build({ entryPoints: ['desktop/typecheck-worker.ts'], outfile: join(runtime, 'typecheck-worker.cjs'),
    bundle: true, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent' });
  const check = (signal = new AbortController().signal, timeout = 15_000) => checkTemplateTypes(folder, signal, runtime, timeout);
  return { work, folder, runtime, check, entry: join(folder, 'template/index.tsx') };
}

test('installed types check a standalone starter without project packages or trusted tsconfig', async (t) => {
  const { folder, check } = await fixture(t);
  await cp(resolve('sample/starter/template'), join(folder, 'template'), { recursive: true });
  await writeFile(join(folder, 'template/tsconfig.json'), '{ "extends": "/no/external/config.json", "compilerOptions": {"strict":false} }');
  const result = await check();
  assert.deepEqual(result.diagnostics, []);
  assert.ok(result.files.includes('template/index.tsx'));
  assert.ok(!result.files.includes('template/types/imageflow.d.ts'));
});

test('the calendar starter typechecks and ships the same authoring declarations as the photobook starter', async (t) => {
  const { folder, check } = await fixture(t);
  await cp(resolve('sample/calendar/template'), join(folder, 'template'), { recursive: true });
  assert.deepEqual((await check()).diagnostics, []);
  const types = await readdir(resolve('sample/starter/template/types'));
  assert.deepEqual(await readdir(resolve('sample/calendar/template/types')), types);
  for (const name of types) {
    assert.equal(await readFile(resolve('sample/calendar/template/types', name), 'utf8'), await readFile(resolve('sample/starter/template/types', name), 'utf8'), name);
  }
});

test('type errors retain exact locations while project declaration copies cannot replace installed modules', async (t) => {
  const { folder, entry, check } = await fixture(t);
  await mkdir(join(folder, 'template/types'));
  await writeFile(join(folder, 'template/types/imageflow.d.ts'), 'export const nonexistent: any;');
  await writeFile(entry, "import { mm, nonexistent } from 'imageflow';\nconst size: number = 'wrong';\nmm('wrong');\nexport default {};\n");
  const result = await check();
  assert.ok(result.diagnostics.some(({ location, details }) => location?.line === 2 && details?.typescriptCode === 2322));
  assert.ok(result.diagnostics.some(({ message }) => message.includes('nonexistent')));
  assert.ok(result.diagnostics.every(({ location }) => location?.path === 'template/index.tsx' && location.column! > 0));
  assert.equal(await readFile(entry, 'utf8'), "import { mm, nonexistent } from 'imageflow';\nconst size: number = 'wrong';\nmm('wrong');\nexport default {};\n");
});

test('JSON, text and explicit module imports accepted by the bundler also typecheck', async (t) => {
  const { folder, entry, check } = await fixture(t);
  const sources = {
    'data.json': '{"title":"Book"}', 'note.txt': 'Caption',
    'helper.mts': 'export const n: number = 1;', 'helper.cts': 'export const c: number = 2;',
    'script.mjs': 'export const m = 3;', 'script.cjs': 'exports.j = 4;',
    'tsconfig.json': '{ invalid editor config that must not be checked',
  };
  await Promise.all(Object.entries(sources).map(([name, source]) => writeFile(join(folder, 'template', name), source)));
  await writeFile(entry, "import data from './data.json'; import note from './note.txt'; import { n } from './helper.mts'; import { c } from './helper.cts'; import { m } from './script.mjs'; import { j } from './script.cjs';\nconst title: string = data.title; const caption: string = note; export default {title, caption, n, c, m, j};\n");
  await build({ entryPoints: [entry], bundle: true, write: false, format: 'esm', tsconfigRaw: {}, logLevel: 'silent' });
  const result = await check();
  assert.deepEqual(result.diagnostics, []);
  for (const name of ['data.json', 'helper.mts', 'helper.cts', 'script.mjs', 'script.cjs']) assert.ok(result.files.includes('template/' + name));
  assert.ok(!result.files.includes('template/tsconfig.json'));
  await writeFile(join(folder, 'template/helper.mts'), 'export const n: number = "wrong";');
  await writeFile(join(folder, 'template/data.json'), '{"title":123}');
  const errors = (await check()).diagnostics;
  assert.ok(errors.some(({ location, details }) => location?.path === 'template/helper.mts' && details?.typescriptCode === 2322));
  assert.ok(errors.some(({ location, details }) => location?.path === 'template/index.tsx' && details?.typescriptCode === 2322));
});

test('React default exposes runtime hooks while named exports match the template loader', async (t) => {
  const { entry, check } = await fixture(t);
  await writeFile(entry, "import React from 'react';\nexport function Editor() { const [value, setValue] = React.useState(1); React.useEffect(() => setValue(2), []); return <span>{value}</span>; }\n");
  assert.deepEqual((await check()).diagnostics, []);
  await writeFile(entry, "import { useState } from 'react';\nexport default useState;\n");
  assert.ok((await check()).diagnostics.some(({ message }) => message.includes('useState')));
});

test('typechecking does not follow external imports, triple-slash references or symlinks', async (t) => {
  const { work, folder, entry, check } = await fixture(t);
  await writeFile(join(work, 'outside.ts'), 'declare const secretOutside: string;');
  await writeFile(entry, '/// <reference path="../../outside.ts" />\nsecretOutside;\nexport default {};');
  const denied = await check();
  assert.ok(denied.diagnostics.some(({ message }) => message.includes('secretOutside')));
  await symlink(join(work, 'outside.ts'), join(folder, 'template/link.ts'));
  const linked = await check();
  assert.equal(linked.diagnostics[0].code, 'typescript-unavailable');
  assert.match(linked.diagnostics[0].message, /outside template/);
});

test('worker deadlines and cancellation terminate typechecking without a stale result', async (t) => {
  const { entry, check } = await fixture(t);
  await writeFile(entry, 'export default {};');
  const timed = await check(new AbortController().signal, 1);
  assert.equal(timed.diagnostics[0].code, 'typescript-timeout');
  const controller = new AbortController();
  const pending = check(controller.signal);
  controller.abort(new Error('cancelled check'));
  await assert.rejects(pending, /cancelled check/);
});

test('every shipped example template type-checks against the installed declarations', async (t) => {
  const { entry, check } = await fixture(t);
  const examples = (await readdir(resolve('docs/examples'))).filter((name) => name.endsWith('.tsx'));
  assert.ok(examples.length >= 6);
  for (const name of examples) {
    await writeFile(entry, await readFile(resolve('docs/examples', name), 'utf8'));
    assert.deepEqual((await check()).diagnostics, [], name);
  }
  // Layout-typed components and requires reject what the layout or the app does not have.
  const minimal = await readFile(resolve('docs/examples/minimal.tsx'), 'utf8');
  await writeFile(entry, minimal.replace('<ctx.PhotoBox id="hero"', '<ctx.PhotoBox id="heor"')
    .replace('contract: 1,', "contract: 1, requires: ['teleport'],"));
  const messages = (await check()).diagnostics.map(({ message }) => message).join('\n');
  assert.match(messages, /"heor"/);
  assert.match(messages, /"teleport"/);
});
