import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import electron from 'electron';
import { desktop, esbuildBinary, sample } from './stage-desktop.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

/**
 * Renders the opening spread of every built-in template into `output` as `<template hash>.jpg`, the way the template
 * library saves renders, so the packaged app shows them in New Book on first launch. `app` is a staged desktop app
 * and `books` the sample folder it ships with. Returns the file names written.
 */
export async function renderTemplatePreviews({ app = desktop, books = sample, output = join(desktop, 'template-previews') } = {}) {
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  const work = await mkdtemp(join(root, '.build', 'template-previews-'));
  try {
    // Chromium refuses to run as root, as in CI containers, unless its sandbox is off.
    const sandbox = process.getuid?.() === 0 ? ['--no-sandbox'] : [];
    await promisify(execFile)(electron, [app, '--user-data-dir=' + join(work, 'profile'), ...sandbox], {
      env: { ...process.env, IMAGEFLOW_RENDER_TEMPLATE_PREVIEWS: output, IMAGEFLOW_SAMPLE: books, IMAGEFLOW_TEMPLATES: join(work, 'Templates'),
        IMAGEFLOW_HIDE_WINDOW: '1', ESBUILD_BINARY_PATH: esbuildBinary },
      timeout: 5 * 60 * 1000,
    });
  } finally { await rm(work, { recursive: true, force: true }); }
  const files = (await readdir(output)).filter((name) => /^[0-9a-f]{64}\.jpg$/.test(name));
  if (!files.length) throw new Error('No built-in template previews were rendered.');
  return files;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = await renderTemplatePreviews();
  console.log('Rendered ' + files.length + ' template previews.');
}
