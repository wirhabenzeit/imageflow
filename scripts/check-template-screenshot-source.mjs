import { execFile } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { promisify } from 'node:util';

// The publisher checks current main after rendering finishes on a separate runner.
// Keep these paths aligned with template-screenshots.yml's push filter. A docs-only
// main update is fine; artwork from superseded app/sample code must not be proposed.
const inputs = ['sample', 'authoring', 'desktop', 'src', 'scripts', 'package.json', 'package-lock.json',
  'tsconfig.json', 'vite.config.ts', 'index.html', '.github/workflows/template-screenshots.yml'];
const source = process.argv[2];
if (!/^[a-f0-9]{40}$/.test(source ?? '')) throw new Error('Expected the rendered source commit SHA.');
const execute = promisify(execFile);
async function succeeds(args) {
  try { await execute('git', args); return true; }
  catch (error) {
    if (error.code === 1) return false;
    throw error; // Missing history/repository or other Git errors must stop publication.
  }
}
const current = await succeeds(['merge-base', '--is-ancestor', source, 'HEAD']) &&
  await succeeds(['diff', '--quiet', source, 'HEAD', '--', ...inputs]);
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `current=${current}\n`);
const message = current ? 'Screenshot rendering inputs still match main.' :
  'Skipped screenshot publication: main has newer rendering inputs. The next queued run will rebuild them; a manual run from main can also refresh them.';
console.log(message);
if (!current && process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, message + '\n');
