import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const verification = pathToFileURL(resolve('scripts/verify-mac-signing.mjs')).href;
const release = pathToFileURL(resolve('scripts/mac-release-artifacts.mjs')).href;
function check(source: string) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { verifyMacVersion, signingEntitlements } from ${JSON.stringify(verification)};
    import { prepareMacRelease, notarizeMacRelease } from ${JSON.stringify(release)};
    ${source}
  `], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

test('an existing packaged app must match the release version before notarization', () => check(`
  const execute = async () => ({ stdout: JSON.stringify({ CFBundleShortVersionString: '1.2.3' }) });
  await verifyMacVersion('/example/ImageFlow.app', '1.2.3', execute);
  await assert.rejects(verifyMacVersion('/example/ImageFlow.app', '2.0.0', execute), /Packaged app version 1.2.3 does not match package.json version 2.0.0/);
`));

test('missing signing entitlements fail clearly before invoking the plist converter', () => check(`
  let calls = 0;
  await assert.rejects(signingEntitlements('/example/ImageFlow.app', async (command) => {
    calls++; assert.equal(command, 'codesign'); return { stdout: '', stderr: 'Executable=/example/ImageFlow.app' };
  }), /Missing signing entitlements for \\/example\\/ImageFlow.app/);
  assert.equal(calls, 1);
`));

test('a release prepares its workspace on a clean checkout and removes only stale matching artifacts', () => check(`
  const { mkdtemp, writeFile, mkdir, access, rm, readdir } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const root = await mkdtemp(join(tmpdir(), 'imageflow-release-test-'));
  try {
    const key = join(root, 'AuthKey.p8');
    await writeFile(key, 'test key');
    await mkdir(join(root, 'out'));
    const zip = join(root, 'out/ImageFlow-1.2.3-mac-arm64.zip');
    const dmg = join(root, 'out/ImageFlow-1.2.3-arm64.dmg');
    const other = join(root, 'out/ImageFlow-1.2.2-arm64.dmg');
    await Promise.all([zip, dmg, other].map(path => writeFile(path, 'old artifact')));
    const prepared = await prepareMacRelease({ root, version: '1.2.3', arch: 'arm64', notarization: { appleApiKey: key } });
    await access(prepared.work);
    await access(other);
    await assert.rejects(access(zip), { code: 'ENOENT' });
    await assert.rejects(access(dmg), { code: 'ENOENT' });
    await rm(prepared.work, { recursive: true });
    let builds = 0;
    await assert.rejects(notarizeMacRelease({ root, version: '1.2.3', arch: 'arm64', notarization: { appleApiKey: key } }, async () => {
      builds++; throw new Error('test build failed');
    }), /test build failed/);
    assert.equal(builds, 1);
    assert.deepEqual(await readdir(join(root, '.build')), []);
  } finally { await rm(root, { recursive: true, force: true }); }
`));
