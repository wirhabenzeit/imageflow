import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { sign } from '@electron/osx-sign';
import metadata from '../package.json' with { type: 'json' };
import { macBuildOptions } from './mac-build-options.mjs';
import { macSigningOptions } from './mac-signing-options.mjs';
import { verifyMacSigning, verifyMacVersion } from './verify-mac-signing.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const plan = JSON.parse(await readFile(join(root, '.build/upgrade-test/plan.json'), 'utf8'));
const options = macBuildOptions();
if (!options.identity) throw new Error('Developer ID signing is required for the real upgrade test.');
for (const [index, version] of plan.versions.entries()) {
  const app = join(root, '.build/upgrade-test', String(index), `ImageFlow-darwin-${process.arch}`, 'ImageFlow.app');
  await verifyMacVersion(app, version);
  await sign({ app, platform: 'darwin', version: metadata.devDependencies.electron, ...macSigningOptions(root, { ...options, provisioningProfile: undefined }) });
  await verifyMacSigning(app, options.identity, { icloud: false });
}
