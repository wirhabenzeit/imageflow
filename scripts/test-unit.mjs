import { spawnSync } from 'node:child_process';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// Unit tests for pure editor logic: each tests/*.test.ts is bundled with esbuild and run by node's test runner.
const root = fileURLToPath(new URL('../', import.meta.url));
const out = join(root, '.build', 'unit');
await rm(out, { recursive: true, force: true });
// The sync engine scenarios (tests/sync.test.ts) take a quarter of an hour on a CI runner. Without `--full` only their
// core set runs, against the memory store; `--full` (`npm run test:unit:full`, and `npm run test:desktop`, which the
// nightly workflow runs) runs all of them, and again against the folder, S3 and iCloud stores. Each store's own
// conformance tests run every time.
const full = process.argv.includes('--full');
const storeReruns = new Set(['sync-folder-store.test.ts', 'sync-s3-store.test.ts', 'sync-cloudkit-engine.test.ts']);
const tests = (await readdir(join(root, 'tests'))).filter((name) => name.endsWith('.test.ts') && (full || !storeReruns.has(name)));
await build({
  entryPoints: tests.map((name) => join(root, 'tests', name)), outdir: out, outExtension: { '.js': '.mjs' },
  bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'warning',
});
const { status } = spawnSync(process.execPath, ['--test', ...tests.map((name) => join(out, name.replace(/\.ts$/, '.mjs')))],
  { stdio: 'inherit', env: { ...process.env, ...(full ? { IMAGEFLOW_TEST_FULL: '1' } : {}) } });
process.exit(status ?? 1);
