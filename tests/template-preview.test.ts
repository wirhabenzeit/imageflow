import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';
import { mm, printFormat } from '../src/format';
import { previewAspectMismatch, previewMaxBytes, previewPath, trimAspect } from '../src/template-preview';
import { readTemplatePreview } from '../desktop/template-preview-file';

test('a preview path stays inside the template folder and names an image', () => {
  assert.equal(previewPath('./preview.jpg'), 'preview.jpg');
  assert.equal(previewPath('assets/cover.WEBP'), 'assets/cover.WEBP');
  for (const path of ['../preview.jpg', '/preview.jpg', 'assets/../preview.jpg', '.hidden/preview.jpg', 'node_modules/a.png',
    'preview.gif', 'preview', 'a\\\\b.png', 'assets//b.png', '.png']) assert.equal(previewPath(path), undefined, path);
});

test('the preview shape is the default format\'s trimmed page, with a tolerance', () => {
  const landscape = printFormat({ label: 'A4 landscape', trim: { width: mm(297), height: mm(210) }, bleed: mm(3), safe: mm(10),
    pageCount: { min: 2, max: 20, step: 2 } });
  const aspect = trimAspect(landscape);
  assert.ok(Math.abs(aspect - 297 / 210) < 1e-9);
  assert.equal(previewAspectMismatch(1200, 849, aspect), false);
  assert.equal(previewAspectMismatch(1200, 1200, aspect), true);
});

test('the app reads a preview file only when it can show it', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'imageflow-preview-'));
  try {
    const template = join(folder, 'template');
    await mkdir(join(template, 'assets'), { recursive: true });
    await writeFile(join(template, 'preview.jpg'), await sharp({ create: { width: 30, height: 20, channels: 3, background: '#000' } }).jpeg().toBuffer());
    const report = await readTemplatePreview(template, './preview.jpg');
    assert.deepEqual({ ...report, file: undefined }, { width: 30, height: 20, type: 'image/jpeg', bytes: (report as { bytes: number }).bytes, file: undefined });

    await writeFile(join(template, 'wrong.png'), await sharp({ create: { width: 4, height: 4, channels: 3, background: '#000' } }).jpeg().toBuffer());
    assert.match((await readTemplatePreview(template, 'wrong.png') as { problem: string }).problem, /contains a JPEG image/);
    await writeFile(join(template, 'text.png'), 'not an image');
    assert.match((await readTemplatePreview(template, 'text.png') as { problem: string }).problem, /could not be read|not a PNG/);
    assert.match((await readTemplatePreview(template, 'missing.jpg') as { problem: string }).problem, /does not exist/);
    assert.match((await readTemplatePreview(template, '../preview.jpg') as { problem: string }).problem, /inside the template folder/);
    await writeFile(join(folder, 'outside.jpg'), 'x');
    await symlink(join(folder, 'outside.jpg'), join(template, 'assets', 'linked.jpg'));
    assert.match((await readTemplatePreview(template, 'assets/linked.jpg') as { problem: string }).problem, /symbolic link/);
    // Intact headers with damaged pixels, which Chromium cannot show.
    const webp = await sharp({ create: { width: 45, height: 30, channels: 3, background: '#a53' } }).webp().toBuffer();
    webp.fill(0x41, 40, webp.length - 4);
    await writeFile(join(template, 'damaged.webp'), webp);
    assert.match((await readTemplatePreview(template, 'damaged.webp') as { problem: string }).problem, /damaged|could not be read/);
    await writeFile(join(template, 'large.jpg'), Buffer.alloc(previewMaxBytes + 1));
    assert.match((await readTemplatePreview(template, 'large.jpg') as { problem: string }).problem, /at most 2 MB/);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('the template schema accepts a preview path inside the template folder and template info carries it normalized', async () => {
  const { templateSchema } = await import('../src/template');
  const base = { id: 'p', version: '1', contract: 1, format: printFormat({ label: 'Square', trim: { width: mm(200), height: mm(200) }, bleed: mm(3), safe: mm(10),
    pageCount: { min: 2, max: 20, step: 2 } }), spreads: { a: { label: 'A', render: () => null } } };
  assert.equal(templateSchema.safeParse({ ...base, preview: './preview.jpg' }).success, true);
  const outside = templateSchema.safeParse({ ...base, preview: '../preview.jpg' });
  assert.equal(outside.success, false);
  assert.match(outside.error!.issues[0].message, /inside the template folder/);
});
