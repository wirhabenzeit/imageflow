import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
// @ts-expect-error: a build script without type declarations.
import { macSigningOptions } from '../scripts/mac-signing-options.mjs';
// @ts-expect-error: a build script without type declarations.
import { provisioningProfileProblem } from '../scripts/verify-mac-signing.mjs';

const root = resolve('.');
const team = 'DX96FWY9AX';
const bundleId = 'ch.wirhabenzeit.imageflow';
const entitlements = { 'com.apple.security.cs.allow-jit': true, 'com.apple.application-identifier': team + '.' + bundleId, 'com.apple.developer.team-identifier': team,
  'com.apple.developer.icloud-container-identifiers': ['iCloud.' + bundleId], 'com.apple.developer.icloud-services': ['CloudKit'],
  'com.apple.developer.icloud-container-environment': 'Production', 'com.apple.developer.aps-environment': 'production' };
// As the Developer ID profile of the App ID has them (Production as a string, every iCloud service).
const profile = { TeamIdentifier: [team], ProvisionsAllDevices: true, ExpirationDate: '2044-11-18T05:46:53Z', Entitlements: {
  'com.apple.application-identifier': team + '.' + bundleId, 'com.apple.developer.team-identifier': team, 'com.apple.developer.icloud-container-identifiers': ['iCloud.' + bundleId],
  'com.apple.developer.icloud-services': '*', 'com.apple.developer.icloud-container-environment': 'Production', 'com.apple.developer.aps-environment': 'production' } };
const check = (changes: { profile?: object; entitlements?: object; bundleId?: string; now?: Date } = {}) =>
  provisioningProfileProblem('profile' in changes ? changes.profile : profile, { ...entitlements, ...changes.entitlements }, { team, bundleId: changes.bundleId ?? bundleId, now: changes.now ?? new Date('2026-11-23T00:00:00Z') });

test('a release that claims iCloud needs the Developer ID profile of its App ID in the bundle', () => {
  assert.equal(check(), undefined);
  assert.match(check({ profile: undefined }), /no embedded provisioning profile.*killed at launch/);
  assert.match(check({ bundleId: bundleId + '.upgrade-test' }), /profile is for .*, not .*upgrade-test/);
  assert.match(check({ profile: { ...profile, TeamIdentifier: ['OTHER'] } }), /another team/);
  assert.match(check({ profile: { ...profile, ProvisionsAllDevices: false } }), /not a Developer ID profile/);
  assert.match(check({ now: new Date('2045-01-01T00:00:00Z') }), /expired/);
  assert.match(check({ entitlements: { 'com.apple.developer.icloud-container-environment': 'Development' } }), /Production/);
  assert.match(check({ profile: { ...profile, Entitlements: { ...profile.Entitlements, 'com.apple.developer.icloud-container-environment': ['Development'] } } }), /Production/);
  assert.match(check({ entitlements: { 'com.apple.developer.icloud-container-identifiers': ['iCloud.other'] } }), /container iCloud\.other/);
  assert.match(check({ profile: { ...profile, Entitlements: { ...profile.Entitlements, 'com.apple.developer.aps-environment': 'development' } } }), /push notifications/);
});

test('only a Developer ID build with a profile claims iCloud, on the main app alone, and nothing embeds a profile by chance', async () => {
  const main = '/out/ImageFlow-darwin-arm64/ImageFlow.app';
  const helper = main + '/Contents/Frameworks/ImageFlow Helper (Renderer).app';
  const entitlementsOf = (options: { optionsForFile: (file: string) => { entitlements?: string } }, file: string) => options.optionsForFile(file).entitlements?.replace(root + '/', '');
  const adhoc = macSigningOptions(root, {});
  assert.equal(adhoc.preEmbedProvisioningProfile, false);
  assert.equal(entitlementsOf(adhoc, main), undefined);
  // A profile without an identity is ignored: an ad-hoc build cannot use iCloud.
  assert.equal(macSigningOptions(root, { provisioningProfile: '/p.provisionprofile' }).provisioningProfile, undefined);
  const signed = macSigningOptions(root, { identity: 'Developer ID Application: Test (TEAM)' });
  assert.equal(signed.preEmbedProvisioningProfile, false);
  assert.equal(entitlementsOf(signed, main), 'resources/entitlements.mac.plist');
  const icloud = macSigningOptions(root, { identity: 'Developer ID Application: Test (TEAM)', provisioningProfile: '/p.provisionprofile' });
  assert.equal(icloud.provisioningProfile, '/p.provisionprofile');
  assert.equal(entitlementsOf(icloud, main), 'resources/entitlements.icloud.mac.plist');
  assert.equal(entitlementsOf(icloud, helper), 'resources/entitlements.mac.plist');
  // The iCloud entitlements are the ones the check expects, and the helpers' stay JIT only.
  const plist = await readFile(resolve('resources/entitlements.icloud.mac.plist'), 'utf8');
  for (const [key, value] of Object.entries(entitlements)) assert.ok(plist.includes('<key>' + key + '</key>'), key + ' ' + String(value));
  assert.ok(!(await readFile(resolve('resources/entitlements.mac.plist'), 'utf8')).includes('icloud'));
});
