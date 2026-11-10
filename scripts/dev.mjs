// Development mode with hot reloading.
// - Each run opens a fresh copy of the starter project in a temporary folder, and a new fresh copy whenever
//   sample/starter changes, so the app always shows the current starter. `npm run dev -- --last` reopens the
//   project that was open last instead (for example a real book) and does not replace it.
// - Editor and render pages come from a Vite dev server: CSS changes apply in place, React components fast-refresh.
// - Main-process and preload changes rebuild with esbuild and restart Electron; the open project is reopened.
// - Project templates, texts, and photos already reload through the project watcher.
import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { cp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { context } from 'esbuild';
import { mainBuild, stageDesktop } from './stage-desktop.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
// Dev mode stages into its own folder, so builds and test runs, which restage .build/desktop, leave it alone.
const desktop = join(root, '.build', 'dev-desktop');

function freePort(start) {
  return new Promise((resolve) => {
    const probe = createNetServer();
    probe.once('error', () => resolve(freePort(start + 1)));
    probe.listen(start, 'localhost', () => probe.close(() => resolve(start)));
  });
}

const port = await freePort(5173);
process.env.IMAGEFLOW_DEV_PORT = String(port);
const { createServer } = await import('vite');
const vite = await createServer({ root, configFile: join(root, 'vite.config.ts'), clearScreen: false });
await vite.listen();
const devServer = 'http://localhost:' + port;
console.log('Vite dev server on ' + devServer);

await stageDesktop({ dev: true, destination: desktop });

// The project Electron opens on start and after each restart.
const devState = join(root, '.build', 'dev-project.json');
const starter = join(root, 'sample', 'starter');
const keepLast = process.argv.includes('--last');
await mkdir(join(tmpdir(), 'imageflow-dev'), { recursive: true });
const scratch = await realpath(join(tmpdir(), 'imageflow-dev'));
let fresh;
// Copies the starter like New Project does, removes the previous copy, and makes the copy the one to open.
async function freshProject() {
  const folder = join(scratch, 'Book ' + new Date().toTimeString().slice(0, 8).replaceAll(':', '.'));
  await rm(folder, { recursive: true, force: true });
  await cp(starter, folder, { recursive: true, filter: (path) => basename(path) !== '.imageflow' });
  const path = join(folder, 'project.json');
  const draft = JSON.parse(await readFile(path, 'utf8'));
  draft.title = 'Dev book';
  await writeFile(path, JSON.stringify(draft, null, 2) + '\n');
  if (fresh && fresh !== folder) await rm(fresh, { recursive: true, force: true });
  fresh = folder;
  await writeFile(devState, JSON.stringify({ folder, readOnly: false }));
  console.log('Fresh starter project: ' + folder);
}
if (!keepLast) {
  // Copies from earlier runs are not needed any more.
  await rm(scratch, { recursive: true, force: true });
  await mkdir(scratch, { recursive: true });
  await freshProject();
}
let child;
let restarting = false;
function start() {
  child = spawn(electron, [desktop], {
    stdio: 'inherit',
    env: { ...process.env, IMAGEFLOW_DEV_SERVER: devServer, IMAGEFLOW_DEV_STATE: devState, IMAGEFLOW_DEV_SAMPLE: join(root, 'sample') },
  });
  child.on('exit', () => {
    if (restarting) {
      restarting = false;
      start();
    } else void shutdown();
  });
}

let builds = 0;
const watcher = await context({
  ...mainBuild(desktop),
  plugins: [{
    name: 'restart-electron',
    setup(build) {
      build.onEnd((result) => {
        // The first build is the one watch() starts with; only later builds are code changes.
        if (builds++ === 0 || result.errors.length) return;
        console.log('Main process changed; restarting Electron…');
        restarting = true;
        child?.kill();
      });
    },
  }],
});
await watcher.watch();
start();

// A change to the starter (template, project, photos) opens a fresh copy of it. Several changes in a row, such as
// an editor saving a file, make one copy.
let refresh;
const starterWatcher = keepLast ? undefined : watch(starter, { recursive: true }, (_event, name) => {
  if (name && name.split(/[\\/]/).includes('.imageflow')) return;
  clearTimeout(refresh);
  refresh = setTimeout(async () => {
    try {
      await freshProject();
      console.log('Starter changed; restarting Electron with a fresh project…');
      restarting = true;
      child?.kill();
    } catch (error) {
      console.error('Could not copy the starter: ' + (error instanceof Error ? error.message : error));
    }
  }, 400);
});

async function shutdown() {
  starterWatcher?.close();
  await watcher.dispose();
  await vite.close();
  process.exit(0);
}
process.on('SIGINT', () => {
  restarting = false;
  if (child && child.exitCode === null) child.kill();
  else void shutdown();
});
