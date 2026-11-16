import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { bundledFontCoverage, bundledFontNames, fontCoverage } from '../desktop/fonts';

// The starter's fonts are Latin subsets in WOFF2: their character maps say what labels they can set.
const font = (name: string) => readFile(join(process.cwd(), 'sample/starter/template/fonts', name));
const covers = (ranges: [number, number][], char: string) => ranges.some(([first, last]) => char.codePointAt(0)! >= first && char.codePointAt(0)! <= last);

test('a WOFF2 font reports the characters its cmap maps to glyphs', async () => {
  const ranges = fontCoverage(await font('inter-latin-500-normal.woff2'))!;
  assert.ok(ranges.length > 0);
  for (const char of 'AZaz09é€–') assert.ok(covers(ranges, char), char + ' is in the Latin subset');
  for (const char of 'Жңğ') assert.ok(!covers(ranges, char), char + ' is not in the Latin subset');
  // Sorted and merged.
  for (let i = 1; i < ranges.length; i++) assert.ok(ranges[i][0] > ranges[i - 1][1] + 1);
});

test('bundled coverage is keyed by file and skips files that are not fonts or cannot be read', async () => {
  const files = new Map<string, Uint8Array>([['inter-ABC.woff2', await font('inter-latin-500-normal.woff2')],
    ['broken.woff2', new Uint8Array([1, 2, 3])], ['template.css', new TextEncoder().encode('body{}')]]);
  const coverage = bundledFontCoverage(files);
  assert.deepEqual(Object.keys(coverage), ['inter-ABC.woff2']);
  assert.equal(bundledFontCoverage(files), coverage, 'computed once per set of files');
  // The name table reader still works after sharing the table lookup.
  assert.ok(bundledFontNames(files).some((name) => /Inter/.test(name)));
});
