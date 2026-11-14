import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildUpdateFeeds } from '../src/update-feed.ts';

export async function publishedReleases(repo, request = fetch) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Invalid repository.');
  const releases = [];
  for (let page = 1; page <= 100; page++) {
    const response = await request(`https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`, {
      headers: { Accept: 'application/vnd.github+json', ...(process.env.GH_TOKEN ? { Authorization: 'Bearer ' + process.env.GH_TOKEN } : {}) },
      signal: AbortSignal.timeout(30000), redirect: 'error',
    });
    if (!response.ok) throw new Error('Release listing failed with HTTP ' + response.status + '. Existing feeds must not be replaced.');
    const items = await response.json();
    if (!Array.isArray(items)) throw new Error('Invalid release-list response.');
    releases.push(...items);
    if (items.length < 100) return releases;
  }
  throw new Error('Release-list pagination limit exceeded.');
}
export async function generateUpdateFeeds(releases, destination, repo = 'wirhabenzeit/imageflow') {
  // Validate every platform before writing any files or replacing a published site.
  const platforms = ['darwin-arm64', 'darwin-x64'].map((platform) => ({ platform, ...buildUpdateFeeds(releases, platform, repo) }));
  for (const { platform, stable, beta, releases: entries } of platforms) {
    for (const feed of [stable, beta]) {
      const folder = join(destination, 'updates', feed.channel, platform);
      await mkdir(folder, { recursive: true });
      await writeFile(join(folder, 'RELEASES.json'), JSON.stringify(feed, null, 2) + '\n');
    }
    for (const release of entries) {
      const folder = join(destination, 'updates', 'releases', release.version, platform);
      await mkdir(folder, { recursive: true });
      await writeFile(join(folder, 'update.json'), JSON.stringify(release, null, 2) + '\n');
    }
  }
  await writeFile(join(destination, '.nojekyll'), '');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const destination = resolve(process.argv[2] || '.build/update-site');
  await generateUpdateFeeds(await publishedReleases(process.env.GH_REPO || 'wirhabenzeit/imageflow'), destination, process.env.GH_REPO || 'wirhabenzeit/imageflow');
  console.log('Stable and beta update feeds prepared at ' + destination);
}
