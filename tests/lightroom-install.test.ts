import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { installMessage, installPlugin, pluginStatus, pluginVersion } from '../desktop/lightroom/plugin-install';

// Installing the bundled ImageFlow.lrplugin into Lightroom's Modules folder (ADR 0011, section 5), against temporary
// folders only: Lightroom's own Modules folder is never read or written here.

const bundledPlugin = resolve('resources/ImageFlow.lrplugin');
async function setup(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'if-lr-install-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  // Lightroom creates the folder only once a plugin was added; it may not exist yet.
  return { root, locations: { bundled: bundledPlugin, modules: join(root, 'Adobe', 'Lightroom', 'Modules') } };
}
const info = (version: string) => `return { LrSdkVersion = 13.0, VERSION = { major = ${version.split('.')[0]}, minor = ${version.split('.')[1]}, revision = ${version.split('.')[2]}, display = '${version}' } }\n`;

test('the bundled plugin declares the version ImageFlow compares', async () => {
  assert.equal(await pluginVersion(bundledPlugin), '1.0.0');
  const files = await readdir(bundledPlugin);
  for (const file of ['Info.lua', 'Init.lua', 'Bridge.lua', 'Catalog.lua', 'Json.lua', 'SendToImageFlow.lua']) assert.ok(files.includes(file), file);
});

test('a missing plugin is installed, an older one updated, and nothing is left beside it', async (t) => {
  const { locations } = await setup(t);
  assert.deepEqual(await pluginStatus(locations), { state: 'missing', available: '1.0.0' });
  const installed = await installPlugin(locations);
  assert.deepEqual(installed, { state: 'current', installed: '1.0.0', available: '1.0.0' });
  assert.equal(await readFile(join(locations.modules, 'ImageFlow.lrplugin', 'Bridge.lua'), 'utf8'), await readFile(join(bundledPlugin, 'Bridge.lua'), 'utf8'));
  // An older copy, with a file the new version no longer has.
  const target = join(locations.modules, 'ImageFlow.lrplugin');
  await writeFile(join(target, 'Info.lua'), info('0.9.3'));
  await writeFile(join(target, 'Obsolete.lua'), '-- gone in 1.0');
  const outdated = await pluginStatus(locations);
  assert.deepEqual(outdated, { state: 'outdated', installed: '0.9.3', available: '1.0.0' });
  const updated = await installPlugin(locations);
  assert.equal(updated.state, 'current');
  assert.equal((await readdir(target)).includes('Obsolete.lua'), false, 'replaced whole, not merged');
  assert.deepEqual(await readdir(locations.modules), ['ImageFlow.lrplugin'], 'no staging or previous copy is left');
  assert.equal(installMessage(outdated, updated, true), 'Updated the ImageFlow plugin to 1.0.0. Quit and reopen Lightroom Classic to load it.');
  assert.match(installMessage({ state: 'missing', available: '1.0.0' }, updated, false), /^Installed the ImageFlow plugin 1\.0\.0\. It loads the next time you open Lightroom Classic; if File → Plug-in Manager/);
});

test('a newer, unreadable or linked plugin is reported, and a link or a file in its place is never replaced', async (t) => {
  const { root, locations } = await setup(t);
  const target = join(locations.modules, 'ImageFlow.lrplugin');
  await mkdir(target, { recursive: true });
  await writeFile(join(target, 'Info.lua'), info('2.1.0'));
  assert.deepEqual(await pluginStatus(locations), { state: 'newer', installed: '2.1.0', available: '1.0.0' });
  await writeFile(join(target, 'Info.lua'), 'return {}');
  assert.deepEqual(await pluginStatus(locations), { state: 'unknown', available: '1.0.0' });
  await rm(target, { recursive: true });
  // A developer's link to a working copy.
  const working = join(root, 'working.lrplugin');
  await cp(bundledPlugin, working, { recursive: true });
  await symlink(working, target);
  assert.equal((await pluginStatus(locations)).state, 'linked');
  await assert.rejects(installPlugin(locations), /is a link/);
  assert.equal(await readFile(join(working, 'Info.lua'), 'utf8'), await readFile(join(bundledPlugin, 'Info.lua'), 'utf8'), 'the working copy is untouched');
  await rm(target);
  await writeFile(target, 'not a folder');
  await assert.rejects(installPlugin(locations), /holds a file/);
  // Without a bundled plugin there is nothing to install.
  await assert.rejects(installPlugin({ bundled: join(root, 'nothing'), modules: locations.modules }), /no Lightroom plugin/);
});
