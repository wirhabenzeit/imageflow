// Development mode with hot reloading.
// - Editor and render pages come from a Vite dev server: CSS changes apply in place, React components fast-refresh.
// - Main-process and preload changes rebuild with esbuild and restart Electron; the open project is reopened.
// - Project templates, texts, and photos already reload through the project watcher.
import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { join } from 'node:path';
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
let child;
let restarting = false;
function start() {
  child = spawn(electron, [desktop], {
    stdio: 'inherit',
    env: { ...process.env, IMAGEFLOW_DEV_SERVER: devServer, IMAGEFLOW_DEV_STATE: join(root, '.build', 'dev-project.json') },
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

async function shutdown() {
  await watcher.dispose();
  await vite.close();
  process.exit(0);
}
process.on('SIGINT', () => {
  restarting = false;
  if (child && child.exitCode === null) child.kill();
  else void shutdown();
});
