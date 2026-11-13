import assert from 'node:assert/strict';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { run } from './verify-mac-signing.mjs';
import { releaseMetadata } from './release-metadata.mjs';

export async function findRelease(tag, request) {
  const published = await request('/releases/tags/' + encodeURIComponent(tag));
  if (published.status === 200) {
    assert.ok(published.body?.tag_name === tag && typeof published.body.draft === 'boolean', 'Invalid release-lookup response.');
    return published.body;
  }
  if (published.status !== 404) throw new Error('Release lookup failed with HTTP ' + published.status + '. No release was created.');
  // The tag endpoint excludes pending drafts. Confirm their absence with a complete,
  // authenticated listing; an error on any page must stop creation as well.
  const matches = [];
  for (let page = 1; ; page++) {
    const response = await request('/releases?per_page=100&page=' + page);
    if (response.status !== 200) throw new Error('Draft lookup failed with HTTP ' + response.status + '. No release was created.');
    assert.ok(Array.isArray(response.body), 'Invalid release-list response.');
    matches.push(...response.body.filter((release) => release.tag_name === tag));
    if (matches.length > 1) throw new Error('Multiple releases already use ' + tag + '. Inspect the drafts before retrying.');
    if (response.body.length < 100) return matches[0];
  }
}

export async function publishDraft({ tag, prerelease, files }, request, execute = run) {
  const existing = await findRelease(tag, request);
  if (existing) {
    assert.equal(existing.draft, true, 'Refusing to modify a published release.');
    await execute('gh', ['release', 'upload', tag, ...files, '--clobber']);
  } else {
    await execute('gh', ['release', 'create', tag, ...files, '--draft', '--verify-tag', '--generate-notes', '--title', 'ImageFlow ' + tag, ...(prerelease ? ['--prerelease'] : [])]);
  }
  const { stdout } = await execute('gh', ['release', 'view', tag, '--json', 'isDraft,url,assets']);
  const release = JSON.parse(stdout);
  assert.equal(release.isDraft, true, 'The release must remain a draft.');
  for (const file of files) assert.ok(release.assets.some((asset) => asset.name === basename(file)), 'Missing release asset: ' + basename(file));
  return release.url;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const info = releaseMetadata({ refType: 'tag', tag: process.env.RELEASE_TAG, version: process.env.RELEASE_VERSION });
  const files = process.argv.slice(2);
  assert.ok(files.length, 'Release assets are required.');
  const repo = process.env.GH_REPO;
  assert.match(repo ?? '', /^[\w.-]+\/[\w.-]+$/, 'GH_REPO must identify the release repository.');
  assert.ok(process.env.GH_TOKEN, 'GH_TOKEN is required for authenticated draft lookup.');
  const base = process.env.GITHUB_API_URL || 'https://api.github.com';
  const url = await publishDraft({ ...info, files }, async (path) => {
    const response = await fetch(base + '/repos/' + repo + path, {
      headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + process.env.GH_TOKEN }, redirect: 'error',
    });
    return { status: response.status, body: response.status === 200 ? await response.json() : undefined };
  });
  console.log('Draft release: ' + url);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFile } = await import('node:fs/promises');
    await appendFile(process.env.GITHUB_STEP_SUMMARY, 'Draft release: ' + url + '\n');
  }
}
