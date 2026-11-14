import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

// Reports changes to the surfaces that existing books, templates and agents rely on: the book format (project.json,
// photos.json), the template API (runtime exports, contract-1 capabilities, shipped declarations) and the MCP tools'
// argument and result shapes. They are compared with tests/compat/api-snapshot.json.
//
//   node scripts/compat-api.mjs           Report differences as CI warnings. Never fails on a difference: the API is
//                                         not frozen yet (#77), so a design change only has to be visible.
//   node scripts/compat-api.mjs --write   Accept the current surface as the new snapshot.
const root = fileURLToPath(new URL('../', import.meta.url));
const snapshotPath = join(root, 'tests', 'compat', 'api-snapshot.json');
const out = join(root, '.build', 'compat');
await mkdir(out, { recursive: true });
await build({
  entryPoints: [join(root, 'tests', 'compat', 'api-surface.ts')], outfile: join(out, 'api-surface.mjs'),
  bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'warning',
});
const { apiSurface, compareSurfaces } = await import(pathToFileURL(join(out, 'api-surface.mjs')).href);
const surface = apiSurface(root);

if (process.argv.includes('--write')) {
  await writeFile(snapshotPath, JSON.stringify(surface, null, 2) + '\n');
  console.log('Wrote tests/compat/api-snapshot.json. Commit it with the change it records.');
  process.exit(0);
}

const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'));
const changes = compareSurfaces(snapshot, surface);
const titles = { bookFormat: 'Book format', templateApi: 'Template API', mcp: 'MCP tools' };
if (!changes.length) {
  console.log('Compatibility surface matches tests/compat/api-snapshot.json.');
  process.exit(0);
}

const shown = (paths) => paths.slice(0, 40).map((path) => '  ' + path).concat(paths.length > 40 ? ['  … and ' + (paths.length - 40) + ' more'] : []);
const lines = [];
for (const { section, added, removed, changed } of changes) {
  lines.push((titles[section] ?? section) + ':');
  if (removed.length) lines.push(' Removed (can break existing books, templates or agents):', ...shown(removed));
  if (changed.length) lines.push(' Changed (can break existing books, templates or agents):', ...shown(changed));
  if (added.length) lines.push(' Added:', ...shown(added));
}
const advice = 'If the change is intended, run `node scripts/compat-api.mjs --write` and commit tests/compat/api-snapshot.json. ' +
  'Not frozen yet (#77), so this is a notice, not a failure.';
console.log('The compatibility surface differs from tests/compat/api-snapshot.json.\n\n' + lines.join('\n') + '\n\n' + advice);
if (process.env.GITHUB_ACTIONS) {
  for (const { section, added, removed, changed } of changes) {
    const counts = [removed.length && removed.length + ' removed', changed.length && changed.length + ' changed', added.length && added.length + ' added'].filter(Boolean);
    console.log('::warning title=' + (titles[section] ?? section) + ' changed::' + counts.join(', ') + ' (see the job summary). ' + advice);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, '## Compatibility surface changed\n\n```\n' + lines.join('\n') + '\n```\n\n' + advice + '\n');
  }
}
