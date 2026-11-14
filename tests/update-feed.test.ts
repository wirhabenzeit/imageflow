import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildUpdateFeeds, nativeUpdateURL, selectUpdate } from '../src/update-feed';
import type { PublishedRelease, UpdateRelease } from '../src/update-feed';
import { checkUpdateFeed, readUpdateJSON, updateTestConfiguration } from '../desktop/update-feed';

const version = (value: string, options: Partial<PublishedRelease> = {}): PublishedRelease => ({
  tag_name: 'v' + value, draft: false, prerelease: value.includes('-'), published_at: '2026-11-14T00:00:00Z',
  name: value, body: 'Notes', assets: [{ name: `ImageFlow-${value}-mac-arm64.zip`,
    browser_download_url: `https://github.com/wirhabenzeit/imageflow/releases/download/v${value}/ImageFlow-${value}-mac-arm64.zip`,
    size: 1000, digest: 'sha256:' + 'a'.repeat(64), state: 'uploaded' }], ...options,
});
const feed = (release: UpdateRelease | null, channel = 'beta') => ({ schemaVersion: 1, channel, platform: 'darwin-arm64', release });

test('stable excludes prereleases, beta includes stable, and release order is semantic rather than publication order', () => {
  const result = buildUpdateFeeds([version('1.0.0-beta.10'), version('0.9.0'), version('1.0.0-beta.2'),
    version('9.0.0', { draft: true }), version('8.0.0-rc.1'), version('7.0.0-test.1')]);
  assert.equal(result.stable.release?.version, '0.9.0');
  assert.equal(result.beta.release?.version, '1.0.0-beta.10');
  const final = buildUpdateFeeds([version('1.0.0-beta.10'), version('1.0.0')]);
  assert.equal(final.beta.release?.version, '1.0.0');
  assert.equal(final.stable.release?.version, '1.0.0');
  assert.equal(buildUpdateFeeds([]).stable.release, null);
  assert.equal(buildUpdateFeeds([version('1.0.0', { prerelease: true })]).stable.release, null);
});

test('beta-to-final is an upgrade, equal/older versions never download, and switching to stable never downgrades', () => {
  const release = buildUpdateFeeds([version('1.0.0')]).beta.release!;
  assert.equal(selectUpdate(feed(release), 'beta', 'darwin-arm64', '1.0.0-beta.10')?.version, '1.0.0');
  assert.equal(selectUpdate(feed(release), 'beta', 'darwin-arm64', '1.0.0'), null);
  assert.equal(selectUpdate(feed(release), 'beta', 'darwin-arm64', '1.0.1'), null);
  assert.equal(selectUpdate(feed(release, 'stable'), 'stable', 'darwin-arm64', '1.1.0-beta.1'), null);
  const beta = buildUpdateFeeds([version('1.0.0-beta.1')]).beta.release;
  assert.throws(() => selectUpdate(feed(beta, 'stable'), 'stable', 'darwin-arm64', '0.9.0'), /prerelease/);
  assert.throws(() => selectUpdate(feed(release), 'stable', 'darwin-arm64', '0.9.0'), /Invalid update feed/);
});

test('a release without a matching architecture is omitted; malformed/missing digests and asset ambiguity stop publication', () => {
  assert.equal(buildUpdateFeeds([version('1.0.0')], 'darwin-x64').stable.release, null);
  const bad = version('1.0.0'); bad.assets[0].digest = null;
  assert.throws(() => buildUpdateFeeds([bad]), /Missing digest/);
  bad.assets[0].digest = 'sha256:' + 'a'.repeat(64); bad.assets[0].browser_download_url = 'https://elsewhere.invalid/file.zip';
  assert.throws(() => buildUpdateFeeds([bad]), /unexpected asset URL/);
  const duplicate = version('1.0.0'); duplicate.assets.push(duplicate.assets[0]);
  assert.throws(() => buildUpdateFeeds([duplicate]), /Ambiguous/);
});

