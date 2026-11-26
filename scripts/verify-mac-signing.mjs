import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export function run(command, args, { input, ...options } = {}) {
  const result = execute(command, args, { maxBuffer: 4 * 1024 * 1024, ...options });
  if (input !== undefined) result.child.stdin.end(input);
  return result;
}

async function nativeFiles(folder) {
  const found = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) found.push(...await nativeFiles(path));
    else if (entry.isFile() && /\.(node|dylib)$/.test(entry.name)) found.push(path);
  }
  return found;
}

export async function verifyMacVersion(app, expected, execute = run) {
  const { stdout } = await execute('plutil', ['-convert', 'json', '-o', '-', join(app, 'Contents/Info.plist')]);
  const actual = JSON.parse(stdout).CFBundleShortVersionString;
  assert.equal(actual, expected, `Packaged app version ${actual ?? '(missing)'} does not match package.json version ${expected}. Rebuild the app before notarizing it.`);
}

export async function signingEntitlements(bundle, execute = run) {
  const { stdout, stderr } = await execute('codesign', ['--display', '--entitlements', ':-', bundle]);
  const xml = [stdout, stderr].map((output) => {
    const start = output.search(/<\?xml|<plist\b/);
    return start < 0 ? undefined : output.slice(start);
  }).find(Boolean);
  assert.ok(xml, 'Missing signing entitlements for ' + bundle + '. Sign the app and helpers with the JIT entitlement before release.');
  const { stdout: json } = await execute('plutil', ['-convert', 'json', '-o', '-', '-'], { input: xml });
  return JSON.parse(json);
}

const list = (value) => (Array.isArray(value) ? value : value === undefined ? [] : [value]);

/**
 * Why an embedded provisioning profile does not let the app use what its entitlements claim, or undefined when it does
 * (#292). A Developer ID app whose iCloud entitlements its profile does not cover is killed at launch, and a Mac with
 * the profile installed hides that, so releases check the profile in the bundle itself: there, for this App ID and
 * team, issued for the certificate the app is signed with (`certificate`, base64 DER; a renewed certificate needs a
 * new profile), for every Mac (Developer ID), Production, covering the containers, and not expired.
 */
export function provisioningProfileProblem(profile, entitlements, { team, bundleId, certificate, now = new Date() }) {
  if (!profile) return 'The app claims iCloud but has no embedded provisioning profile (Contents/embedded.provisionprofile); it would be killed at launch. Set APPLE_PROVISIONING_PROFILE to the Developer ID profile.';
  const granted = profile.Entitlements ?? {};
  const appId = team + '.' + bundleId;
  if (granted['com.apple.application-identifier'] !== appId) return 'The provisioning profile is for ' + granted['com.apple.application-identifier'] + ', not ' + appId + '.';
  if (entitlements['com.apple.application-identifier'] !== appId) return 'The app is signed as ' + entitlements['com.apple.application-identifier'] + ', not ' + appId + '.';
  if (!list(profile.TeamIdentifier).includes(team)) return 'The provisioning profile belongs to another team than the signature (' + team + ').';
  if (certificate !== undefined && !list(profile.DeveloperCertificates).includes(certificate)) {
    return 'The provisioning profile was issued for another Developer ID certificate than the one the app is signed with. Make a new profile for this certificate.';
  }
  if (profile.ProvisionsAllDevices !== true) return 'The provisioning profile is not a Developer ID profile: it runs only on the Macs it lists.';
  if (!(new Date(profile.ExpirationDate).getTime() > now.getTime())) return 'The provisioning profile expired on ' + profile.ExpirationDate + '.';
  if (entitlements['com.apple.developer.icloud-container-environment'] !== 'Production' || !list(granted['com.apple.developer.icloud-container-environment']).includes('Production')) {
    return 'A release uses the Production iCloud environment, in its entitlements and its profile.';
  }
  const containers = list(granted['com.apple.developer.icloud-container-identifiers']);
  const missing = list(entitlements['com.apple.developer.icloud-container-identifiers']).filter((container) => !containers.includes(container));
  if (missing.length) return 'The provisioning profile does not cover the iCloud container ' + missing.join(', ') + '.';
  const services = list(granted['com.apple.developer.icloud-services']);
  if (!services.includes('*') && !list(entitlements['com.apple.developer.icloud-services']).every((service) => services.includes(service))) return 'The provisioning profile does not grant CloudKit.';
  if (entitlements['com.apple.developer.aps-environment'] && granted['com.apple.developer.aps-environment'] !== entitlements['com.apple.developer.aps-environment']) return 'The provisioning profile does not grant push notifications in the ' + entitlements['com.apple.developer.aps-environment'] + ' environment.';
  return undefined;
}

