import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

// Import the scripts by URL: bundled into this file they would see themselves as the entry point and run their main code.
const script = <T>(name: string) => import(pathToFileURL(resolve('scripts', name + '.mjs')).href) as Promise<T>;
const { desktopRelevant } = await script<{ desktopRelevant(files: string[]): boolean }>('ci-changes');
const { requirePackagedRun } = await script<{ requirePackagedRun(sha: string, runs: unknown[]): unknown }>('release-packaged');
const { reloadBook } = await script<{ reloadBook(page: unknown, options?: { timeout?: number }): Promise<unknown> }>('ui-actions');
const { shardOf, storeReruns } = await script<{ shardOf(names: string[], shard: string): string[]; storeReruns: string[] }>('test-parts');

test('the nightly jobs together run the complete desktop suite', async () => {
  const workflow = await readFile('.github/workflows/desktop-full.yml', 'utf8');
  const scripts = JSON.parse(await readFile('package.json', 'utf8')).scripts as Record<string, string>;
  // The unit tests without the store reruns, and each rerun by itself.
  assert.match(workflow, /npm run test:unit:full -- --without-stores/);
  assert.deepEqual(/store: \[(.*)\]/.exec(workflow)![1].split(', ').sort(), [...storeReruns].sort());
  const files = await readdir('tests');
  for (const name of storeReruns) assert.ok(files.includes(name + '.test.ts'), name);
  // A test file that runs the sync scenarios again belongs to the reruns, or it would run beside them in the unit job.
  for (const name of files.filter((file) => file.endsWith('.test.ts') && file !== 'ci-workflow.test.ts')) {
    if (/import\('\.\/sync\.test'\)/.test(await readFile('tests/' + name, 'utf8'))) assert.ok(storeReruns.includes(name.replace('.test.ts', '')), name);
  }
  // Every smoke script of the suite in exactly one shard.
  const smokes = scripts['test:desktop:suite'].split(' ').filter((word) => word.startsWith('smoke-'));
  const shards = JSON.parse(/shard: (\[.*\])/.exec(workflow)![1].replaceAll("'", '"')) as string[];
  assert.deepEqual(shards.map((shard) => Number(shard.split('/')[1])), shards.map(() => shards.length));
  assert.deepEqual(shards.flatMap((shard) => shardOf(smokes, shard)).sort(), [...smokes].sort());
  assert.ok(smokes.length > 50 && new Set(smokes).size === smokes.length);
  // `npm run test:desktop` is all of it at once, and passes its arguments on.
  assert.match(scripts['test:desktop'], /test-unit\.mjs --full && npm run test:desktop:suite --$/);
});

test('a shard is every nth name, and a wrong one is refused', () => {
  assert.deepEqual(shardOf(['a', 'b', 'c', 'd', 'e'], '1/2'), ['a', 'c', 'e']);
  assert.deepEqual(shardOf(['a', 'b', 'c', 'd', 'e'], '2/2'), ['b', 'd']);
  for (const shard of ['0/2', '3/2', '1', '1/0', 'x']) assert.throws(() => shardOf(['a'], shard), /A shard is one of several/);
});

test('the desktop job is skipped only when every changed file is one no smoke script reads', () => {
  assert.equal(desktopRelevant(['site/index.html', 'docs/decisions/0009-x.md', 'README.md', 'docs/images/calendar-month.png', '.github/workflows/pages.yml']), false);
  for (const file of ['src/App.tsx', 'desktop/main.ts', 'scripts/smoke-desktop.mjs', 'sample/starter/template/index.tsx', 'package-lock.json',
    'docs/template-api/index.md', 'docs/guide/templates.md', 'skills/imageflow/SKILL.md', 'tests/compat/README.md', '.github/workflows/ci.yml', 'new-top-level-file']) {
    assert.equal(desktopRelevant(['site/index.html', file]), true, file);
  }
  assert.equal(desktopRelevant([]), true, 'an empty or unreadable diff runs the job');
});

const run = (over: Record<string, unknown>) => ({ head_sha: 'a'.repeat(40), status: 'completed', conclusion: 'success', html_url: 'https://example.invalid/run', ...over });

test('a release needs a passing packaged-app run on exactly the tagged commit', () => {
  const sha = 'a'.repeat(40);
  assert.ok(requirePackagedRun(sha, [run({ conclusion: 'failure' }), run({})]), 'a rerun that passed counts');
  assert.throws(() => requirePackagedRun(sha, []), /No Packaged app run exists for aaaaaaa/);
  assert.throws(() => requirePackagedRun(sha, [run({ head_sha: 'b'.repeat(40) })]), /No Packaged app run exists/);
  assert.throws(() => requirePackagedRun(sha, [run({ conclusion: 'failure' })]), /failure/);
  assert.throws(() => requirePackagedRun(sha, [run({ status: 'in_progress', conclusion: null })]), /has not finished/);
});

test('reloading the book waits out a busy book and fails loudly if the reload never happens', async () => {
  const page = (replies: unknown[]) => {
    let calls = 0;
    return { calls: () => calls, evaluate: async () => replies[Math.min(calls++, replies.length - 1)] } as never;
  };
  const busy = { error: 'ImageFlow is finishing another operation in this book.' };
  const ready = page([busy, { error: 'x', code: 'BOOK_BUSY' }, { value: { id: 'revision' } }]);
  assert.deepEqual(await reloadBook(ready), { id: 'revision' });
  assert.equal((ready as unknown as { calls(): number }).calls(), 3);
  await assert.rejects(reloadBook(page([{ error: 'Open a book first.' }])), /did not reload/);
  await assert.rejects(reloadBook(page([busy]), { timeout: 150 }), /did not reload/);
});