test('native installer receives an versioned server-mode payload only after channel and SemVer validation', async () => {
  const release = buildUpdateFeeds([version('1.0.0')]).beta.release!;
  const baseURL = 'https://example.invalid/updates', url = nativeUpdateURL(baseURL, 'darwin-arm64', release.version);
  const requested: string[] = [], calls: unknown[] = [];
  const request = (async (input: string) => {
    requested.push(input); return new Response(JSON.stringify(input.endsWith('RELEASES.json') ? feed(release) : release));
  }) as typeof fetch;
  const options = { baseURL, channel: 'beta' as const, platform: 'darwin-arm64', installed: '1.0.0-beta.1', request,
    current: () => { calls.push('current'); }, native: { setFeedURL: (value: unknown) => { calls.push(value); }, checkForUpdates: () => { calls.push('native check'); } } };
  await checkUpdateFeed(options);
  assert.deepEqual(requested, [baseURL + '/beta/darwin-arm64/RELEASES.json', url]);
  assert.deepEqual(calls, [{ url, serverType: 'default' }, 'native check']);
  calls.length = 0; requested.length = 0;
  await checkUpdateFeed({ ...options, installed: '1.0.0' });
  assert.deepEqual(calls, ['current']); assert.equal(requested.length, 1);
  assert.equal(updateTestConfiguration, null, 'Ordinary builds do not read a runtime test-feed override');
});

test('offline, oversized and changed metadata fail before installation', async () => {
  await assert.rejects(readUpdateJSON('https://example.invalid', (async () => new Response('', { status: 503 })) as typeof fetch), /HTTP 503/);
  await assert.rejects(readUpdateJSON('https://example.invalid', (async () => new Response('x'.repeat(65537))) as typeof fetch), /64 KiB/);
  const release = buildUpdateFeeds([version('1.0.0')]).beta.release!;
  await assert.rejects(checkUpdateFeed({ baseURL: 'https://example.invalid', channel: 'beta', platform: 'darwin-arm64', installed: '0.9.0',
    request: (async (input: string) => new Response(JSON.stringify(input.endsWith('RELEASES.json') ? feed(release) : { ...release, sha256: 'b'.repeat(64) }))) as typeof fetch,
    current: () => assert.fail('Unexpected no-update result'), native: { setFeedURL: () => assert.fail('Unexpected installation'), checkForUpdates: () => assert.fail('Unexpected check') } }), /metadata changed/);
});

test('generator writes both channel heads and native payloads, and API errors never publish an empty replacement', () => {
  const generator = pathToFileURL(resolve('scripts/generate-update-feeds.mjs')).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { mkdtemp, readFile, rm } from 'node:fs/promises';
    import { tmpdir } from 'node:os'; import { join } from 'node:path';
    import { generateUpdateFeeds, publishedReleases } from ${JSON.stringify(generator)};
    const folder = await mkdtemp(join(tmpdir(), 'if-feed-'));
    try {
      await generateUpdateFeeds(${JSON.stringify([version('1.0.0-beta.1'), version('0.9.0')])}, folder);
      const beta = JSON.parse(await readFile(join(folder, 'updates/beta/darwin-arm64/RELEASES.json')));
      assert.equal(beta.release.version, '1.0.0-beta.1');
      assert.equal(JSON.parse(await readFile(join(folder, 'updates/releases/1.0.0-beta.1/darwin-arm64/update.json'))).version, beta.release.version);
      assert.equal(JSON.parse(await readFile(join(folder, 'updates/stable/darwin-x64/RELEASES.json'))).release, null);
      await assert.rejects(publishedReleases('wirhabenzeit/imageflow', async () => new Response('', {status:503})), /Existing feeds must not be replaced/);
    } finally { await rm(folder, {recursive:true,force:true}); }
  `], { encoding: 'utf8', timeout: 20000 });
  assert.equal(result.status, 0, result.stderr);
});
