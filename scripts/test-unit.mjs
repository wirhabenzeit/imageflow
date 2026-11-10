import { spawnSync } from 'node:child_process';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// Unit tests for pure editor logic: each tests/*.test.ts is bundled with esbuild and run by node's test runner.
const root = fileURLToPath(new URL('../', import.meta.url));
const out = join(root, '.build', 'unit');
await rm(out, { recursive: true, force: true });
const tests = (await readdir(join(root, 'tests'))).filter((name) => name.endsWith('.test.ts'));
await build({
  entryPoints: tests.map((name) => join(root, 'tests', name)), outdir: out, outExtension: { '.js': '.mjs' },
  bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'warning',
});
const { status } = spawnSync(process.execPath, ['--test', ...tests.map((name) => join(out, name.replace(/\.ts$/, '.mjs')))], { stdio: 'inherit' });
process.exit(status ?? 1);
