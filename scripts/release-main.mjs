import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const execute = promisify(execFile);
export async function verifyReleaseMain(cwd = process.cwd()) {
  try {
    await execute('git', ['rev-parse', '--verify', 'refs/remotes/origin/main^{commit}'], { cwd });
    await execute('git', ['merge-base', '--is-ancestor', 'HEAD', 'refs/remotes/origin/main'], { cwd });
  } catch (error) {
    if (error.code === 1) throw new Error('Tagged commit must be on origin/main before release.');
    throw new Error('Could not verify the tagged commit against origin/main. Fetch main with full history before releasing.', { cause: error });
  }
  console.log('Tagged commit is on origin/main.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await verifyReleaseMain();
