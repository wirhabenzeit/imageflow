import assert from 'node:assert/strict';
import { test } from 'node:test';
import { storageParts, storageText, unusedText } from '../src/sync-storage-text';

test('a book\u2019s storage is told by kind, without the kinds it has nothing of', () => {
  assert.deepEqual(storageParts({ bytes: 100, originals: 10, previews: 60, covers: 5 }), [{ label: 'Previews', bytes: 60 }, { label: 'Originals', bytes: 10 },
    { label: 'Covers', bytes: 5 }, { label: 'Texts, files and history', bytes: 25 }]);
  assert.deepEqual(storageParts({ bytes: 25, originals: 0, previews: 0, covers: 0 }).map(({ label }) => label), ['Texts, files and history']);
});

test('what is no longer used says how much, and from when Clean Up can free it', () => {
  const at = (day: number) => new Date(2026, 11, day, 23, 1).getTime();
  assert.equal(unusedText(null), 'What is no longer used cannot be told now.');
  assert.equal(unusedText({ now: 0, later: 0 }), 'All of it is in use.');
  assert.equal(unusedText({ now: 87_000_000, later: 0 }), '87 MB is no longer used. Clean Up can free it.');
  assert.equal(unusedText({ now: 0, later: 87_000_000, from: at(1), until: at(1) }), '87 MB is no longer used. Clean Up can free it from 1 December.');
  assert.equal(unusedText({ now: 0, later: 87_000_000, from: at(1), until: at(4) }), '87 MB is no longer used. Clean Up can free it between 1 December and 4 December.');
  assert.equal(unusedText({ now: 12_000_000, later: 75_000_000, from: at(1), until: at(4) }), '87 MB is no longer used. Clean Up can free 12 MB now and the rest by 4 December.');
});

test('a size\u2019s tooltip lists its kinds and then what is no longer used', () => {
  const storage = { bytes: 343_200_000, originals: 990_000, previews: 333_000_000, covers: 0 };
  const kinds = '343.2 MB\nPreviews: 333 MB\nOriginals: 990 KB\nTexts, files and history: 9.2 MB\n\n';
  assert.equal(storageText(storage, { now: 0, later: 0 }), kinds + 'All of it is in use.');
  assert.equal(storageText(storage, undefined), kinds + 'Looking for what is no longer used…');
  assert.equal(storageText(storage, { error: 'Cannot read it.' }), kinds + 'Cannot read it.');
});
