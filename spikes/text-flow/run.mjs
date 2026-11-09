// Text-flow spike harness: runs both strategies on a fixed scenario, randomized box chains,
// a 20,000-word performance case, and checks hyphenation and preview/PDF line agreement.
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { markdownToHtml } from './markdown.mjs';

const root = new URL('./', import.meta.url);
const out = new URL('out/', root);
await mkdir(out, { recursive: true });
const corpus = await readFile(new URL('corpus.md', root), 'utf8');
const strategies = ['measure', 'columns'];

const css = `
@font-face { font-family: 'Source Serif 4'; font-weight: 400; src: url(../node_modules/@fontsource/source-serif-4/files/source-serif-4-latin-400-normal.woff2); }
@font-face { font-family: 'Source Serif 4'; font-weight: 700; src: url(../node_modules/@fontsource/source-serif-4/files/source-serif-4-latin-700-normal.woff2); }
@font-face { font-family: 'Source Serif 4'; font-style: italic; src: url(../node_modules/@fontsource/source-serif-4/files/source-serif-4-latin-400-italic.woff2); }
@font-face { font-family: 'Inter'; font-weight: 400; src: url(../node_modules/@fontsource/inter/files/inter-latin-400-normal.woff2); }
html, body { margin: 0; }
body { background: #ddd; }
.spread { position: relative; width: 588mm; height: 294mm; background: #f6f2e8; break-after: page; overflow: hidden; }
.box { position: absolute; overflow: hidden; outline: 0.2mm dashed #c9b; }
.print .box { outline: none; }

/* Template CSS for Markdown boxes. */
.editorial { font: 10.5pt/1.45 'Source Serif 4'; color: #222; column-gap: 6mm; overflow-wrap: break-word; }
.editorial.small { font-size: 9pt; }
.editorial.justify { text-align: justify; }
.editorial.justify p.split { text-align-last: justify; }
.editorial p { margin: 0; orphans: 2; widows: 2; }
.editorial p + p, .editorial p.cont + p { text-indent: 1.2em; }
.editorial p.cont { text-indent: 0; }
.editorial h1 { font-size: 20pt; line-height: 1.15; margin: 0 0 4mm; font-weight: 700; break-after: avoid; }
.editorial h2 { font: 400 9pt 'Inter'; letter-spacing: .12em; text-transform: uppercase; margin: 5mm 0 2mm; break-after: avoid; }
.editorial h3 { font-size: 11pt; font-style: italic; font-weight: 400; margin: 4mm 0 1mm; break-after: avoid; }
.editorial > :first-child { margin-top: 0; }
.editorial ul, .editorial ol { margin: 1.5mm 0; padding-left: 1.3em; }
.editorial li { orphans: 2; widows: 2; }
.editorial li.cont { list-style: none; }
.editorial blockquote { margin: 3mm 0 3mm 1.2em; font-style: italic; }
.editorial a { color: #2c5070; overflow-wrap: anywhere; }
.editorial.hyphenate { hyphens: auto; }
`;

