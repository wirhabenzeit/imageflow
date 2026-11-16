// Runs desktop smoke scripts one after another, each with a time limit, and reports every failure at the end.
//
//   node scripts/run-smokes.mjs [--visible] smoke-desktop smoke-files …
// Hidden by default. --visible also runs compositor/native-focus checks which need an isolated desktop.
//
// A script that hangs (for example a Playwright call that never returns) is killed after SMOKE_TIMEOUT_MINUTES
// (default 6) together with the Electron app it started, so a hang costs minutes and names itself instead of running
// into the CI job limit. Later scripts still run, so one run shows all broken scripts rather than only the first.
import { spawn, execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const visible = process.argv.includes('--visible');
const names = process.argv.slice(2).filter((arg) => arg !== '--visible');
const needsDesktop = new Set(['smoke-inline-editors', 'smoke-mcp-context']);
const acceptsVisible = new Set([...needsDesktop, 'smoke-presentation-startup', 'smoke-presentation-window']);
if (!names.length) {
  console.error('Usage: node scripts/run-smokes.mjs [--visible] <smoke-script> …');
  process.exit(2);
}
const limit = Number(process.env.SMOKE_TIMEOUT_MINUTES || 6) * 60_000;
const annotate = !!process.env.GITHUB_ACTIONS;
const env = { ...process.env, IMAGEFLOW_HIDE_WINDOW: visible ? '' : '1' };
delete env.ELECTRON_RUN_AS_NODE;
let current;

// Playwright starts Electron in its own process group, so also stop any app still running from this checkout's build.
function killLeftovers() {
  try { execFileSync('pkill', ['-KILL', '-f', join(root, '.build', 'desktop')], { stdio: 'ignore' }); } catch {}
}
function stop(child) {
  try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  killLeftovers();
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { if (current) stop(current); process.exit(130); });

function run(name) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [join(root, 'scripts', name + '.mjs'),
      ...(visible && acceptsVisible.has(name) ? ['--visible'] : [])], {
      cwd: root, stdio: 'inherit', detached: true,
      env,
    });
    current = child;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; stop(child); }, limit);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      current = undefined;
      const seconds = Math.round((Date.now() - started) / 1000);
      resolve({ name, seconds, ok: code === 0 && !timedOut,
        reason: timedOut ? `timed out after ${limit / 60_000} min` : code !== 0 ? `exited with ${signal ?? 'code ' + code}` : '' });
    });
  });
}

const results = [];
const skipped = [];
for (const name of names) {
  if (!visible && needsDesktop.has(name)) {
    skipped.push(name);
    console.log(`↷ ${name} skipped: requires a visible desktop; rerun with --visible in CI or a VM.`);
    continue;
  }
  console.log(`\n▶ ${name}`);
  const result = await run(name);
  results.push(result);
  if (!result.ok) {
    console.error(`✖ ${name} ${result.reason}`);
    if (annotate) console.log(`::error title=${name}::${name} ${result.reason}`);
    killLeftovers();
  }
}

const failed = results.filter(({ ok }) => !ok);
console.log('\nSmoke scripts:');
for (const { name, ok, seconds, reason } of results) console.log(`  ${ok ? '✓' : '✖'} ${name} (${seconds} s)${ok ? '' : ' — ' + reason}`);
console.log((failed.length ? `\n${failed.length} of ${results.length} failed.` : `\nAll ${results.length} passed.`)
  + (skipped.length ? ` ${skipped.length} skipped (require --visible).` : ''));
process.exit(failed.length ? 1 : 0);
