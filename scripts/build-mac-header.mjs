import { execFile } from 'node:child_process';
import { access, mkdir, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));

export async function buildMacHeader(destination) {
  if (process.platform !== 'darwin') return;
  // Official Node binary distributions include Node-API headers next to bin/.
  // Node-API keeps this tiny module independent of Electron's V8 ABI.
  const include = process.env.NODE_INCLUDE_DIR || join(dirname(dirname(await realpath(process.execPath))), 'include', 'node');
  try { await access(join(include, 'node_api.h')); }
  catch { throw new Error('Mac header builds need Node-API headers. Install the official Node.js distribution or set NODE_INCLUDE_DIR.'); }
  const output = join(destination, 'native');
  await mkdir(output, { recursive: true });
  await promisify(execFile)('xcrun', ['clang++', '-std=c++17', '-fobjc-arc', '-shared', '-undefined', 'dynamic_lookup',
    '-arch', process.arch === 'arm64' ? 'arm64' : 'x86_64',
    '-mmacosx-version-min=13.0', '-DNAPI_VERSION=8', '-framework', 'AppKit', '-I', include,
    join(root, 'desktop/native/mac-header.mm'), '-o', join(output, 'mac-header.node')]);
}