function pageHtml(body, extraClass = '') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>${css}</style>
<script src="../flow.js"></script></head><body class="${extraClass}">${body}</body></html>`;
}

const mm = (v) => `${v}mm`;
const box = (id, b) => `<div id="${id}" class="box editorial ${b.cls ?? ''}" ${b.columns ? `data-columns="${b.columns}"` : ''}
  style="left:${mm(b.left ?? 0)};top:${mm(b.top ?? 0)};width:${mm(b.width)};height:${mm(b.height)}"></div>`;

// Fixed scenario: two spreads, five differently styled boxes plus one two-column box.
const scenario = [
  [
    { id: 'a', left: 30, top: 40, width: 110, height: 150 },
    { id: 'b', left: 324, top: 30, width: 120, height: 234 },
    { id: 'c', left: 454, top: 30, width: 104, height: 234, cls: 'small' },
  ],
  [
    { id: 'd', left: 30, top: 30, width: 70, height: 234, cls: 'small' },
    { id: 'e', left: 324, top: 30, width: 234, height: 120, columns: 2 },
    { id: 'f', left: 324, top: 170, width: 234, height: 94, cls: 'justify' },
  ],
];
const scenarioBody = scenario.map((spread) => `<div class="spread">${spread.map((b) => box(b.id, b)).join('')}</div>`).join('');
const sourceHtml = markdownToHtml(corpus);
// The scenario uses the corpus twice so that every box, including the two-column and justified ones, receives text.
const scenarioHtml = markdownToHtml(`${corpus}\n\n${corpus.replace('# North of the Arctic Circle', '# Part two')}`);

const browser = await chromium.launch({ channel: 'chrome' });
const tab = await browser.newPage({ viewport: { width: 2300, height: 1200 } });

async function open(name, body, extraClass) {
  const file = new URL(`${name}.html`, out);
  await writeFile(file, pageHtml(body, extraClass));
  await tab.goto(pathToFileURL(file.pathname).href);
  await tab.evaluate(() => document.fonts.ready);
  await tab.evaluate(async () => {
    // Make sure every face is loaded before measuring.
    await Promise.all([...document.fonts].map((face) => face.load()));
  });
}

// Coverage, overflow, list numbering, and rule checks on the current page.
async function check(html, ids) {
  return tab.evaluate(({ html, ids }) => {
    const strip = (text) => text.replace(/\s+/g, '');
    const template = document.createElement('template');
    template.innerHTML = html;
    const boxes = ids.map((id) => document.getElementById(id));
    const flowed = boxes.map((b) => b.textContent).join('') + (window.lastOverflow ?? '');
    const coverage = strip(flowed) === strip(template.content.textContent);
    const describe = (b) => ({
      id: b.id, w: Math.round(b.clientWidth), h: Math.round(b.clientHeight), cls: b.className, columns: b.dataset.columns,
      dy: b.scrollHeight - b.clientHeight, dx: b.scrollWidth - b.clientWidth,
      last: [...b.children].filter((c) => /\S/.test(c.textContent)).pop()?.outerHTML.slice(0, 90),
      lastBlockLines: (() => { const l = [...b.children].pop(); if (!l) return 0; const r = document.createRange(); r.selectNodeContents(l); return new Set([...r.getClientRects()].map((x) => Math.round(x.top))).size; })(),
    });
    const overflowing = boxes.filter((b) => b.scrollHeight > b.clientHeight + 1 || b.scrollWidth > b.clientWidth + 1).map(describe);
    const widowBoxes = boxes.filter((b) => Flow.ruleViolations(b).includes('widow')).map((b) => ({ ...describe(b), first: [...b.children][0]?.outerHTML.slice(0, 120), prevLast: b.previousElementSibling ? null : (b.parentElement.previousElementSibling?.querySelector('.box')?.lastElementChild?.outerHTML.slice(-80)) }));
    const headingEnd = boxes.slice(0, -1).filter((b) => Flow.ruleViolations(b).includes('heading at end')).map(describe);

    // Ordered-list numbers in reading order must be consecutive per source list.
    const numbers = new Map();
    for (const b of boxes) {
      for (const ol of b.querySelectorAll('ol')) {
        let n = Number(ol.getAttribute('start') ?? 1);
        for (const li of ol.querySelectorAll(':scope > li')) {
          if (!li.classList.contains('cont')) (numbers.get(ol.dataset.s) ?? numbers.set(ol.dataset.s, []).get(ol.dataset.s)).push(n);
          n += 1;
        }
      }
    }
    const listErrors = [...numbers.values()].filter((seq) => seq.some((n, i) => n !== seq[0] + i)).length;
    const violations = boxes.flatMap((b, i) => (i < boxes.length - 1 || window.lastOverflow ? Flow.ruleViolations(b) : []));
    const emptyBoxes = boxes.filter((b, i) => !/\S/.test(b.textContent) && boxes.slice(i + 1).some((n) => /\S/.test(n.textContent))).length;
    return { coverage, overflowing, headingEnd, widowBoxes, listErrors, violations, emptyBoxes };
  }, { html, ids });
}

async function flow(html, ids, strategy) {
  return tab.evaluate(({ html, ids, strategy }) => {
    const result = Flow.run(html, ids.map((id) => document.getElementById(id)), strategy);
    window.lastOverflow = result.overflowText;
    return { elapsed: result.elapsed, retries: result.results.reduce((s, r) => s + r.retries, 0), failed: result.results.filter((r) => r.failed).length, failures: result.results.filter((r) => r.failed), overflowChars: result.overflowText.length };
  }, { html, ids, strategy });
}

const report = {};

// ---- 1. Fixed scenario: screenshots, PDF, and preview/PDF line agreement ----
const ids = scenario.flat().map((b) => b.id);
for (const strategy of strategies) {
  await open(`scenario-${strategy}`, scenarioBody);
  const run = await flow(scenarioHtml, ids, strategy);
  const checks = await check(scenarioHtml, ids);
  const domLines = await tab.evaluate((ids) => Object.fromEntries(ids.map((id) => [id, Flow.lines(document.getElementById(id))])), ids);
  await tab.screenshot({ path: new URL(`scenario-${strategy}.png`, out).pathname, fullPage: true });

  // Print the flowed DOM as-is (no re-flow) to PDF and compare lines per box.
  await tab.evaluate(() => document.body.classList.add('print'));
  await tab.addStyleTag({ content: '@page { size: 588mm 294mm; margin: 0 } body { background: none }' });
  const pdf = new URL(`scenario-${strategy}.pdf`, out).pathname;
  await tab.pdf({ path: pdf, preferCSSPageSize: true, printBackground: true });
  const boxRects = await tab.evaluate((ids) => ids.map((id) => {
    const el = document.getElementById(id);
    const spread = el.parentElement;
    const r = el.getBoundingClientRect();
    const s = spread.getBoundingClientRect();
    const columns = Number(getComputedStyle(el).columnCount) || 1;
    const gap = parseFloat(getComputedStyle(el).columnGap) || 0;
    // CSS px → pt is × 0.75.
    return { id, page: [...document.querySelectorAll('.spread')].indexOf(spread), x: (r.left - s.left) * 0.75, y: (r.top - s.top) * 0.75,
      w: el.clientWidth * 0.75, h: el.clientHeight * 0.75, columns, gap: gap * 0.75 };
  }), ids);
  const bbox = execFileSync('pdftotext', ['-bbox', pdf, '-'], { encoding: 'utf8', maxBuffer: 64 << 20 });
  const pdfWords = [];
  let pageIndex = -1;
  for (const line of bbox.split('\n')) {
    if (line.includes('<page ')) pageIndex += 1;
    const m = line.match(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="[\d.]+" yMax="[\d.]+">(.*)<\/word>/);
    if (m && /^(\d+\.|[•◦▪])$/.test(m[3])) continue; // list markers
    if (m) pdfWords.push({ page: pageIndex, x: +m[1], y: +m[2], text: m[3].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'") });
  }
  const pdfLines = {};
  for (const b of boxRects) {
    const columnWidth = (b.w - b.gap * (b.columns - 1)) / b.columns;
    // Large type can have glyph tops slightly above the box; list markers sit left of it.
    const words = pdfWords.filter((w) => w.page === b.page && w.x >= b.x - 20 && w.x < b.x + b.w && w.y >= b.y - 8 && w.y < b.y + b.h)
      .map((w) => ({ ...w, column: Math.max(0, Math.floor((w.x - b.x + 1) / (columnWidth + b.gap))) }))
      .sort((p, q) => p.column - q.column || p.y - q.y || p.x - q.x);
    const lines = [];
    let current = null;
    for (const w of words) {
      if (!current || w.column !== current.column || w.y > current.y + 2) { current = { column: w.column, y: w.y, words: [] }; lines.push(current); }
      current.words.push(w.text);
    }
    pdfLines[b.id] = lines.map((l) => l.words.join(' '));
  }
  // Compare letters only: PDF text adds list markers, splits letter-spaced headings,
  // and keeps CSS text-transform; none of these affect where lines break.
  const norm = (s) => s.normalize('NFKC').replace(/^\s*(\d+\.|[•◦▪‣-])\s+/, '').replace(/\s+/g, '').toLowerCase();
  const lineAgreement = Object.fromEntries(ids.map((id) => {
    const dom = domLines[id].map(norm);
    const pdfL = pdfLines[id].map(norm).filter(Boolean);
    const mismatches = dom.map((l, i) => (l === pdfL[i] ? null : { i, dom: l, pdf: pdfL[i] })).filter(Boolean);
    return [id, { domLines: dom.length, pdfLines: pdfL.length, mismatches: mismatches.slice(0, 3), mismatchCount: mismatches.length + Math.abs(dom.length - pdfL.length) }];
  }));
  report[`scenario-${strategy}`] = { ...run, ...checks, lineAgreement };
  console.log(`scenario ${strategy}:`, JSON.stringify({ ...run, ...checks }), 'line mismatches:', Object.values(lineAgreement).reduce((s, v) => s + v.mismatchCount, 0));
}

// ---- 2. Randomized chains ----
function rng(seed) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
for (const [strategy, multicolumn] of [['measure', false], ['columns', false], ['columns', true]]) {
  const random = rng(42);
  const totals = { trials: 0, coverageFailures: 0, overflowBoxes: 0, listErrors: 0, emptyBoxes: 0, failedBoxes: 0, retries: 0, violations: {} };
  for (let trial = 0; trial < 120; trial++) {
    const chain = Array.from({ length: 6 }, (_, i) => {
      const width = 50 + random() * 110;
      return {
        id: `r${i}`, top: 0, left: 0, width, height: 25 + random() * 155,
        cls: [random() < 0.3 ? 'small' : '', random() < 0.3 ? 'justify' : ''].join(' '),
        columns: multicolumn && width > 100 && random() < 0.6 ? 2 : undefined,
      };
    });
    const body = chain.map((b) => `<div style="position:relative;height:${b.height + 4}mm">${box(b.id, b)}</div>`).join('');
    await open('random', body);
    const run = await flow(sourceHtml, chain.map((b) => b.id), strategy);
    const checks = await check(sourceHtml, chain.map((b) => b.id));
    totals.trials += 1;
    totals.coverageFailures += checks.coverage ? 0 : 1;
    totals.overflowBoxes += checks.overflowing.length;
    totals.listErrors += checks.listErrors;
    totals.emptyBoxes += checks.emptyBoxes;
    totals.failedBoxes += run.failed;
    totals.retries += run.retries;
    for (const v of checks.violations) totals.violations[v] = (totals.violations[v] ?? 0) + 1;
    totals.examples ??= [];
    for (const o of checks.overflowing) if (totals.examples.length < 6) totals.examples.push({ trial, kind: 'overflow', ...o });
    for (const o of checks.headingEnd) if (totals.examples.length < 10) totals.examples.push({ trial, kind: 'heading', ...o });
    for (const o of checks.widowBoxes) if (totals.examples.length < 14) totals.examples.push({ trial, kind: 'widow', ...o });
    for (const f of run.failures) if (totals.examples.length < 18) totals.examples.push({ trial, kind: 'failed', ...f });
  }
  const key = `random-${strategy}${multicolumn ? '-multicolumn' : ''}`;
  report[key] = totals;
  const { examples, ...summary } = totals;
  console.log(key, JSON.stringify(summary));
}

// ---- 3. Performance and edit stability: ~20,000 words through 100 boxes ----
const long = Array.from({ length: 14 }, (_, i) => corpus.replace('# North of the Arctic Circle', `# Part ${i + 1}`)).join('\n\n');
const longHtml = markdownToHtml(long);
const editedHtml = markdownToHtml(long.replace(/fjord(?![\s\S]*fjord)/, 'fjord, which by then was completely still'));
const perfIds = Array.from({ length: 100 }, (_, i) => `p${i}`);
const perfBody = perfIds.map((id) => `<div style="position:relative;height:234mm">${box(id, { width: 120, height: 230 })}</div>`).join('');
for (const strategy of strategies) {
  await open('perf', perfBody);
  const run = await flow(longHtml, perfIds, strategy);
  const before = await tab.evaluate((ids) => ids.map((id) => document.getElementById(id).innerHTML), perfIds);
  const checks = await check(longHtml, perfIds);
  await open('perf', perfBody);
  const run2 = await flow(editedHtml, perfIds, strategy);
  const after = await tab.evaluate((ids) => ids.map((id) => document.getElementById(id).innerHTML), perfIds);
  const firstChanged = before.findIndex((html, i) => html !== after[i]);
  const words = long.split(/\s+/).length;
  report[`perf-${strategy}`] = { words, boxes: 100, ms: Math.round(run.elapsed), msEdited: Math.round(run2.elapsed), firstChangedBox: firstChanged, ...checks, overflowChars: run.overflowChars };
  console.log(`perf ${strategy}:`, JSON.stringify(report[`perf-${strategy}`]));
}

