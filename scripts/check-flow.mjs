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
      contents: "export { flow } from './src/text-flow.js'; export { composeHtml, markdownBlocks, markdownToHtml } from './src/markdown.ts';",
      resolveDir: root,
    },
    bundle: true, write: false, format: 'iife', globalName: 'ImageFlowTest',
  });
  const source = await readFile(join(root, 'scripts/fixtures/flow.md'), 'utf8');
  const css = await readFile(join(root, 'tests/fixtures/field-notes/template/styles.css'), 'utf8');
  const fontRules = css.slice(0, css.indexOf('.field-notes'));
  const fonts = await Promise.all([...fontRules.matchAll(/url\("\.\/fonts\/([^"]+)"\)/g)].map(async ([url, file]) => [
    url, 'url(data:font/woff2;base64,' + (await readFile(join(root, 'tests/fixtures/field-notes/template/fonts', file))).toString('base64') + ')',
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
    .box [data-keep-next] { break-after: avoid; break-inside: avoid; }
    .box .date { font: 500 8pt "Field Sans"; }
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
  assert.deepEqual(results, [], 'Randomized text-flow chains');
  console.log('120 randomized Markdown flow checks passed.');

  // A text a template composed: a date and a title before the blocks, every second-level heading replaced by the
  // template's own element, and an end mark after them.
  const composed = await page.evaluate(async (source) => {
    const { flow, composeHtml, markdownBlocks } = ImageFlowTest;
    const blocks = markdownBlocks(source);
    const place = (i) => '<if-block data-i="' + i + '"></if-block>';
    const compose = (keep) => composeHtml(
      '<p class="date"' + keep + '>12 June</p><h3 class="title">Lake Song-Kul</h3>' +
      blocks.map((block, i) => block.type === 'heading' && block.depth === 2
        ? '<p class="date"' + keep + '>Day</p><div class="day-head"' + keep + '><span>Day ' + i + '</span><h3><if-block data-i="' + i + '" data-part="content"></if-block></h3></div>'
        : place(i)).join('') +
      '<p class="end">The end</p>', blocks);
    const html = compose(' data-keep-next');
    const original = document.createElement('template');
    original.innerHTML = html;
    const strip = (text) => text.replace(/\s+/g, '');
    const chain = (sizes) => {
      document.body.replaceChildren();
      return sizes.map(({ width, height, className = 'box' }) => {
        const host = document.createElement('div');
        host.className = 'host';
        host.style.height = height + 4 + 'mm';
        const box = document.createElement('div');
        box.className = className;
        Object.assign(box.style, { left: '0', top: '0', width: width + 'mm', height: height + 'mm' });
        host.append(box);
        document.body.append(host);
        return box;
      });
    };
    let seed = 7;
    const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const failures = [];
    for (let trial = 0; trial < 60; trial++) {
      // Boxes that hold a date, a title and two lines: smaller ones cannot keep them together.
      const boxes = chain(Array.from({ length: 7 }, () => ({ width: 70 + random() * 90, height: 50 + random() * 130,
        className: 'box' + (random() < .3 ? ' small' : '') })));
      const result = flow.run(html, boxes, 'columns');
      const fail = (issue) => failures.push({ trial, issue });
      if (strip(boxes.map((box) => box.textContent).join('') + result.overflowText) !== strip(original.content.textContent)) fail('content changed');
      if (boxes.some((box) => box.scrollHeight > box.clientHeight + 1 || box.scrollWidth > box.clientWidth + 1)) fail('clipped box');
      // A marked element at the end of a box counts as a heading there.
      const rules = boxes.flatMap((box, index) => index < boxes.length - 1 || result.overflowText ? flow.ruleViolations(box) : []);
      if (rules.length) fail(rules.join(', '));
      // What the template put before the blocks starts the first box that holds anything; nothing repeats it.
      const used = boxes.filter((box) => /\S/.test(box.textContent));
      if (used.length && !used[0].firstElementChild.matches('.date')) fail('lead is not first');
      if (used.slice(1).some((box) => box.querySelector('.title'))) fail('lead in a later box');
      if (!result.overflowText.trim()) {
        const last = used.at(-1).lastElementChild;
        if (!last.matches('.end') || document.querySelectorAll('.box .end:not(.cont)').length !== 1) fail('trail is not last');
      }
      // A replaced heading stays whole, behind its date.
      if (document.querySelector('.box :is(.day-head, .date):is(.split, .cont)')) fail('kept element split');
      for (const head of document.querySelectorAll('.box .day-head')) {
        if (!head.previousElementSibling?.matches('.date')) fail('day heading without its date');
      }
      // Every split element continues in a later box under the same number, composed or Markdown.
      for (const element of document.querySelectorAll('.box .split')) {
        if (!document.querySelector('.box ' + element.tagName + '.cont[data-s="' + element.dataset.s + '"]') && !result.overflowText) fail('split without continuation');
      }
    }
    // Keep-with-next, over a sweep of heights for the first box: with the mark, no box ends on a date or a day heading;
    // without it some do, so the sweep does test the rule.
    const endings = (markup) => {
      let count = 0;
      for (let height = 30; height <= 150; height += 2) {
        const boxes = chain([{ width: 90, height }, { width: 90, height: 4000 }]);
        flow.run(markup, boxes, 'columns');
        const last = [...boxes[0].children].filter((child) => /\S/.test(child.textContent)).pop();
        if (last?.matches('.date, .day-head')) count++;
      }
      return count;
    };
    const kept = endings(html);
    const unkept = endings(compose(''));
    // A long element of the template's own splits like a paragraph and is marked on both sides.
    const boxes = chain([{ width: 80, height: 30 }, { width: 80, height: 400 }]);
    flow.run('<p class="lead">' + 'A long lead that the template wrote itself. '.repeat(30) + '</p>' + compose(' data-keep-next'), boxes, 'columns');
    const marks = [boxes[0].firstElementChild.className, boxes[1].firstElementChild.className,
      boxes[0].firstElementChild.dataset.s === boxes[1].firstElementChild.dataset.s];

    // Edge cases for keep-with-next in composed texts:
    // 1. An empty [data-keep-next] element before a heading must not strand the heading.
    // 2. A heading or [data-keep-next] followed by a plain <div> (not p/li/h1-h6) still stays with it.
    // 3. A heading inside a wrapper <section> still stays with the paragraph after it.
    const edgeViolations = (markup) => {
      let count = 0;
      for (let height = 24; height <= 100; height += 2) {
        const pair = chain([{ width: 85, height }, { width: 85, height: 4000 }]);
        flow.run(markup, pair, 'columns');
        if (flow.ruleViolations(pair[0]).includes('heading at end')) count++;
      }
      return count;
    };
    const intro = '<p>' + 'An opening paragraph long enough to push the next section near the bottom of the box. '.repeat(4) + '</p>';
    const body = '<p>' + 'The following paragraph has several lines so the heading can move with it cleanly. '.repeat(4) + '</p>';
    const emptyKeptViolations = edgeViolations(intro + '<p class="date" data-keep-next></p><h3>Day Two</h3>' + body);
    const divFollowerViolations = edgeViolations(intro + '<h3 data-keep-next>Day Two</h3><div class="callout">' + 'Text directly inside a div element without a paragraph wrapper. '.repeat(4) + '</div>');
    const wrappedViolations = edgeViolations(intro + '<section class="day"><h2>Day Two</h2>' + body + '</section>');
    return { failures, kept, unkept, marks, emptyKeptViolations, divFollowerViolations, wrappedViolations };
  }, source);
  await page.close();
  assert.deepEqual(composed.failures, [], 'Randomized chains of a composed text');
  assert.equal(composed.kept, 0, 'A marked element ends a box');
  assert.ok(composed.unkept > 0, 'The keep-with-next sweep never reaches an unmarked element at the end of a box');
  assert.deepEqual(composed.marks, ['lead split', 'lead cont', true], 'Split marks of a composed element');
  assert.equal(composed.emptyKeptViolations, 0, 'Empty [data-keep-next] element stranded the following heading');
  assert.equal(composed.divFollowerViolations, 0, 'Kept heading stranded before a non-paragraph <div>');
  assert.equal(composed.wrappedViolations, 0, 'Heading inside a wrapper <section> stranded at end of box');
  console.log('60 randomized composed-text flow checks passed.');
}
