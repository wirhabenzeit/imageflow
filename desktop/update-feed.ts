import { nativeUpdateURL, parseUpdateRelease, selectUpdate } from '../src/update-feed';
import type { UpdateChannel } from '../src/update-feed';

declare const __IMAGEFLOW_UPDATE_TEST__: { baseURL: string; profile: string; book: string; debugPort: number } | null;
// esbuild embeds this only in explicitly isolated upgrade fixtures. Production has no runtime URL override.
export const updateTestConfiguration = typeof __IMAGEFLOW_UPDATE_TEST__ === 'undefined' ? null : __IMAGEFLOW_UPDATE_TEST__;

export async function readUpdateJSON(url: string, request: typeof fetch = fetch) {
  const response = await request(url, { signal: AbortSignal.timeout(15000), cache: 'no-store', redirect: 'error' });
  if (!response.ok || !response.body) throw new Error('Update feed returned HTTP ' + response.status);
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 64 * 1024) throw new Error('Update metadata exceeds 64 KiB.');
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}
export async function checkUpdateFeed(options: { baseURL: string; channel: UpdateChannel; platform: string; installed: string;
  request?: typeof fetch; current: () => void; native: { setFeedURL(options: { url: string; serverType: 'default' }): void; checkForUpdates(): void } }) {
  const { baseURL, channel, platform, installed, native, request } = options;
  const release = selectUpdate(await readUpdateJSON(`${baseURL}/${channel}/${platform}/RELEASES.json`, request), channel, platform, installed);
  if (!release) { options.current(); return; }
  const url = nativeUpdateURL(baseURL, platform, release.version);
  const payload = parseUpdateRelease(await readUpdateJSON(url, request));
  if (JSON.stringify(payload) !== JSON.stringify(release)) throw new Error('Update release metadata changed during the check.');
  // Server mode avoids Squirrel's numeric-string comparison, which orders 1.0.0-beta above 1.0.0.
  // SemVer/channel checks above decide eligibility; Squirrel verifies and installs the signed ZIP.
  native.setFeedURL({ url, serverType: 'default' });
  native.checkForUpdates();
}
