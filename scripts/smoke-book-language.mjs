import { closeApp, exportAction, testBook } from './ui-actions.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFile, cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';

// The book's language (API-024): a template declares `language`, every rendered page carries it as `lang`, so
// `hyphens: auto` hyphenates German in the editor, the Book check and the exported PDF alike. A Markdown text's `lang`
// header and `lang` on <Spread> override it for a part.
const root = fileURLToPath(new URL('../', import.meta.url));
const work = await mkdtemp(join(root, '.build', 'book-language-'));
const project = join(work, 'Sprache.imageflow');
await cp(join(root, 'tests/fixtures/field-notes'), project, { recursive: true, filter: (path) => !path.includes('/.imageflow') });

const templateFile = join(project, 'template/index.tsx');
const replace = (text, from, to) => { assert.ok(text.includes(from), 'The fixture template has ' + from); return text.replace(from, to); };
let template = await readFile(templateFile, 'utf8');
template = replace(template, "  contract: 1,\n", "  contract: 1,\n  language: 'de-ch',\n");
// The same layout once more, as text in no language (`zxx`), which nothing hyphenates: the control.
const layout = template.slice(template.indexOf('    story: {\n      label'), template.lastIndexOf('  },\n});'));
template = replace(template, layout, layout + layout.replace('    story: {', '    none: {').replace('<Spread className="field-notes">', '<Spread className="field-notes" lang="zxx">'));
await writeFile(templateFile, template);
// A narrow column with automatic hyphenation.
await appendFile(join(project, 'template/styles.css'), '\n.field-notes .story { width: 40mm; font-size: 11pt; hyphens: auto; }\n');

const german = 'Die Donaudampfschifffahrtsgesellschaft beschäftigte Rechtsschutzversicherungsgesellschaften und ' +
  'Lebensabschnittsgefährten aus der Grundstücksverkehrsgenehmigungszuständigkeitsübertragungsverordnung.';
await writeFile(join(project, 'texts/arrival.md'), german + '\n');
await writeFile(join(project, 'texts/control.md'), german + '\n');
await writeFile(join(project, 'texts/french.md'), '---\nlang: fr\n---\n\nL’anticonstitutionnellement extraordinairement.\n');
await writeFile(join(project, 'texts/wrong.md'), '---\nlang: Schweizerdeutsch!\n---\n\n' + german + '\n');
const file = join(project, 'project.json');
const book = JSON.parse(await readFile(file, 'utf8'));
Object.assign(book.texts, { control: 'texts/control.md', french: 'texts/french.md', wrong: 'texts/wrong.md' });
const spread = (id, definition, text) => ({ id, definition, params: { eyebrow: '', heading: '' }, boxes: { story: { text } } });
book.spreads = [spread('german', 'story', 'arrival'), spread('control', 'none', 'control'), spread('french', 'story', 'french'), spread('wrong', 'story', 'wrong')];
await writeFile(file, JSON.stringify(book, null, 2) + '\n');

const app = await _electron.launch({ executablePath: electron, args: [join(root, '.build/desktop'), '--user-data-dir=' + join(work, 'profile')],
  env: { ...process.env, IMAGEFLOW_HIDE_WINDOW: '1' } });
try {
  const w = await testBook(app, project);
  w.setDefaultTimeout(30000);
  await w.waitForSelector('iframe.book-frame-book[data-current][data-ready]', { state: 'attached' });
  const shown = await w.frameLocator('iframe.book-frame-book[data-current]').locator('body').evaluate(() => {
    const box = (spread) => document.querySelector('[data-spread="' + spread + '"] [data-box="story"]');
    const { errors, warnings } = window.imageflowRenderStatus;
    return {
      html: document.documentElement.lang,
      langs: Object.fromEntries(['german', 'control', 'french', 'wrong'].map((spread) => [spread, box(spread).closest('[lang]').lang])),
      // Each box's paragraph as laid out: its lines, and whether a word runs out of the column.
      lines: Object.fromEntries(['german', 'control'].map((spread) => {
        const paragraph = box(spread).querySelector('p');
        const range = document.createRange();
        range.selectNodeContents(paragraph);
        return [spread, new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size];
      })),
      hyphens: getComputedStyle(box('german')).hyphens,
      findings: [...errors, ...warnings].filter(({ code }) => /^text-/.test(code)).map(({ code, spread }) => [code, spread]),
    };
  });
  assert.equal(shown.html, 'de-CH', 'The book frame is in the template language, in its canonical form');
  assert.deepEqual(shown.langs, { german: 'de-CH', control: 'zxx', french: 'fr', wrong: 'de-CH' },
    'Spread lang and a text\'s lang header override the template language; an invalid header keeps the box\'s');
  assert.equal(shown.hyphens, 'auto');
  assert.deepEqual(shown.findings, [['text-lang-invalid', 'wrong']]);
  console.log('Lines of the narrow column: German ' + shown.lines.german + ', no language ' + shown.lines.control);

  // The thumbnails render in the same language.
  await w.waitForSelector('iframe.book-frame-thumbs[data-current][data-ready]', { state: 'attached' });
  assert.equal(await w.frameLocator('iframe.book-frame-thumbs[data-current]').locator('html').getAttribute('lang'), 'de-CH');

  // The Book check renders the book again in its own frame: the same findings.
  const checked = await w.evaluate(async () => window.imageflow.checkBook((await window.imageflow.currentProject()).value.id, {}));
  assert.ok(checked.value, JSON.stringify(checked.error));
  assert.deepEqual(checked.value.diagnostics.filter(({ code }) => /^text-/.test(code)).map(({ code }) => code), ['text-lang-invalid']);

  // The exported PDF is hyphenated in German: Chromium sets a hyphen (U+2010) where it broke a word. Text in no
  // language is not hyphenated, so its long words break only where the column ends (overflow-wrap).
  const output = join(work, 'sprache.pdf');
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    // The book is too short to print and has a warning; export it as a proof.
    dialog.showMessageBox = async () => ({ response: 1 });
  }, output);
  await exportAction(w);
  await w.waitForFunction(() => document.querySelector('.status-error') || document.querySelector('.status')?.textContent?.startsWith('PDF saved'), null, { timeout: 45000 });
  assert.match(await w.locator('.status').textContent(), /^PDF saved\./);
  const pageText = (page) => {
    try { return execFileSync('pdftotext', ['-f', String(page), '-l', String(page), '-raw', output, '-']).toString(); } catch (error) {
      if (error.code === 'ENOENT') throw new Error('Install Poppler to run the book language PDF checks.');
      throw error;
    }
  };
  const [hyphenated, control, french] = [2, 4, 6].map(pageText);
  console.log('German page in the PDF:\n' + hyphenated.trim());
  assert.match(hyphenated, /Donau‐?\s*dampf‐\s*schiff/u, 'German compounds are hyphenated in the PDF');
  assert.ok((hyphenated.match(/‐\n/gu) ?? []).length >= 4, 'Several lines end with a hyphen');
  assert.doesNotMatch(control, /‐/u, 'Text in no language is not hyphenated');
  assert.match(french, /anticonsti‐?\s*tu/u, 'The French text is hyphenated in French');
  console.log('ImageFlow book language passed.');
} finally {
  await closeApp(app);
  await rm(work, { recursive: true, force: true });
}
