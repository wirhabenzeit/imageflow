import semver from 'semver';

export type UpdateChannel = 'stable' | 'beta';
export const updateBaseURL = 'https://wirhabenzeit.github.io/imageflow/updates';
export type UpdateRelease = { version: string; url: string; name: string; notes: string; pub_date: string; sha256: string; size: number };
export type UpdateFeed = { schemaVersion: 1; channel: UpdateChannel; platform: string; release: UpdateRelease | null };
export type PublishedRelease = { tag_name: string; draft: boolean; prerelease: boolean; published_at: string | null;
  name?: string | null; body?: string | null; assets: { name: string; browser_download_url: string; size: number; digest?: string | null; state?: string }[] };
export const isUpdateChannel = (value: unknown): value is UpdateChannel => value === 'stable' || value === 'beta';
export function releaseChannel(version: string): UpdateChannel | undefined {
  if (!semver.valid(version) || version.includes('+')) return;
  const pre = semver.prerelease(version);
  return !pre ? 'stable' : pre[0] === 'beta' ? 'beta' : undefined;
}
export function nativeUpdateURL(base: string, platform: string, version: string) {
  if (!/^darwin-(arm64|x64)$/.test(platform) || !releaseChannel(version)) throw new Error('Invalid update platform/version.');
  return `${base.replace(/\/$/, '')}/releases/${version}/${platform}/update.json`;
}
export function parseUpdateRelease(value: unknown): UpdateRelease {
  const r = value as UpdateRelease;
  if (!r || typeof r !== 'object' || !releaseChannel(r.version) || typeof r.url !== 'string' || new URL(r.url).protocol !== 'https:' ||
      typeof r.name !== 'string' || typeof r.notes !== 'string' || typeof r.pub_date !== 'string' || !Number.isFinite(Date.parse(r.pub_date)) ||
      !/^[a-f0-9]{64}$/.test(r.sha256) || !Number.isSafeInteger(r.size) || r.size <= 0) throw new Error('Invalid update release.');
  return { version: r.version, url: r.url, name: r.name, notes: r.notes, pub_date: r.pub_date, sha256: r.sha256, size: r.size };
}
export function selectUpdate(value: unknown, channel: UpdateChannel, platform: string, installed: string): UpdateRelease | null {
  const feed = value as UpdateFeed;
  if (!semver.valid(installed) || !feed || feed.schemaVersion !== 1 || feed.channel !== channel || feed.platform !== platform) throw new Error('Invalid update feed.');
  if (feed.release === null) return null;
  const release = parseUpdateRelease(feed.release);
  if (channel === 'stable' && releaseChannel(release.version) !== 'stable') throw new Error('The stable feed contains a prerelease.');
  return semver.gt(release.version, installed) ? release : null;
}

/** Published releases are the only source of channel heads; drafts and rehearsal tags never enter a feed. */
export function buildUpdateFeeds(releases: PublishedRelease[], platform = 'darwin-arm64', repo = 'wirhabenzeit/imageflow') {
  if (!/^darwin-(arm64|x64)$/.test(platform) || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Invalid feed target.');
  const found = new Map<string, UpdateRelease>();
  for (const item of releases) {
    if (item.draft || !item.published_at || !item.tag_name.startsWith('v')) continue;
    const version = item.tag_name.slice(1), channel = releaseChannel(version);
    // The version decides the channel. A final version must also be a full GitHub release to reach stable; a beta may be
    // published either as a pre-release or, while ImageFlow has no final release, as GitHub's "Latest" release.
    if (!channel || (channel === 'stable' && item.prerelease)) continue;
    const name = `ImageFlow-${version}-mac-${platform.slice(7)}.zip`;
    const matches = item.assets.filter((a) => a.name === name && (!a.state || a.state === 'uploaded'));
    if (!matches.length) continue;
    if (matches.length !== 1 || found.has(version)) throw new Error('Ambiguous update assets/version: ' + version);
    const asset = matches[0];
    const expected = `https://github.com/${repo}/releases/download/${item.tag_name}/${name}`;
    if (asset.browser_download_url !== expected || !asset.digest?.startsWith('sha256:')) throw new Error('Missing digest or unexpected asset URL: ' + name);
    found.set(version, parseUpdateRelease({ version, url: expected, name: item.name || version,
      notes: (item.body || '').slice(0, 16000), pub_date: item.published_at, size: asset.size, sha256: asset.digest.slice(7) }));
  }
  const all = [...found.values()].sort((a, b) => semver.rcompare(a.version, b.version));
  const feed = (channel: UpdateChannel): UpdateFeed => ({ schemaVersion: 1, channel, platform,
    release: all.find((r) => channel === 'beta' || releaseChannel(r.version) === 'stable') ?? null });
  return { stable: feed('stable'), beta: feed('beta'), releases: all };
}
