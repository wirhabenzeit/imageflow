import { join } from 'node:path';

export function macSigningOptions(root, { identity, keychain }) {
  return {
    identity: identity || '-', identityValidation: !!identity,
    ...(keychain ? { keychain } : {}), continueOnError: false,
    // Electron's localized data packs are sealed by the framework signature. Signing them
    // individually also requests a timestamp for every locale in each upgrade fixture.
    ignore: (file) => /\/Electron Framework\.framework\/Versions\/[^/]+\/Resources\/[^/]+\.lproj\/locale\.pak$/.test(file),
    batchCodesignCalls: true, preAutoEntitlements: false,
    optionsForFile: () => ({
      hardenedRuntime: !!identity,
      ...(identity ? { entitlements: join(root, 'resources/entitlements.mac.plist') } : {}),
    }),
  };
}