/** The profile embedded in an app, as the parts `provisioningProfileProblem` reads, or undefined when there is none. */
export async function embeddedProfile(app, execute = run) {
  const file = join(app, 'Contents/embedded.provisionprofile');
  try { await access(file); } catch { return undefined; }
  const work = await mkdtemp(join(tmpdir(), 'imageflow-profile-'));
  try {
    const decoded = join(work, 'profile.plist');
    await execute('security', ['cms', '-D', '-i', file, '-o', decoded]);
    // Read key by key: the profile holds dates and data, which a JSON conversion of the whole refuses.
    const extract = async (key, format) => (await execute('plutil', ['-extract', key, format, '-o', '-', decoded])).stdout.trim();
    // Certificates are data: `raw` gives an array's length, and each element as base64 DER.
    const certificates = Number(await extract('DeveloperCertificates', 'raw').catch(() => '0')) || 0;
    const DeveloperCertificates = [];
    for (let index = 0; index < certificates; index++) DeveloperCertificates.push((await extract('DeveloperCertificates.' + index, 'raw')).replace(/\s/g, ''));
    return { Entitlements: JSON.parse(await extract('Entitlements', 'json')), TeamIdentifier: JSON.parse(await extract('TeamIdentifier', 'json')), DeveloperCertificates,
      ExpirationDate: await extract('ExpirationDate', 'raw'), ProvisionsAllDevices: await extract('ProvisionsAllDevices', 'raw').then((value) => value === 'true', () => false) };
  } finally { await rm(work, { recursive: true, force: true }); }
}

/** The certificate an app is signed with, as base64 DER. */
async function signingCertificate(app) {
  const work = await mkdtemp(join(tmpdir(), 'imageflow-signer-'));
  try {
    await run('codesign', ['--display', '--extract-certificates=' + join(work, 'signer-'), app]);
    return (await readFile(join(work, 'signer-0'))).toString('base64');
  } finally { await rm(work, { recursive: true, force: true }); }
}

/**
 * Verifies a Developer ID build. `icloud`: whether the build was signed with the provisioning profile and so must claim
 * iCloud; undefined where the caller cannot tell (notarizing an app built earlier). Either way, an app that claims
 * iCloud must embed a profile that covers it, and one that embeds a profile must claim iCloud.
 */
