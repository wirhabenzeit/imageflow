import { spawn } from 'node:child_process';
import { access, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { build } from 'esbuild';
import { packagedMacApp } from './mac-paths.mjs';

// The iCloud store against the real CloudKit (#292; tests/cloudkit-real.ts), run inside a packaged app that is entitled
// to iCloud: the CloudKit addon works only in a process whose signature carries the entitlements, so the tests run as
// that app's executable in Node mode. Build one first with a Developer ID identity and the provisioning profile:
//   APPLE_SIGNING_IDENTITY=… APPLE_PROVISIONING_PROFILE=…/ImageFlow.provisionprofile npm run package:mac
//   npm run test:cloudkit [-- --app path/to/ImageFlow.app]
// It writes to the private database of the signed-in Apple ID, in zones of its own that it deletes again. Not in CI.
const root = fileURLToPath(new URL('../', import.meta.url));
const { values } = parseArgs({ options: { app: { type: 'string' } } });
const app = resolve(values.app ?? packagedMacApp(root, process.arch));
const executable = join(app, 'Contents/MacOS/ImageFlow');
const addon = join(app, 'Contents/Resources/app.asar.unpacked/native/cloudkit.node');
await access(executable).catch(() => { throw new Error('No packaged app at ' + app + '. Build one with npm run package:mac (see above), or pass --app.'); });
const out = join(root, '.build', 'cloudkit-test');
await rm(out, { recursive: true, force: true });
await build({ entryPoints: [join(root, 'tests', 'cloudkit-real.ts')], outfile: join(out, 'cloudkit-real.mjs'), bundle: true, platform: 'node', format: 'esm',
  packages: 'external', logLevel: 'warning' });
const child = spawn(executable, [join(out, 'cloudkit-real.mjs')], { stdio: 'inherit', cwd: root,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', IMAGEFLOW_CLOUDKIT_ADDON: addon } });
child.on('close', (code, signal) => {
  if (signal) console.error('The test process was stopped by ' + signal + (signal === 'SIGKILL' ? ': a build that claims iCloud without its provisioning profile is killed at launch.' : '.'));
  process.exit(code ?? 1);
});
