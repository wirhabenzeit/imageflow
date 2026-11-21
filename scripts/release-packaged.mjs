// Stops a release before approval and credential access unless the Packaged app workflow already passed on the
// tagged commit. That workflow builds the app and runs the packaged smoke tests the release repeats after signing,
// so a commit that cannot pass them never costs a signing run. A failed or unfinished run is rerun from Actions
// (no credentials involved), then the Release workflow is rerun.
//
//   node scripts/release-packaged.mjs
// Needs GH_TOKEN (actions: read), GH_REPO and GITHUB_SHA.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const execute = promisify(execFile);
export const packagedWorkflow = 'packaged.yml';

/** `runs` are workflow runs for the tagged commit, as returned by the Actions API. */
export function requirePackagedRun(sha, runs) {
  const own = runs.filter((run) => run.head_sha === sha);
  const passed = own.find((run) => run.status === 'completed' && run.conclusion === 'success');
  if (passed) return passed;
  const open = own.find((run) => run.status !== 'completed');
  if (open) throw new Error(`The Packaged app run for ${sha.slice(0, 7)} has not finished (${open.html_url}). Wait for it, then rerun the release.`);
  const failed = own.find((run) => run.status === 'completed');
  if (failed) throw new Error(`The Packaged app run for ${sha.slice(0, 7)} ${failed.conclusion} (${failed.html_url}). Rerun its failed jobs; if it fails again, fix main and release a new version.`);
  throw new Error(`No Packaged app run exists for ${sha.slice(0, 7)}. Start "Packaged app" from Actions on that commit, wait for it to pass, then rerun the release.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { GITHUB_SHA: sha, GH_REPO: repo } = process.env;
  if (!sha || !repo) throw new Error('GITHUB_SHA and GH_REPO are required.');
  const { stdout } = await execute('gh', ['api', `repos/${repo}/actions/workflows/${packagedWorkflow}/runs?head_sha=${sha}&per_page=50`, '--jq', '.workflow_runs']);
  const run = requirePackagedRun(sha, JSON.parse(stdout));
  console.log('Packaged app tests passed on the tagged commit: ' + run.html_url);
}