export async function verifyMacSigning(app, identity, { icloud: expectICloud } = {}) {
  await run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
  const details = async (path) => (await run('codesign', ['--display', '--verbose=4', path])).stderr;
  const main = await details(app);
  const team = /^TeamIdentifier=(.+)$/m.exec(main)?.[1];
  assert.ok(team && team !== 'not set', 'Developer ID builds must have a Team ID.');
  assert.match(main, /Authority=Developer ID Application:/);
  if (identity) assert.ok(main.includes('Authority=' + identity + '\n'), 'The app must use the selected Developer ID identity.');
  const frameworks = join(app, 'Contents/Frameworks');
  const helpers = (await readdir(frameworks)).filter((name) => name.endsWith('.app')).map((name) => join(frameworks, name));
  assert.ok(helpers.length, 'Electron helper apps must be present.');
  for (const bundle of [app, ...helpers]) {
    const info = await details(bundle);
    assert.match(info, /flags=.*\bruntime\b/, 'Hardened runtime is required: ' + bundle);
    assert.equal(/^TeamIdentifier=(.+)$/m.exec(info)?.[1], team);
    const entitlements = await signingEntitlements(bundle);
    assert.equal(entitlements['com.apple.security.cs.allow-jit'], true);
    assert.ok(!entitlements['com.apple.security.cs.allow-unsigned-executable-memory']);
    assert.ok(!entitlements['com.apple.security.cs.disable-library-validation']);
    assert.ok(!entitlements['com.apple.security.get-task-allow']);
  }
  // iCloud (#292): only the main app claims it, and only with a profile in the bundle that covers it.
  const mainEntitlements = await signingEntitlements(app);
  const icloud = (entitlements) => Object.keys(entitlements).some((key) => key.startsWith('com.apple.developer.icloud') || key === 'com.apple.developer.aps-environment');
  for (const helper of helpers) assert.ok(!icloud(await signingEntitlements(helper)), 'Electron helpers must not claim iCloud: ' + helper);
  const profile = await embeddedProfile(app);
  const claims = icloud(mainEntitlements);
  if (expectICloud !== undefined) assert.equal(claims, expectICloud, expectICloud ? 'The app was signed with a provisioning profile but its main app claims no iCloud: check the main app match in scripts/mac-signing-options.mjs.' : 'The app claims iCloud but was signed without a provisioning profile.');
  assert.ok(claims || !profile, 'The app embeds a provisioning profile but claims no iCloud.');
  if (claims) {
    const { stdout } = await run('plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', join(app, 'Contents/Info.plist')]);
    const problem = provisioningProfileProblem(profile, mainEntitlements, { team, bundleId: stdout.trim(), certificate: await signingCertificate(app) });
    assert.equal(problem, undefined, problem);
    console.log('iCloud entitlements and the embedded Developer ID provisioning profile verified.');
  }
  // Apple Photos (ADR 0013): without this entitlement, hardened runtime refuses access to the Photos library without
  // asking, and without the usage description macOS ends the app when it asks.
  assert.equal(mainEntitlements['com.apple.security.personal-information.photos-library'], true, 'The main app must claim access to the Photos library.');
  const { stdout: usage } = await run('plutil', ['-extract', 'NSPhotoLibraryUsageDescription', 'raw', '-o', '-', join(app, 'Contents/Info.plist')]);
  assert.ok(usage.trim(), 'The app must describe why it reads the Photos library.');
  const natives = await nativeFiles(join(app, 'Contents/Resources/app.asar.unpacked/node_modules/@img'));
  assert.ok(natives.some((path) => path.endsWith('.node')), 'sharp must be unpacked and signed.');
  assert.ok(natives.some((path) => path.endsWith('.dylib')), 'libvips must be unpacked and signed.');
  for (const path of [join(app, 'Contents/Resources/esbuild'), join(app, 'Contents/Resources/app.asar.unpacked/native/mac-header.node'), join(app, 'Contents/Resources/app.asar.unpacked/native/cloudkit.node'), join(app, 'Contents/Resources/app.asar.unpacked/native/photos.node'), ...natives]) {
    await run('codesign', ['--verify', '--strict', path]);
    assert.equal(/^TeamIdentifier=(.+)$/m.exec(await details(path))?.[1], team, 'Native binary must share the app Team ID: ' + path);
  }
  console.log('Developer ID, hardened runtime, entitlements, Electron helpers, esbuild, sharp and libvips signatures verified.');
}

export async function verifyNotarization(path, app = false) {
  await run('xcrun', ['stapler', 'validate', path]);
  const { stdout, stderr } = await run('spctl', ['--assess', '--verbose=4', '--type',
    ...(app ? ['execute'] : ['open', '--context', 'context:primary-signature']), path]);
  assert.match(stdout + stderr, /source=Notarized Developer ID/, 'Gatekeeper must accept the notarized ' + (app ? 'app' : 'DMG') + ': ' + path);
  console.log('Notarization ticket and Gatekeeper acceptance verified: ' + path);
}
