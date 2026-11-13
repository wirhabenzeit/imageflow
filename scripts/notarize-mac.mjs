import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import metadata from '../package.json' with { type: 'json' };
import { macBuildOptions } from './mac-build-options.mjs';
import { notarizeMacRelease } from './mac-release-artifacts.mjs';
import { packagedMacApp } from './mac-paths.mjs';

if (process.platform !== 'darwin') throw new Error('Run notarization on a Mac.');
const root = fileURLToPath(new URL('../', import.meta.url));
const { values } = parseArgs({ options: { arch: { type: 'string' } } });
const options = macBuildOptions({ arch: values.arch, release: true });
await notarizeMacRelease({ root, app: packagedMacApp(root, options.arch), version: metadata.version, ...options });
