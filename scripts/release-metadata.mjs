import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import metadata from '../package.json' with { type: 'json' };

export function releaseMetadata({ refType, tag, version }) {
  if (refType !== 'tag') throw new Error('Releases must run from a version tag.');
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version);
  if (!match || match[0] !== version || match[4]?.split('.').some((part) => /^0\d+$/.test(part))) {
    throw new Error('package.json version must be a semantic version.');
  }
  if (tag !== 'v' + version) throw new Error('Release tag ' + tag + ' does not match package.json version ' + version + '.');
  return { tag, version, prerelease: !!match[4] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const release = releaseMetadata({ refType: process.env.GITHUB_REF_TYPE, tag: process.env.GITHUB_REF_NAME, version: metadata.version });
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, Object.entries(release).map(([key, value]) => `${key}=${value}\n`).join(''));
  }
  console.log('Release tag matches package.json: ' + release.tag);
}
