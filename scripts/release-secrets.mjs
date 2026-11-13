import { createPrivateKey } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export function decodeSecret(env, name) {
  const encoded = env[name]?.replace(/\s/g, '');
  if (!encoded) throw new Error(name + ' is required and must not be empty.');
  const bytes = Buffer.from(encoded, 'base64');
  if (!bytes.length || bytes.toString('base64') !== encoded) throw new Error(name + ' must contain valid base64 data.');
  return bytes;
}
export function validateReleaseSecrets(env = process.env) {
  for (const name of ['APPLE_SIGNING_IDENTITY', 'APPLE_CERTIFICATE_PASSWORD', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER']) {
    if (!env[name]?.trim()) throw new Error(name + ' is required and must not be empty.');
  }
  if (!env.APPLE_SIGNING_IDENTITY.trim().startsWith('Developer ID Application:')) throw new Error('APPLE_SIGNING_IDENTITY must name a Developer ID Application certificate.');
  decodeSecret(env, 'APPLE_CERTIFICATE_P12_BASE64');
  const bytes = decodeSecret(env, 'APPLE_API_KEY_BASE64');
  try {
    const key = createPrivateKey(bytes);
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('Unsupported key');
  } catch {
    throw new Error('APPLE_API_KEY_BASE64 must decode to a valid P-256 private key.');
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  validateReleaseSecrets();
  console.log('Required release secrets are present and the API private key is valid.');
}
