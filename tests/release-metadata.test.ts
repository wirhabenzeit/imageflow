import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const moduleURL = pathToFileURL(resolve('scripts/release-metadata.mjs')).href;
function metadata(input: Record<string, string>) {
  const source = `import { releaseMetadata } from ${JSON.stringify(moduleURL)}; process.stdout.write(JSON.stringify(releaseMetadata(JSON.parse(process.argv[1]))));`;
  return spawnSync(process.execPath, ['--input-type=module', '-e', source, JSON.stringify(input)], { encoding: 'utf8' });
}

test('only an exact version tag can create release metadata', () => {
  const good = metadata({ refType: 'tag', tag: 'v1.2.3', version: '1.2.3' });
  assert.equal(good.status, 0, good.stderr);
  assert.deepEqual(JSON.parse(good.stdout), { tag: 'v1.2.3', version: '1.2.3', prerelease: false });
  for (const [input, error] of [
    [{ refType: 'branch', tag: 'v1.2.3', version: '1.2.3' }, /Releases must run from a version tag/],
    [{ refType: 'tag', tag: 'v1.2.4', version: '1.2.3' }, /Release tag v1.2.4 does not match package.json version 1.2.3/],
    [{ refType: 'tag', tag: '1.2.3', version: '1.2.3' }, /Release tag 1.2.3 does not match package.json version 1.2.3/],
  ] as const) {
    const result = metadata(input);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, error);
  }
});

test('test versions are prereleases and malformed versions cannot reach workflow outputs', () => {
  const good = metadata({ refType: 'tag', tag: 'v0.1.0-test.1', version: '0.1.0-test.1' });
  assert.equal(good.status, 0, good.stderr);
  assert.equal(JSON.parse(good.stdout).prerelease, true);
  for (const version of ['01.2.3', '1.2', '1.2.3-01', '1.2.3-test..1', '1.2.3\n', '1.2.3\nprerelease=false']) {
    const result = metadata({ refType: 'tag', tag: 'v' + version, version });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /package.json version must be a semantic version/);
  }
  for (const version of ['1.2.3+rc', '1.2.3-test.1+build.2']) {
    const result = metadata({ refType: 'tag', tag: 'v' + version, version });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must not contain semver build metadata/);
  }
});
