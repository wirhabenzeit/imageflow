// Decides whether a pull request needs the macOS desktop smoke job. The job takes minutes of a hosted Mac and cannot
// tell a changed site page from a changed editor, so only changes that no desktop smoke script reads are skipped.
//
//   node scripts/ci-changes.mjs
// Reads EVENT_NAME, BASE_SHA and HEAD_SHA (set by ci.yml) and writes `desktop=true|false` to $GITHUB_OUTPUT.
// Anything unexpected (a push, a missing base, a failed diff) runs the job: skipping is only for a known-safe diff.
import { execFileSync } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const ignored = [
  /^site\//, /^spikes\//,
  /^docs\/(?:decisions|benchmarks|performance|images)\//,
  /^docs\/(?:releasing|signing)\.md$/, /^docs\/beta-testing-/,
  /^(?:README|ASSETS)\.md$/, /^LICENSE$/,
  // Other workflows and repository settings do not change the app. ci.yml defines this job, so it stays relevant.
  /^\.github\/(?!workflows\/ci\.yml$)/,
];

export function desktopRelevant(files) {
  return files.length === 0 || files.some((file) => !ignored.some((pattern) => pattern.test(file)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { EVENT_NAME, BASE_SHA, HEAD_SHA } = process.env;
  let relevant = true;
  if (EVENT_NAME === 'pull_request' && BASE_SHA && HEAD_SHA) {
    try {
      const files = execFileSync('git', ['diff', '--name-only', BASE_SHA + '...' + HEAD_SHA], { encoding: 'utf8' }).split('\n').filter(Boolean);
      relevant = desktopRelevant(files);
      console.log(`${files.length} changed file(s); desktop smoke tests ${relevant ? 'needed' : 'skipped (no change they read)'}.`);
    } catch (error) {
      console.log('Could not list the changed files (' + (error instanceof Error ? error.message : error) + '); running the desktop job.');
    }
  } else console.log('Not a pull request; running the desktop job.');
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, 'desktop=' + relevant + '\n');
}
