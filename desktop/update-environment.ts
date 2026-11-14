import { execFile } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export const moveToApplications = 'Move ImageFlow to Applications, eject its disk image, and reopen it to receive updates.';
export const unwritableLocation = 'ImageFlow cannot update in this read-only or restricted location. Move it to Applications or ~/Applications and reopen it, or ask an administrator for help.';
export const signatureCheckFailed = 'ImageFlow could not finish checking its signature. Reopen the app to try again.';
export function updateLocationHint(bundle: string, downloads: string) {
  return bundle.includes('/AppTranslocation/') ||
    bundle.startsWith(resolve(downloads) + '/') ? moveToApplications : undefined;
}

export async function updateUnavailable({ packaged, platform, executable, downloads }: {
  packaged: boolean; platform: string; executable: string; downloads: string;
}): Promise<string | undefined> {
  if (!packaged || platform !== 'darwin') return 'Updates are available in the signed macOS release of ImageFlow.';
  const bundle = resolve(executable, '../../..');
  const hint = updateLocationHint(bundle, downloads);
  if (hint) return hint;
  try {
    await Promise.all([access(bundle, constants.W_OK), access(dirname(bundle), constants.W_OK)]);
  } catch { return unwritableLocation; }
  try {
    await execute('/usr/bin/codesign', ['--verify', '--strict', bundle], { timeout: 15000 });
    const { stderr } = await execute('/usr/bin/codesign', ['--display', '--verbose=4', bundle], { timeout: 15000 });
    if (!/^Authority=Developer ID Application:/m.test(stderr) || !/^TeamIdentifier=(?!not set$).+/m.test(stderr)) {
      return 'Updates are available in the Developer ID signed release of ImageFlow.';
    }
  } catch (error) {
    if ((error as { killed?: boolean }).killed || (error as NodeJS.ErrnoException).code === 'ETIMEDOUT') return signatureCheckFailed;
    return 'Updates are available in the Developer ID signed release of ImageFlow.';
  }
}
