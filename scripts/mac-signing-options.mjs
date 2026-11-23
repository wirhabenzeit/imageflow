import { join } from 'node:path';

/** The main app bundle of a signing run, as `optionsForFile` sees it; Electron's helpers are other `.app` bundles. */
const mainApp = (file) => /\/ImageFlow\.app$/.test(file);

/**
 * @electron/osx-sign options. With a Developer ID identity, every bundle gets hardened runtime and the JIT entitlement.
 * With a provisioning profile as well (`APPLE_PROVISIONING_PROFILE`, the Developer ID profile of the App ID; #292),
 * the profile is embedded and the main app alone also gets the iCloud entitlements (resources/entitlements.icloud.mac.plist):
 * it alone loads the CloudKit addon. Without a profile nothing claims iCloud, and none is embedded from anywhere, since
 * a Developer ID app with iCloud entitlements and no profile is killed at launch. Upgrade-test fixtures, whose bundle
 * ID the profile does not cover, are signed without one.
 */
export function macSigningOptions(root, { identity, keychain, provisioningProfile }) {
  const profile = identity ? provisioningProfile : undefined;
  return {
    identity: identity || '-', identityValidation: !!identity,
    ...(keychain ? { keychain } : {}), continueOnError: false,
    // Electron's localized data packs are sealed by the framework signature. Signing them
    // individually also requests a timestamp for every locale in each upgrade fixture.
    ignore: (file) => /\/Electron Framework\.framework\/Versions\/[^/]+\/Resources\/[^/]+\.lproj\/locale\.pak$/.test(file),
    batchCodesignCalls: true, preAutoEntitlements: false,
    ...(profile ? { provisioningProfile: profile } : { preEmbedProvisioningProfile: false }),
    optionsForFile: (file) => ({
      hardenedRuntime: !!identity,
      ...(identity ? { entitlements: join(root, profile && mainApp(file) ? 'resources/entitlements.icloud.mac.plist' : 'resources/entitlements.mac.plist') } : {}),
    }),
  };
}
