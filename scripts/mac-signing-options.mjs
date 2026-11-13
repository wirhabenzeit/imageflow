import { join } from 'node:path';

export function macSigningOptions(root, { identity, keychain }) {
  return {
    identity: identity || '-', identityValidation: !!identity,
    ...(keychain ? { keychain } : {}), continueOnError: false,
    batchCodesignCalls: true, preAutoEntitlements: false,
    optionsForFile: () => ({
      hardenedRuntime: !!identity,
      ...(identity ? { entitlements: join(root, 'resources/entitlements.mac.plist') } : {}),
    }),
  };
}
