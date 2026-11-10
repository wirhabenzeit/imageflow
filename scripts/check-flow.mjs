import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { build } from 'esbuild';

export async function checkFlow(app, root) {
  const opened = app.waitForEvent('window');
  await app.evaluate(async ({ BrowserWindow }) => {
    const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
    await window.loadURL('about:blank');
  });
  const page = await opened;
  const { outputFiles } = await build({
    stdin: {
      contents: "export { flow } from './src/text-flow.js'; export { markdownToHtml } from './src/markdown.ts';",
      resolveDir: root,
    },
    bundle: true, write: false, format: 'iife', globalName: 'ImageFlowTest',
  });
  const source = await readFile(join(root, 'scripts/fixtures/flow.md'), 'utf8');
  const css = await readFile(join(root, 'sample/whitewall/template/styles.css'), 'utf8');
  const fontRules = css.slice(0, css.indexOf('.field-notes'));
  const fonts = await Promise.all([...fontRules.matchAll(/url\("\.\/fonts\/([^"]+)"\)/g)].map(async ([url, file]) => [
    url, 'url(data:font/woff2;base64,' + (await readFile(join(root, 'sample/whitewall/template/fonts', file))).toString('base64') + ')',
  ]));
  const faces = fonts.reduce((css, [url, data]) => css.replace(url, data), fontRules);
  await page.setContent(`<style>
    ${faces}
    .host { position: relative; }
    .box { position: absolute; overflow: hidden; font: 10.5pt/1.45 "Field Serif"; overflow-wrap: break-word; column-gap: 6mm; }
    .box.small { font-size: 9pt; }
    .box.justify { text-align: justify; }
    .box.justify p.split { text-align-last: justify; }
    .box p { margin: 0; orphans: 2; widows: 2; }
    .box p + p { text-indent: 1.2em; }
    .box .cont { text-indent: 0; }
    .box h1 { font: 600 20pt/1.15 "Field Serif"; margin: 0 0 4mm; break-after: avoid; }
    .box h2 { font: 500 9pt "Field Sans"; letter-spacing: .12em; text-transform: uppercase; margin: 5mm 0 2mm; break-after: avoid; }
    .box h3 { font: italic 400 11pt "Field Serif"; margin: 4mm 0 1mm; break-after: avoid; }
    .box > :first-child { margin-top: 0; }
    .box ul, .box ol { margin: 1.5mm 0; padding-left: 1.3em; }
    .box li { orphans: 2; widows: 2; }
    .box li.cont { list-style: none; }
    .box blockquote { margin: 3mm 0 3mm 1.2em; font-style: italic; }
    .box a { overflow-wrap: anywhere; }
  </style>`);
  await page.addScriptTag({ content: outputFiles[0].text });
  const results = await page.evaluate(async (source) => {
    await Promise.all([...document.fonts].map((font) => font.load()));
    const { flow, markdownToHtml } = ImageFlowTest;
    const html = markdownToHtml(source);
    const original = document.createElement('template');
    original.innerHTML = html;
    const strip = (text) => text.replace(/\s+/g, '');
    let seed = 42;
    const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const failures = [];
    for (let trial = 0; trial < 120; trial++) {
      document.body.replaceChildren();
      const boxes = Array.from({ length: 6 }, () => {
        const width = 50 + random() * 110;
        const height = 25 + random() * 155;
        const host = document.createElement('div');
        host.className = 'host';
        host.style.height = height + 4 + 'mm';
        const box = document.createElement('div');
        box.className = 'box' + (random() < .3 ? ' small' : '') + (random() < .3 ? ' justify' : '');
        Object.assign(box.style, { left: '0', top: '0', width: width + 'mm', height: height + 'mm' });
        host.append(box);
        document.body.append(host);
        return box;
      });
      const result = flow.run(html, boxes, 'columns');
      const flowed = boxes.map((box) => box.textContent).join('') + result.overflowText;
      if (strip(flowed) !== strip(original.content.textContent)) failures.push({ trial, issue: 'content changed' });
      if (boxes.some((box) => box.scrollHeight > box.clientHeight + 1 || box.scrollWidth > box.clientWidth + 1)) {
        failures.push({ trial, issue: 'clipped box' });
      }
      const rules = boxes.flatMap((box, index) => index < boxes.length - 1 || result.overflowText ? flow.ruleViolations(box) : []);
      if (rules.length) failures.push({ trial, issue: rules.join(', ') });
      const numbers = new Map();
      for (const box of boxes) {
        for (const list of box.querySelectorAll('ol')) {
          const order = numbers.get(list.dataset.s) ?? [];
          [...list.querySelectorAll(':scope > li')].forEach((item, i) => {
            if (!item.classList.contains('cont')) order.push((list.start || 1) + i);
          });
          numbers.set(list.dataset.s, order);
        }
      }
      if ([...numbers.values()].some((order) => order.some((number, i) => number !== order[0] + i))) {
        failures.push({ trial, issue: 'list numbering' });
      }
    }
    return failures;
  }, source);
  await page.close();
  assert.deepEqual(results, [], 'Randomized text-flow chains');
  console.log('120 randomized Markdown flow checks passed.');
}
