import { spawnSync } from 'node:child_process';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// Unit tests for pure editor logic: each tests/*.test.ts is bundled with esbuild and run by node's test runner.
const root = fileURLToPath(new URL('../', import.meta.url));
const out = join(root, '.build', 'unit');
await rm(out, { recursive: true, force: true });
// The sync engine scenarios run against the memory store in tests/sync.test.ts. Their reruns against the folder, S3 and
// iCloud stores take minutes and belong to the full run (`--full`: `npm run test:unit:full`, and `npm run test:desktop`,
// which the nightly workflow runs); each store's own conformance tests run every time.
const full = process.argv.includes('--full');
const storeReruns = new Set(['sync-folder-store.test.ts', 'sync-s3-store.test.ts', 'sync-cloudkit-engine.test.ts']);
const tests = (await readdir(join(root, 'tests'))).filter((name) => name.endsWith('.test.ts') && (full || !storeReruns.has(name)));
await build({
  entryPoints: tests.map((name) => join(root, 'tests', name)), outdir: out, outExtension: { '.js': '.mjs' },
  bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'warning',
});
const { status } = spawnSync(process.execPath, ['--test', ...tests.map((name) => join(out, name.replace(/\.ts$/, '.mjs')))], { stdio: 'inherit' });
process.exit(status ?? 1);
