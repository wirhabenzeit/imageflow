import { execFile } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export const moveToApplications = 'Move ImageFlow to Applications, eject its disk image, and reopen it to receive updates.';
export const needsWriteAccess = 'ImageFlow can’t replace itself in this folder. Install updates from an administrator account, or move ImageFlow to a folder you can change.';
export const unsigned = 'Updates are available in the Developer ID signed release of ImageFlow.';
export function updateLocationHint(bundle: string, downloads: string) {
  // A disk image mounts its app at the top of the volume; an Applications folder on an external drive is fine.
  return bundle.includes('/AppTranslocation/') || /^\/Volumes\/[^/]+\/[^/]+\.app$/.test(bundle) ||
    bundle.startsWith(resolve(downloads) + '/') ? moveToApplications : undefined;
}

export async function updateUnavailable({ packaged, platform, executable, downloads }: {
  packaged: boolean; platform: string; executable: string; downloads: string;
}): Promise<string | undefined> {
  if (!packaged || platform !== 'darwin') return 'Updates are available in the signed macOS release of ImageFlow.';
  // Squirrel replaces the running bundle in place: Contents/MacOS/<executable> → the .app folder.
  const bundle = resolve(executable, '../../..');
  const hint = updateLocationHint(bundle, downloads);
  if (hint) return hint;
  try {
    await Promise.all([access(bundle, constants.W_OK), access(dirname(bundle), constants.W_OK)]);
  } catch { return needsWriteAccess; }
  try {
    await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], { timeout: 15000 });
    const { stderr } = await execute('/usr/bin/codesign', ['--display', '--verbose=4', bundle], { timeout: 15000 });
    if (!/^Authority=Developer ID Application:/m.test(stderr) || !/^TeamIdentifier=(?!not set$).+/m.test(stderr)) return unsigned;
  } catch { return unsigned; }
}
