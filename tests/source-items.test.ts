import assert from 'node:assert/strict';
import { test } from 'node:test';
import { excerpt, textChoices, words } from '../src/source-items';
import { sourceFileName } from '../src/source-locations';

const summary = (texts: Record<string, string | { path: string; linked: true }>) => ({ project: { texts } }) as unknown as Parameters<typeof textChoices>[0];

test('a created text is named by its readable name, without the storage ID', () => {
  assert.equal(sourceFileName('texts/tx-e33c351e-44e-1: Towards Kegety.md'), '1: Towards Kegety.md');
  assert.deepEqual(textChoices(summary({ 'tx-e33c351e-44e': 'texts/tx-e33c351e-44e-Towards Kegety.md' })),
    [['tx-e33c351e-44e', 'Towards Kegety.md']]);
});
test('linked texts keep their own file name', () => {
  assert.deepEqual(textChoices(summary({ a: { path: '/Users/me/Notes/Day 1.md', linked: true } })), [['a', 'Day 1.md']]);
});
test('texts that share a name are told apart by folder, else by a number', () => {
  assert.deepEqual(textChoices(summary({ a: { path: '/x/Kyrgyzstan/Intro.md', linked: true }, b: { path: '/x/Alps/Intro.md', linked: true } })),
    [['a', 'Intro.md — Kyrgyzstan'], ['b', 'Intro.md — Alps']]);
  assert.deepEqual(textChoices(summary({ 'tx-000000000001': 'texts/tx-000000000001-Intro.md', 'tx-000000000002': 'texts/tx-000000000002-Intro.md' })),
    [['tx-000000000001', 'Intro.md'], ['tx-000000000002', 'Intro.md (2)']]);
});

test('text tiles leave out the YAML header and name the text by its title (F-030)', () => {
  const day = '---\ntitle: Towards Kegety\ndate: 2026-08-17\nplaces:\n  - Kegety pass\n---\n\nWe left Bishkek early.\n';
  const { heading, body, meta } = excerpt(day);
  assert.equal(heading, 'Towards Kegety');
  assert.equal(body, 'We left Bishkek early.');
  assert.deepEqual(meta, { title: 'Towards Kegety', date: '2026-08-17', places: ['Kegety pass'] });
  assert.equal(words(day), 4);
  assert.equal(excerpt('# Day 1\n---\nRule above').heading, 'Day 1', 'a heading in the text wins, and a rule is not a header');
  assert.equal(excerpt('---\n\n---\nText').body, 'Text');
});
