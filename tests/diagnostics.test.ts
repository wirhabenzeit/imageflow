import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { checkProject } from '../desktop/check';
import { loadProject } from '../desktop/project';
import { templateLocation } from '../desktop/source-location';
import type { RenderStatus } from '../src/desktop';
import { PreviewError } from '../src/preview';

const helper = [
  '// Helpers used by the layouts.',
  'export function initial(title: string): string {',
  '  if (!title) throw new Error(\'Empty title\');',
  '  return title[0];',
  '}',
].join('\n');
const index = [
  "import { initial } from './helper';",
  'export default { id: "t", version: "1", contract: 1, spreads: { main: { label: "Main", render: () => initial("") } } };',
].join('\n');

async function book(t: TestContext) {
  const work = await realpath(await mkdtemp(join(tmpdir(), 'imageflow-diagnostics-')));
  t.after(() => rm(work, { recursive: true, force: true }));
  const folder = join(work, 'book'), cache = join(work, 'cache');
  await mkdir(join(folder, 'template'), { recursive: true });
  await mkdir(cache);
  await writeFile(join(folder, 'project.json'), JSON.stringify({ schemaVersion: 1, title: 'Book', template: { id: 't', version: '1' }, spreads: [{ id: 'one', definition: 'main' }] }));
  await writeFile(join(folder, 'photos.json'), '{}');
  await writeFile(join(folder, 'template/index.tsx'), index);
  await writeFile(join(folder, 'template/helper.ts'), helper);
  return { folder, cache, loaded: await loadProject(folder, cache, true) };
}

// A stack frame at the generated position of `throw` in the bundle, as Chromium reports it.
function stackAt(script: string, needle: string) {
  const lines = script.split('\n');
  const line = lines.findIndex((text) => text.includes(needle));
  assert.ok(line >= 0, 'The bundle contains ' + needle);
  const column = lines[line].indexOf('throw');
  return 'Error: Empty title\n    at initial (imageflow://render/0b0e3a52-0000-4000-8000-000000000000/template/template.js:' + (line + 1) + ':' + (column + 1) + ')\n' +
    '    at render (imageflow://render/0b0e3a52-0000-4000-8000-000000000000/assets/render-abc.js:1:200)';
}

test('runtime stacks map to the template source line through the bundle source map', async (t) => {
  const { loaded } = await book(t);
  assert.ok(loaded.assets.files.has('template.js.map'));
  const script = Buffer.from(loaded.assets.files.get('template.js')!).toString('utf8');
  assert.ok(!script.includes('sourceMappingURL'), 'The bundle does not link its map.');
  const stack = stackAt(script, 'Empty title');
  assert.deepEqual(templateLocation(stack, loaded), { path: 'template/helper.ts', line: 3, column: 15 });
  // Frames outside the template, missing maps and malformed stacks give no location.
  assert.equal(templateLocation('Error\n    at x (imageflow://render/id/assets/render.js:1:1)', loaded), undefined);
  assert.equal(templateLocation(stack, { assets: { ...loaded.assets, files: new Map() } }), undefined);
  assert.equal(templateLocation(undefined, loaded), undefined);
});

const ready = (template: Extract<RenderStatus, { state: 'ready' }>['template']): Extract<RenderStatus, { state: 'ready' }> =>
  ({ state: 'ready', template, pages: 2, units: [], errors: [], warnings: [], flow: {}, anchors: [] });

test('render failures become per-spread, declaration or located diagnostics', async (t) => {
  const { folder, cache, loaded } = await book(t);
  const script = Buffer.from(loaded.assets.files.get('template.js')!).toString('utf8');
  const stack = stackAt(script, 'Empty title');
  const template = { version: '1', parameters: {}, spreads: {}, formatId: 'default', formats: {},
    format: ready as never } as unknown as Extract<RenderStatus, { state: 'ready' }>['template'];
  const run = (error: PreviewError) => checkProject(loaded, cache, {}, async () => { throw error; }, new AbortController().signal);

  const layout = await run(new PreviewError('render-failed', 'Layouts failed to render: one: Empty title', { template,
    failure: { layoutFailures: [{ spread: 'one', message: 'Empty title', stack }] } }));
  assert.equal(layout.checks.declarations, 'passed');
  assert.equal(layout.checks.layout, 'failed');
  assert.equal(layout.template, template);
  assert.deepEqual(layout.diagnostics.map(({ code, location }) => [code, location]),
    [['layout-render-failed', { spread: 'one', path: 'template/helper.ts', line: 3, column: 15 }]]);
  assert.match(layout.diagnostics[0].suggestion ?? '', /template\/helper\.ts:3/);

  const declarations = await run(new PreviewError('render-failed', 'Template → spreads → main → label: Required', {
    failure: { declarationIssues: [{ path: 'spreads.main.label', message: 'Required' }, { path: 'id', message: 'Wrong ID.' }] } }));
  assert.equal(declarations.checks.bundle, 'passed');
  assert.equal(declarations.checks.declarations, 'failed');
  assert.deepEqual(declarations.diagnostics.map(({ code, stage, location }) => [code, stage, location?.declaration]),
    [['template-declaration-invalid', 'template', 'spreads.main.label'], ['template-id-mismatch', 'template', 'id']]);

  const thrown = await run(new PreviewError('render-failed', 'Empty title', { failure: { stack } }));
  assert.equal(thrown.checks.declarations, 'not-run');
  assert.deepEqual(thrown.diagnostics.map(({ code, location }) => [code, location]),
    [['render-failed', { path: 'template/helper.ts', line: 3, column: 15 }]]);
  assert.ok(folder);
});
