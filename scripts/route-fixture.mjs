import assert from 'node:assert/strict';
import { cp, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copySample } from '../desktop/sample-book.mjs';

// File-control and custom-editor smoke checks use an explicit route fixture, rather than shipping the old inset
// in every new photobook. Call before opening this test book.
export async function createRouteFixture(folder) {
  await copySample(fileURLToPath(new URL('../sample/starter', import.meta.url)), folder);
  for (const name of ['route.tsx', 'route.css'])
    await cp(fileURLToPath(new URL('./fixtures/' + name, import.meta.url)), join(folder, 'template', name));
  const file = join(folder, 'template/index.tsx');
  let source = await readFile(file, 'utf8');
  const panorama = "label: 'Panorama',\n      boxes: { hero: captioned('Panorama photo') },";
  const photo = `<ctx.PhotoBox id="hero" rect={ctx.geometry.spread('bleed')} />`;
  assert.ok(source.includes(panorama) && source.includes(photo));
  // This fixture exercises an offline editor. Its changed template hash must not introduce a native network
  // permission prompt for the unused Map layout while a smoke check opens the route controls.
  source = "import { RouteEditor, RouteMap, routeParameters } from './route';\n" + source
    .replace('  network: [mapOrigin, elevationOrigin],\n', '')
    .replace(panorama, panorama + `
      elements: { route: {
        label: 'Route map', parameters: routeParameters,
        editor: { label: 'Edit route', parameters: ['track', 'centerX', 'centerY', 'zoom'], component: RouteEditor },
      } },`)
    .replace(photo, photo + `
          <RouteMap track={ctx.elements.route.params.track} viewport={ctx.elements.route.params} view={ctx.view}
            rect={at.right(page - margin - 60, margin, 60, 60)} />`);
  await writeFile(file, source);
  const manifest = join(folder, 'project.json');
  const project = JSON.parse(await readFile(manifest, 'utf8'));
  project.title = basename(folder, '.imageflow');
  project.spreads.find(({ id }) => id === 'road').elements = { route: { params: { track: 'senja-road' } } };
  await writeFile(manifest, JSON.stringify(project, null, 2) + '\n');
}
