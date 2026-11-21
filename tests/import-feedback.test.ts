import assert from 'node:assert/strict';
import { test } from 'node:test';
import { importFeedback } from '../src/import-feedback';
const empty = { photos: 0, texts: 0, files: 0, skipped: 0, failed: 0 };
test('every completed import reports useful pluralized feedback, including parameter files', () => {
  assert.equal(importFeedback(1, { ...empty, photos: 1 }), 'Imported 1 photo.');
  assert.equal(importFeedback(1, { ...empty, files: 1 }), 'Imported 1 file.');
  assert.equal(importFeedback(3, { ...empty, photos: 2, texts: 1, skipped: 1, failed: 2 }), 'Imported 2 photos and 1 text. 1 unsupported file skipped. 2 unreadable or invalid files skipped.');
});
test('unsupported, unreadable, and empty selections have distinct explanations', () => {
  assert.equal(importFeedback(0, { ...empty, skipped: 7 }), 'No supported files were selected. 7 unsupported files skipped.');
  assert.equal(importFeedback(0, { ...empty, failed: 1 }), 'No files imported. 1 unreadable or invalid file skipped.');
  assert.match(importFeedback(0, empty), /No files found.*hidden files are ignored/);
});

test('files already in the book are counted, not imported again (F-044)', () => {
  assert.equal(importFeedback(216, { ...empty, photos: 53, existing: 163 }), 'Imported 53 photos; 163 files are already in this book.');
  assert.equal(importFeedback(1, { ...empty, existing: 1 }), '1 file is already in this book; nothing new to import.');
});
