import { resolve } from 'node:path';

export function macBuildOptions({ env = process.env, arch = process.arch, hostArch = process.arch, release = false } = {}) {
  const value = (name) => env[name]?.trim() || undefined;
  if (!['arm64', 'x64'].includes(arch)) throw new Error('Supported Mac architectures are arm64 and x64.');
  if (arch !== hostArch) throw new Error('Build on a ' + arch + ' Mac so esbuild and sharp match the target architecture.');
  const identity = value('APPLE_SIGNING_IDENTITY');
  if (identity && !identity.startsWith('Developer ID Application:')) {
    throw new Error('APPLE_SIGNING_IDENTITY must name a Developer ID Application certificate.');
  }
  const profile = value('APPLE_NOTARY_PROFILE');
  let notarization;
  if (release) {
    const required = profile ? ['APPLE_SIGNING_IDENTITY']
      : ['APPLE_SIGNING_IDENTITY', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'];
    const missing = required
      .filter((name) => !value(name));
    if (missing.length) throw new Error('Release builds require: ' + missing.join(', ') + '.');
    notarization = profile ? { keychainProfile: profile } : {
      appleApiKey: resolve(value('APPLE_API_KEY')), appleApiKeyId: value('APPLE_API_KEY_ID'),
      appleApiIssuer: value('APPLE_API_ISSUER'),
    };
  }
  return { arch, identity, keychain: value('APPLE_SIGNING_KEYCHAIN'), notarization };
}
