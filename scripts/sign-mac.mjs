import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { sign } from '@electron/osx-sign';
import metadata from '../package.json' with { type: 'json' };
import { macBuildOptions } from './mac-build-options.mjs';
import { packagedMacApp } from './mac-paths.mjs';
import { macSigningOptions } from './mac-signing-options.mjs';
import { verifyMacSigning, verifyMacVersion } from './verify-mac-signing.mjs';

if (process.platform !== 'darwin') throw new Error('Run Mac signing on a Mac.');
const root = fileURLToPath(new URL('../', import.meta.url));
const { values } = parseArgs({ options: { arch: { type: 'string' } } });
const options = macBuildOptions({ arch: values.arch });
if (!options.identity) throw new Error('APPLE_SIGNING_IDENTITY is required to sign the release app.');
const app = packagedMacApp(root, options.arch);
await verifyMacVersion(app, metadata.version);
await sign({ app, platform: 'darwin', version: metadata.devDependencies.electron, ...macSigningOptions(root, options) });
await verifyMacSigning(app, options.identity);
