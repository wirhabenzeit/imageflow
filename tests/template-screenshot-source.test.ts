import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

const script = resolve('scripts/check-template-screenshot-source.mjs');
function repository(t: { after(fn: () => void): void }) {
  const folder = mkdtempSync(join(tmpdir(), 'imageflow-screenshot-source-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: folder, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q'); git('config', 'user.name', 'Screenshot test'); git('config', 'user.email', 'screenshot-test@example.invalid');
  const commit = (file: string) => {
    mkdirSync(dirname(join(folder, file)), { recursive: true }); writeFileSync(join(folder, file), Math.random().toString());
    git('add', '--', file); git('commit', '-qm', 'Update ' + file); return git('rev-parse', 'HEAD');
  };
  const check = (source: string) => {
    const output = join(folder, 'job-output'), summary = join(folder, 'job-summary');
    writeFileSync(output, ''); writeFileSync(summary, '');
    const result = spawnSync(process.execPath, [script, source], { cwd: folder, encoding: 'utf8',
      env: { ...process.env, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary } });
    return { ...result, output: readFileSync(output, 'utf8'), summary: readFileSync(summary, 'utf8') };
  };
  return { git, commit, check };
}

test('publication accepts unchanged inputs and later documentation/image-only commits', (t) => {
  const { commit, check } = repository(t);
  const source = commit('src/render.tsx');
  assert.equal(check(source).output, 'current=true\n');
  commit('README.md'); commit('docs/guide/templates.md'); commit('docs/images/calendar-month.png');
  const result = check(source);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output, 'current=true\n');
  assert.equal(result.summary, '');
});

test('new sample, application, dependency and generator inputs reject old artwork', (t) => {
  const { commit, check } = repository(t);
  let source = commit('README.md');
  for (const path of ['sample/calendar/project.json', 'authoring/index.d.ts', 'desktop/export.ts', 'src/render.css',
    'scripts/generate-template-screenshots.mjs', 'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts',
    'index.html', '.github/workflows/template-screenshots.yml']) {
    const head = commit(path), result = check(source);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.output, 'current=false\n', path);
    assert.match(result.summary, /Skipped screenshot publication/);
    source = head;
  }
});

test('artwork from a commit outside current main is rejected even when inputs match', (t) => {
  const { git, commit, check } = repository(t);
  const main = commit('src/render.tsx');
  const unmerged = commit('README.md');
  git('checkout', '--detach', main);
  assert.equal(check(unmerged).output, 'current=false\n');
});

test('invalid or unavailable source history fails rather than being treated as an obsolete render', (t) => {
  const { commit, check } = repository(t); commit('README.md');
  for (const source of ['not-a-commit', '0'.repeat(40)]) {
    const result = check(source);
    assert.notEqual(result.status, 0);
    assert.equal(result.output, '');
  }
});