// ---- 4. Hyphenation availability ----
const german = 'Die Straße wurde schmaler, als sie dem Fjord folgte. Als wir die letzte Kurve erreichten, hingen die Wolken so tief, dass sie die Berge verdeckten und nur das Wasser und ein weißes Haus am Ufer übrig ließen. Fotografinnen verbringen ganze Berufsleben damit, dieses gleichmäßige Licht im Studio nachzubilden.';
const english = corpus.split('\n\n').slice(1, 3).join(' ');
await open('hyphenation', `
  <div id="en" class="box editorial hyphenate" lang="en" style="position:relative;width:45mm;height:400mm"><p>${english}</p></div>
  <div id="de" class="box editorial hyphenate" lang="de" style="position:relative;width:45mm;height:400mm"><p>${german}</p></div>`);
report.hyphenation = await tab.evaluate(() => Object.fromEntries(['en', 'de'].map((id) => {
  const el = document.getElementById(id);
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let hyphenated = 0;
  const examples = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    for (const m of node.data.matchAll(/\S{6,}/g)) {
      range.setStart(node, m.index); range.setEnd(node, m.index + 1);
      const first = range.getClientRects()[0];
      range.setStart(node, m.index + m[0].length - 1); range.setEnd(node, m.index + m[0].length);
      const last = range.getClientRects()[0];
      if (first && last && last.top > first.top + 2) { hyphenated += 1; if (examples.length < 4) examples.push(m[0]); }
    }
  }
  return [id, { hyphenatedWords: hyphenated, examples }];
})));
console.log('hyphenation:', JSON.stringify(report.hyphenation));

await writeFile(new URL('report.json', out), JSON.stringify(report, null, 2));
await browser.close();
