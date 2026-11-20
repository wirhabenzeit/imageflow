// Runs desktop smoke scripts again and again on a loaded machine, to make timing-dependent failures show up locally.
// CI's hosted Macs have a few slow cores; this runs the app at background priority (the efficiency cores) while busy
// loops compete for them, which makes most scripts three to ten times slower.
//
//   npm run build && node scripts/stage-desktop.mjs
//   node scripts/stress-smokes.mjs [--runs 5] [--load 6] [--out .build/stress] smoke-ui-round2 smoke-quit …
//
// Prints each run's result and keeps the full log of every failed run in --out.
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  runs: { type: 'string', default: '5' }, load: { type: 'string', default: '6' }, out: { type: 'string' } } });
const root = fileURLToPath(new URL('../', import.meta.url));
const out = values.out ?? join(root, '.build', 'stress');
await mkdir(out, { recursive: true });
const hogs = Array.from({ length: Number(values.load) }, () => spawn('taskpolicy', ['-b', 'sh', '-c', 'while :; do :; done'], { stdio: 'ignore' }));
const stop = () => { for (const hog of hogs) hog.kill('SIGKILL'); };
process.on('exit', stop);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stop(); process.exit(130); });

const summary = {};
for (const name of positionals) {
  for (let run = 1; run <= Number(values.runs); run++) {
    const started = Date.now();
    const child = spawn('taskpolicy', ['-b', process.execPath, join(root, 'scripts/run-smokes.mjs'), '--visible', name], { cwd: root });
    let log = '';
    child.stdout.on('data', (chunk) => { log += chunk; });
    child.stderr.on('data', (chunk) => { log += chunk; });
    const code = await new Promise((resolve) => child.on('exit', resolve));
    const seconds = Math.round((Date.now() - started) / 1000);
    const failed = code !== 0 || /✖/.test(log);
    (summary[name] ??= []).push(failed ? '✖' : '✓');
    if (failed) await writeFile(join(out, `${name}-${run}.log`), log.split('\n').filter((line) => !line.startsWith('imageflow.')).join('\n'));
    console.log(`${failed ? '✖' : '✓'} ${name} run ${run} (${seconds} s)`);
  }
}
stop();
console.log('\n' + Object.entries(summary).map(([name, runs]) => `${name.padEnd(28)} ${runs.join('')}`).join('\n'));
