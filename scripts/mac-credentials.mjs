import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { decodeSecret, validateReleaseSecrets } from './release-secrets.mjs';
import { run } from './verify-mac-signing.mjs';

export const keychainList = (output) => output.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line));

export async function withMacCredentials({ mode, env = process.env, temporary = env.RUNNER_TEMP, execute = run }, operation) {
  if (!['sign', 'notarize'].includes(mode)) throw new Error('Choose sign or notarize for credential access.');
  if (!temporary) throw new Error('RUNNER_TEMP is required for temporary signing credentials.');
  if (mode === 'notarize') validateReleaseSecrets(env);
  const identity = env.APPLE_SIGNING_IDENTITY?.trim();
  if (!identity?.startsWith('Developer ID Application:')) throw new Error('APPLE_SIGNING_IDENTITY must name a Developer ID Application certificate.');
  if (!env.APPLE_CERTIFICATE_PASSWORD) throw new Error('APPLE_CERTIFICATE_PASSWORD is required.');
  const certificate = decodeSecret(env, 'APPLE_CERTIFICATE_P12_BASE64');
  const security = async (args) => {
    try { return await execute('security', args); }
    catch { throw new Error('Keychain operation failed: ' + args[0] + '.'); }
  };
  const previous = keychainList((await security(['list-keychains', '-d', 'user'])).stdout);
  const folder = await mkdtemp(join(temporary, 'imageflow-credentials-'));
  const keychain = join(folder, 'signing.keychain-db');
  const password = randomBytes(32).toString('base64');
  if (env.GITHUB_ACTIONS === 'true') console.log('::add-mask::' + password);
  let created = false, result, failure;
  const cleanupErrors = [];
  try {
    const p12 = join(folder, 'identity.p12');
    await writeFile(p12, certificate, { mode: 0o600 });
    await security(['create-keychain', '-p', password, keychain]);
    created = true;
    await security(['set-keychain-settings', '-lut', '3600', keychain]);
    await security(['unlock-keychain', '-p', password, keychain]);
    await security(['import', p12, '-k', keychain, '-P', env.APPLE_CERTIFICATE_PASSWORD, '-f', 'pkcs12', '-T', '/usr/bin/codesign']);
    await rm(p12);
    await security(['set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', password, keychain]);
    await security(['list-keychains', '-d', 'user', '-s', keychain, ...previous]);
    const childEnv = { ...env, APPLE_SIGNING_IDENTITY: identity, APPLE_SIGNING_KEYCHAIN: keychain };
    for (const name of ['APPLE_CERTIFICATE_PASSWORD', 'APPLE_CERTIFICATE_P12_BASE64', 'APPLE_API_KEY_BASE64', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER']) delete childEnv[name];
    if (mode === 'notarize') {
      childEnv.APPLE_API_KEY = join(folder, 'AuthKey.p8');
      await writeFile(childEnv.APPLE_API_KEY, decodeSecret(env, 'APPLE_API_KEY_BASE64'), { mode: 0o600 });
      childEnv.APPLE_API_KEY_ID = env.APPLE_API_KEY_ID.trim();
      childEnv.APPLE_API_ISSUER = env.APPLE_API_ISSUER.trim();
    }
    result = await operation(childEnv);
  } catch (error) { failure = error; }
  finally {
    try {
      await security(['list-keychains', '-d', 'user', '-s', ...previous]);
      assert.deepEqual(keychainList((await security(['list-keychains', '-d', 'user'])).stdout), previous, 'Original keychain search list must be restored.');
    } catch (error) { cleanupErrors.push(error); }
    if (created) try { await security(['delete-keychain', keychain]); } catch (error) { cleanupErrors.push(error); }
    try { await rm(folder, { recursive: true, force: true }); } catch (error) { cleanupErrors.push(error); }
  }
  if (cleanupErrors.length) throw new AggregateError([...(failure ? [failure] : []), ...cleanupErrors], 'Could not fully clean up temporary signing credentials.');
  if (failure) throw failure;
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.platform !== 'darwin') throw new Error('Run temporary Mac credential operations on a Mac.');
  const { values, positionals } = parseArgs({ options: { arch: { type: 'string' } }, allowPositionals: true });
  const mode = positionals.length === 1 ? positionals[0] : undefined;
  const root = fileURLToPath(new URL('../', import.meta.url));
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    await withMacCredentials({ mode }, (env) => {
      controller.signal.throwIfAborted();
      return run(process.execPath, [join(root, 'scripts', mode === 'sign' ? 'sign-mac.mjs' : 'notarize-mac.mjs'), ...(values.arch ? ['--arch', values.arch] : [])], { env, signal: controller.signal }).then(({ stdout, stderr }) => {
        process.stdout.write(stdout); process.stderr.write(stderr);
      });
    });
  } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
}
