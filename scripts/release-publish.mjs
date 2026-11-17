import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { run } from './verify-mac-signing.mjs';
import { releaseMetadata } from './release-metadata.mjs';

// Betas remain GitHub's latest download until the first stable release exists. The
// version, rather than GitHub's prerelease flag, determines the updater channel.
async function hasStableRelease(request) {
  for (let page = 1; ; page++) {
    const response = await request('/releases?per_page=100&page=' + page);
    assert.equal(response.status, 200, 'Cannot determine published stable releases.');
    assert.ok(Array.isArray(response.body), 'Invalid release-list response.');
    if (response.body.some(release => release.draft === false && /^v\d+\.\d+\.\d+$/.test(release.tag_name))) return true;
    if (response.body.length < 100) return false;
  }
}

export async function publishRelease({ tag, version, prerelease }, request, execute = run) {
  const read = async () => JSON.parse((await execute('gh', ['release', 'view', tag, '--json', 'isDraft,url,assets'])).stdout);
  const release = await read();
  assert.equal(release.isDraft, true, 'Refusing to modify a published release.');
  for (const name of ['ImageFlow-' + version + '-mac-arm64.zip', 'ImageFlow-' + version + '-arm64.dmg']) {
    assert.ok(release.assets?.some(asset => asset.name === name && asset.size > 0), 'Missing release asset: ' + name);
  }
  // Rehearsals and experimental prereleases continue to produce drafts only.
  if (prerelease && !/^\d+\.\d+\.\d+-beta\.\d+$/.test(version)) return { url: release.url, published: false };
  const betaAfterStable = prerelease && await hasStableRelease(request);
  await execute('gh', ['release', 'edit', tag, '--draft=false', '--prerelease=' + betaAfterStable, '--latest=' + !betaAfterStable, '--verify-tag']);
  const published = await read();
  assert.equal(published.isDraft, false, 'Release publication was not confirmed.');
  return { url: published.url, published: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const info = releaseMetadata({ refType: 'tag', tag: process.env.RELEASE_TAG, version: process.env.RELEASE_VERSION });
  const repo = process.env.GH_REPO;
  assert.match(repo ?? '', /^[\w.-]+\/[\w.-]+$/, 'GH_REPO must identify the release repository.');
  assert.ok(process.env.GH_TOKEN, 'GH_TOKEN is required.');
  const base = process.env.GITHUB_API_URL || 'https://api.github.com';
  const result = await publishRelease(info, async path => {
    const response = await fetch(base + '/repos/' + repo + path, {
      headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + process.env.GH_TOKEN }, redirect: 'error',
    });
    return { status: response.status, body: response.status === 200 ? await response.json() : undefined };
  });
  console.log((result.published ? 'Published release: ' : 'Rehearsal draft: ') + result.url);
  const { appendFile } = await import('node:fs/promises');
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, 'published=' + result.published + '\n');
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
    (result.published ? 'Published release: ' : 'Rehearsal draft: ') + result.url + '\n');
}
