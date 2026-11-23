// Builds the spike app: the CloudKit addon, then an Electron app packaged and signed like ImageFlow
// (scripts/package-mac.mjs), with the iCloud entitlements on the main app and a provisioning profile embedded.
//
//   node package.mjs --variant devid   Developer ID identity + Developer ID profile, Production environment
//   node package.mjs --variant dev     Apple Development identity + Mac Development profile, Development environment
//   node package.mjs --variant adhoc   ad-hoc signature, no entitlements, no profile (what `npm run package:mac` makes without an identity)
//   node package.mjs --variant noprofile  Developer ID with the iCloud entitlements but no profile (the failure mode)
//
// Profiles default to ~/Downloads/ImageFlow_*-2.provisionprofile; override with --profile.
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { packager } from '@electron/packager';
import electronChecksums from 'electron/checksums.json' with { type: 'json' };
import metadata from '../../package.json' with { type: 'json' };

const run = promisify(execFile);
const here = fileURLToPath(new URL('./', import.meta.url));
const root = join(here, '../..');
const { values } = parseArgs({ options: { variant: { type: 'string', default: 'devid' }, profile: { type: 'string' } } });

const team = 'DX96FWY9AX';
const bundleId = 'ch.wirhabenzeit.imageflow';
const container = 'iCloud.ch.wirhabenzeit.imageflow';
const variants = {
  devid: { identity: 'A6C325D4C59C72E9695A39FBA26882FA65E9138E', profile: '~/Downloads/ImageFlow_Developer_ID-2.provisionprofile', environment: 'Production', aps: 'production' },
  dev: { identity: 'AD689D373F7A4E5F69AA011DEE20085A8AE7C49F', profile: '~/Downloads/ImageFlow_Mac_Development-2.provisionprofile', environment: 'Development', aps: 'development' },
  adhoc: { identity: '-' },
  noprofile: { identity: 'A6C325D4C59C72E9695A39FBA26882FA65E9138E', environment: 'Production', aps: 'production' },
};
const variant = variants[values.variant];
if (!variant) throw new Error('Unknown variant ' + values.variant);
const profile = (values.profile ?? variant.profile)?.replace(/^~/, homedir());

function plist(entries) {
  const value = (v) => Array.isArray(v) ? '<array>' + v.map((s) => '<string>' + s + '</string>').join('') + '</array>' : v === true ? '<true/>' : '<string>' + v + '</string>';
  return '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n'
    + Object.entries(entries).map(([k, v]) => '  <key>' + k + '</key>' + value(v)).join('\n') + '\n</dict></plist>\n';
}

export async function buildAddon(output) {
  const include = process.env.NODE_INCLUDE_DIR || join(dirname(dirname(await realpath(process.execPath))), 'include', 'node');
  await mkdir(output, { recursive: true });
  await run('xcrun', ['clang++', '-std=c++17', '-fobjc-arc', '-shared', '-undefined', 'dynamic_lookup', '-arch', 'arm64',
    '-mmacosx-version-min=13.0', '-DNAPI_VERSION=8', '-framework', 'Foundation', '-framework', 'CloudKit', '-framework', 'Security',
    '-I', include, join(here, 'native/cloudkit.mm'), '-o', join(output, 'cloudkit.node')]);
}

const staging = await mkdtemp(join(tmpdir(), 'ck-spike-'));
try {
  const source = join(staging, 'app');
  await buildAddon(join(source, 'build'));
  await cp(join(here, 'main.cjs'), join(source, 'main.cjs'));
  await cp(join(here, 'store.cjs'), join(source, 'store.cjs'));
  await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'imageflow-cloudkit-spike', version: '0.0.1', main: 'main.cjs' }));

  const jit = { 'com.apple.security.cs.allow-jit': true };
  const helperEntitlements = join(staging, 'helper.plist');
  const mainEntitlements = join(staging, 'main.plist');
  await writeFile(helperEntitlements, plist(jit));
  await writeFile(mainEntitlements, plist(variant.environment ? {
    ...jit,
    'com.apple.application-identifier': team + '.' + bundleId,
    'com.apple.developer.team-identifier': team,
    'com.apple.developer.icloud-container-identifiers': [container],
    'com.apple.developer.icloud-services': ['CloudKit'],
    'com.apple.developer.icloud-container-environment': variant.environment,
    'com.apple.developer.aps-environment': variant.aps,
  } : jit));

  const signed = variant.identity !== '-';
  const [output] = await packager({
    dir: source,
    out: join(here, 'out', values.variant),
    name: 'ImageFlow CloudKit Spike',
    executableName: 'CloudKitSpike',
    appVersion: '0.0.1',
    platform: 'darwin',
    arch: 'arm64',
    electronVersion: metadata.devDependencies.electron,
    download: { cacheRoot: join(root, '.build', 'electron-cache'), checksums: electronChecksums },
    appBundleId: bundleId,
    asar: false,
    prune: false,
    overwrite: true,
    osxSign: {
      identity: variant.identity, identityValidation: signed, continueOnError: false,
      ignore: (file) => /\/Electron Framework\.framework\/Versions\/[^/]+\/Resources\/[^/]+\.lproj\/locale\.pak$/.test(file),
      batchCodesignCalls: true, preAutoEntitlements: false,
      ...(profile ? { provisioningProfile: profile } : { preEmbedProvisioningProfile: false }),
      // The iCloud entitlements go on the main app only; it alone loads the addon. Helpers keep JIT only.
      optionsForFile: (file) => ({
        hardenedRuntime: signed,
        ...(signed ? { entitlements: /ImageFlow CloudKit Spike\.app$/.test(file) ? mainEntitlements : helperEntitlements } : {}),
      }),
    },
  });
  const app = join(output, 'ImageFlow CloudKit Spike.app');
  console.log(app);
} finally {
  await rm(staging, { recursive: true, force: true });
}
