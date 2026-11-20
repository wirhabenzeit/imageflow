import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bundleTemplate } from '../desktop/project';

// A layout file, a map file that draws the picture, the map's helper, and a stylesheet.
async function template(t: { after: (fn: () => Promise<void>) => void }) {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'if-scopes-')));
  t.after(() => rm(folder, { recursive: true, force: true }));
  await mkdir(join(folder, 'template'));
  const write = (name: string, text: string) => writeFile(join(folder, 'template', name), text);
  await write('index.tsx', `import { defineTemplate, Spread } from 'imageflow';\nimport './styles.css';\nimport { Map } from './map';\n` +
    `export const layout = () => <Spread><Map /></Spread>;\nexport default defineTemplate;\n`);
  await write('map.tsx', `import { RenderedImage } from 'imageflow';\nimport { colour } from './palette';\n` +
    `export const Map = () => <RenderedImage label="Map" inputs={{}} draw={async () => '<svg viewBox="0 0 1 1" fill="' + colour + '"/>'} />;\n`);
  await write('palette.ts', `export const colour = 'teal';\n`);
  await write('styles.css', `.map { color: red; }\n`);
  return { folder, write };
}

test('a picture keeps its cache scope through edits to other template files and stylesheets, not to its own imports', async (t) => {
  const { folder, write } = await template(t);
  const scopes = async () => (await bundleTemplate(folder)).pictureScopes;
  const first = await scopes();
  assert.deepEqual(Object.keys(first).sort(), ['index.tsx', 'map.tsx']);

  await write('index.tsx', `import { defineTemplate, Spread } from 'imageflow';\nimport './styles.css';\nimport { Map } from './map';\n` +
    `export const layout = () => <Spread><p>Edited</p><Map /></Spread>;\nexport default defineTemplate;\n`);
  const layoutEdited = await scopes();
  assert.equal(layoutEdited['map.tsx'], first['map.tsx'], 'a layout edit keeps the map');
  assert.notEqual(layoutEdited['index.tsx'], first['index.tsx']);

  await write('styles.css', `.map { color: blue; }\n`);
  const styled = await scopes();
  assert.deepEqual(styled, layoutEdited, 'a stylesheet edit keeps every picture');

  await write('palette.ts', `export const colour = 'navy';\n`);
  const helperEdited = await scopes();
  assert.notEqual(helperEdited['map.tsx'], styled['map.tsx'], 'an edit to a helper the map imports draws it again');
  assert.notEqual(helperEdited['index.tsx'], styled['index.tsx'], 'and anything that imports the map');
});
