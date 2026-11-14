import { fileURLToPath } from 'node:url';
import { runCredentialChild } from './mac-credentials.mjs';
import { run } from './verify-mac-signing.mjs';

// One local command owns fixture preparation, signing, loopback TLS trust, the real
// upgrade test, and exact-certificate cleanup. CI keeps signing in a separate step.
if (process.platform !== 'darwin') throw new Error('Signed upgrade tests require a Mac.');
const root = fileURLToPath(new URL('../', import.meta.url));
const controller = new AbortController();
const stop = () => controller.abort(new Error('Signed upgrade test cancelled.'));
process.once('SIGINT', stop); process.once('SIGTERM', stop);
const child = (args, env = process.env) => runCredentialChild(args, { env, signal: controller.signal });
if (!process.argv.includes('--existing')) {
  let identity = process.env.APPLE_SIGNING_IDENTITY;
  if (!identity) {
    const { stdout } = await run('security', ['find-identity', '-v', '-p', 'codesigning']);
    const matches = [...stdout.matchAll(/"(Developer ID Application:[^"]+)"/g)].map((m) => m[1]);
    if (matches.length !== 1) throw new Error('Choose an installed Developer ID using APPLE_SIGNING_IDENTITY. No key export is needed.');
    identity = matches[0];
  }
  await child([root + 'scripts/upgrade-fixtures.mjs', 'prepare']);
  await child([root + 'scripts/upgrade-fixtures.mjs', 'build']);
  await child([root + 'scripts/sign-upgrade-fixtures.mjs'], { ...process.env, APPLE_SIGNING_IDENTITY: identity });
}
let failure;
try {
  await child([root + 'scripts/upgrade-fixtures.mjs', 'trust']);
  await child([root + 'scripts/test-signed-upgrade.mjs']);
} catch (error) { failure = error; }
finally {
  try { await runCredentialChild([root + 'scripts/upgrade-fixtures.mjs', 'untrust'], { env: process.env }); }
  catch (error) { failure = new AggregateError([...[failure].filter(Boolean), error], 'Upgrade test or local TLS trust cleanup failed.'); }
}
if (failure) throw failure;
