import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import metadata from '../package.json' with { type: 'json' };
import { macBuildOptions } from './mac-build-options.mjs';
import { notarizeMacRelease } from './mac-release-artifacts.mjs';

if (process.platform !== 'darwin') throw new Error('Run notarization on a Mac.');
const root = fileURLToPath(new URL('../', import.meta.url));
const { values } = parseArgs({ options: { arch: { type: 'string' } } });
const options = macBuildOptions({ arch: values.arch, release: true });
await notarizeMacRelease({ root, app: join(root, 'out', 'ImageFlow-darwin-' + options.arch, 'ImageFlow.app'), version: metadata.version, ...options });
