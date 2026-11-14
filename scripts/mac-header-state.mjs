import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function buildMacHeaderState(work) {
  if (process.platform !== 'darwin') return undefined;
  const include = process.env.NODE_INCLUDE_DIR || join(dirname(dirname(realpathSync(process.execPath))), 'include/node');
  const output = join(work, 'mac-header-state.node');
  execFileSync('xcrun', ['clang++', '-std=c++17', '-fobjc-arc', '-shared', '-undefined', 'dynamic_lookup',
    '-arch', process.arch === 'arm64' ? 'arm64' : 'x86_64', '-mmacosx-version-min=13.0', '-DNAPI_VERSION=8',
    '-framework', 'AppKit', '-I', include, fileURLToPath(new URL('./fixtures/mac-header-state.mm', import.meta.url)), '-o', output]);
  return output;
}

export async function macHeaderState(window, helper) {
  return window.evaluate((window, helper) => {
    const require = process.getBuiltinModule('node:module').createRequire(process.execPath);
    return require(helper).inspect(window.getNativeWindowHandle());
  }, helper);
}
