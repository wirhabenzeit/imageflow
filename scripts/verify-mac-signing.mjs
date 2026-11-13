import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export function run(command, args, { input, ...options } = {}) {
  const result = execute(command, args, { maxBuffer: 4 * 1024 * 1024, ...options });
  if (input !== undefined) result.child.stdin.end(input);
  return result;
}

async function nativeFiles(folder) {
  const found = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) found.push(...await nativeFiles(path));
    else if (entry.isFile() && /\.(node|dylib)$/.test(entry.name)) found.push(path);
  }
  return found;
}

export async function verifyMacSigning(app) {
  await run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
  const details = async (path) => (await run('codesign', ['--display', '--verbose=4', path])).stderr;
  const main = await details(app);
  const team = /^TeamIdentifier=(.+)$/m.exec(main)?.[1];
  assert.ok(team && team !== 'not set', 'Developer ID builds must have a Team ID.');
  assert.match(main, /Authority=Developer ID Application:/);
  const frameworks = join(app, 'Contents/Frameworks');
  const helpers = (await readdir(frameworks)).filter((name) => name.endsWith('.app')).map((name) => join(frameworks, name));
  assert.ok(helpers.length, 'Electron helper apps must be present.');
  for (const bundle of [app, ...helpers]) {
    const info = await details(bundle);
    assert.match(info, /flags=.*\bruntime\b/, 'Hardened runtime is required: ' + bundle);
    assert.equal(/^TeamIdentifier=(.+)$/m.exec(info)?.[1], team);
    const { stdout, stderr } = await run('codesign', ['--display', '--entitlements', ':-', bundle]);
    const xml = stdout.includes('<?xml') ? stdout : stderr.slice(stderr.indexOf('<?xml'));
    const { stdout: json } = await run('plutil', ['-convert', 'json', '-o', '-', '-'], { input: xml });
    const entitlements = JSON.parse(json);
    assert.equal(entitlements['com.apple.security.cs.allow-jit'], true);
    assert.ok(!entitlements['com.apple.security.cs.allow-unsigned-executable-memory']);
    assert.ok(!entitlements['com.apple.security.cs.disable-library-validation']);
    assert.ok(!entitlements['com.apple.security.get-task-allow']);
  }
  const natives = await nativeFiles(join(app, 'Contents/Resources/app.asar.unpacked/node_modules/@img'));
  assert.ok(natives.some((path) => path.endsWith('.node')), 'sharp must be unpacked and signed.');
  assert.ok(natives.some((path) => path.endsWith('.dylib')), 'libvips must be unpacked and signed.');
  for (const path of [join(app, 'Contents/Resources/esbuild'), ...natives]) {
    await run('codesign', ['--verify', '--strict', path]);
    assert.equal(/^TeamIdentifier=(.+)$/m.exec(await details(path))?.[1], team, 'Native binary must share the app Team ID: ' + path);
  }
  console.log('Developer ID, hardened runtime, JIT-only entitlements, Electron helpers, esbuild, sharp and libvips signatures verified.');
}

export async function verifyNotarization(path, app = false) {
  await run('xcrun', ['stapler', 'validate', path]);
  if (app) {
    const { stdout, stderr } = await run('spctl', ['--assess', '--verbose=4', '--type', 'execute', path]);
    assert.match(stdout + stderr, /source=Notarized Developer ID/);
  }
  console.log('Notarization ticket verified: ' + path);
}
