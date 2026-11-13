import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const moduleURL = pathToFileURL(resolve('scripts/mac-build-options.mjs')).href;
function options(input: Record<string, unknown>) {
  const source = `import { macBuildOptions } from ${JSON.stringify(moduleURL)}; process.stdout.write(JSON.stringify(macBuildOptions(JSON.parse(process.argv[1]))));`;
  return spawnSync(process.execPath, ['--input-type=module', '-e', source, JSON.stringify(input)], { encoding: 'utf8' });
}

test('local Mac builds are ad hoc unless a Developer ID identity is explicitly selected', () => {
  const local = options({ env: {}, arch: 'arm64', hostArch: 'arm64' });
  assert.equal(local.status, 0, local.stderr);
  assert.equal(JSON.parse(local.stdout).identity, undefined);
  const signed = options({ env: { APPLE_SIGNING_IDENTITY: 'Developer ID Application: Test (TEAM)' }, arch: 'x64', hostArch: 'x64' });
  assert.equal(signed.status, 0, signed.stderr);
  assert.equal(JSON.parse(signed.stdout).notarization, undefined, 'Signing alone must not upload a build to Apple.');
});

test('release builds fail closed when signing or notarization credentials are absent', () => {
  const credentials = {
    APPLE_SIGNING_IDENTITY: 'Developer ID Application: Test (TEAM)',
    APPLE_API_KEY: '/private/test/AuthKey.p8', APPLE_API_KEY_ID: 'EXAMPLE123', APPLE_API_ISSUER: 'example-issuer',
  };
  for (const missing of Object.keys(credentials)) {
    const env: Record<string, string> = { ...credentials };
    delete env[missing];
    const result = options({ env, release: true, arch: 'arm64', hostArch: 'arm64' });
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes(missing));
  }
  const valid = options({ env: credentials, release: true, arch: 'arm64', hostArch: 'arm64' });
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(JSON.parse(valid.stdout).notarization.appleApiKey, credentials.APPLE_API_KEY);
});

test('wrong certificate types and mismatched native architectures are rejected before packaging', () => {
  for (const identity of ['-', 'Apple Development: Test', 'Apple Distribution: Test']) {
    const result = options({ env: { APPLE_SIGNING_IDENTITY: identity } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /APPLE_SIGNING_IDENTITY must name a Developer ID Application certificate/);
  }
  const mismatch = options({ env: {}, arch: 'x64', hostArch: 'arm64' });
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /Build on a x64 Mac/);
  const unsupported = options({ env: {}, arch: 'universal', hostArch: 'arm64' });
  assert.notEqual(unsupported.status, 0);
  assert.match(unsupported.stderr, /Supported Mac architectures are arm64 and x64/);
});

test('release credentials are normalized before they reach signing and Apple tools', () => {
  const result = options({ env: {
    APPLE_SIGNING_IDENTITY: '  Developer ID Application: Test (TEAM)\n',
    APPLE_SIGNING_KEYCHAIN: ' /private/test/Signing.keychain-db\n',
    APPLE_API_KEY: ' /private/test/AuthKey.p8\n', APPLE_API_KEY_ID: ' EXAMPLE123\n', APPLE_API_ISSUER: ' example-issuer\n',
  }, arch: 'arm64', hostArch: 'arm64', release: true });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    arch: 'arm64', identity: 'Developer ID Application: Test (TEAM)', keychain: '/private/test/Signing.keychain-db',
    notarization: { appleApiKey: '/private/test/AuthKey.p8', appleApiKeyId: 'EXAMPLE123', appleApiIssuer: 'example-issuer' },
  });
});
