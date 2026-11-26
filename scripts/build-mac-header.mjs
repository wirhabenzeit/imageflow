import { execFile } from 'node:child_process';
import { access, mkdir, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));

/**
 * Builds a Node-API addon from desktop/native/<name>.mm into <destination>/native/<name>.node. Node-API keeps these
 * small modules independent of Electron's V8 ABI.
 */
export async function buildNativeAddon(name, frameworks, destination) {
  if (process.platform !== 'darwin') return;
  // Official Node binary distributions include Node-API headers next to bin/.
  const include = process.env.NODE_INCLUDE_DIR || join(dirname(dirname(await realpath(process.execPath))), 'include', 'node');
  try { await access(join(include, 'node_api.h')); }
  catch { throw new Error('Native addon builds need Node-API headers. Install the official Node.js distribution or set NODE_INCLUDE_DIR.'); }
  const output = join(destination, 'native');
  await mkdir(output, { recursive: true });
  await promisify(execFile)('xcrun', ['clang++', '-std=c++17', '-fobjc-arc', '-shared', '-undefined', 'dynamic_lookup',
    '-arch', process.arch === 'arm64' ? 'arm64' : 'x86_64',
    '-mmacosx-version-min=13.0', '-DNAPI_VERSION=8', ...frameworks.flatMap((framework) => ['-framework', framework]), '-I', include,
    join(root, 'desktop/native/' + name + '.mm'), '-o', join(output, name + '.node')]);
}

export const buildMacHeader = (destination) => buildNativeAddon('mac-header', ['AppKit'], destination);
/** The CloudKit bridge of the iCloud sync store (#292). It loads in every build and uses CloudKit only when entitled. */
export const buildCloudKit = (destination) => buildNativeAddon('cloudkit', ['Foundation', 'CloudKit', 'Security'], destination);
/** PhotoKit for the Apple Photos provider (ADR 0013). It loads in every build and asks for access only where it may. */
export const buildPhotos = (destination) => buildNativeAddon('photos', ['Foundation', 'AppKit', 'Photos', 'PhotosUI', 'ImageIO', 'CoreLocation', 'UniformTypeIdentifiers'], destination);
