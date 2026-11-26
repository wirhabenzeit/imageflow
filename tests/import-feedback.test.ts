import assert from 'node:assert/strict';
import { test } from 'node:test';
import { heicAdvice, importFeedback, isHeic } from '../src/import-feedback';
const empty = { photos: 0, texts: 0, files: 0, skipped: 0, failed: 0 };
test('every completed import reports useful pluralized feedback, including parameter files', () => {
  assert.equal(importFeedback(1, { ...empty, photos: 1 }), 'Imported 1 photo.');
  assert.equal(importFeedback(1, { ...empty, files: 1 }), 'Imported 1 file.');
  assert.equal(importFeedback(3, { ...empty, photos: 2, texts: 1, skipped: 1, failed: 2 }), 'Imported 2 photos and 1 text. 1 unsupported file skipped. 2 unreadable or invalid files skipped.');
});
test('unsupported, unreadable, and empty selections have distinct explanations', () => {
  assert.equal(importFeedback(0, { ...empty, skipped: 7 }), 'No supported files were selected. 7 unsupported files skipped.');
  assert.equal(importFeedback(0, { ...empty, skipped: 1, heic: 1 }), 'ImageFlow cannot read HEIC photos. 1 HEIC photo skipped. ' + heicAdvice);
  assert.equal(importFeedback(1, { ...empty, photos: 1, skipped: 3, heic: 2 }), 'Imported 1 photo. 2 HEIC photos skipped. ' + heicAdvice + ' 1 unsupported file skipped.');
  assert.ok(isHeic('/photos/IMG_0001.HEIC') && isHeic('a.heif') && !isHeic('heic.jpg'));
  assert.equal(importFeedback(0, { ...empty, failed: 1 }), 'No files imported. 1 unreadable or invalid file skipped.');
  assert.match(importFeedback(0, empty), /No files found.*hidden files are ignored/);
});

test('HEIC photos converted on import are named, as a JPEG copy the book stores (UI-013)', () => {
  assert.equal(importFeedback(2, { ...empty, photos: 2, converted: 1 }), 'Imported 2 photos. 1 HEIC photo was converted to JPEG and stored in the book.');
  assert.equal(importFeedback(3, { ...empty, photos: 3, converted: 3 }), 'Imported 3 photos. 3 HEIC photos were converted to JPEG and stored in the book.');
});

test('files already in the book are counted, not imported again (F-044)', () => {
  assert.equal(importFeedback(216, { ...empty, photos: 53, existing: 163 }), 'Imported 53 photos; 163 files are already in this book.');
  assert.equal(importFeedback(1, { ...empty, existing: 1 }), '1 file is already in this book; nothing new to import.');
});
