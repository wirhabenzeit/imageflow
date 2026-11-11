import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ImportReceipts } from '../desktop/import-receipts';

test('the duplicate-event grace begins at first consumption and repeated matches never extend it', () => {
  let now = 0;
  const receipts = new ImportReceipts(3, 60_000, () => now);
  receipts.set('photos/one.jpg', 'original');
  receipts.observe('photos/one.jpg');
  now = 90_000;
  assert.equal(receipts.get('photos/one.jpg'), 'original');
  assert.equal(receipts.consume('photos/one.jpg', 'original'), true);
  for (now = 100_000; now < 150_000; now += 10_000) {
    receipts.observe('photos/one.jpg');
    assert.equal(receipts.get('photos/one.jpg'), 'original');
    assert.equal(receipts.consume('photos/one.jpg', 'original'), true);
  }
  now = 150_000;
  receipts.observe('photos/one.jpg');
  assert.equal(receipts.get('photos/one.jpg'), undefined);
  assert.equal(receipts.size, 0);
});

test('receipt count is bounded and replacing a path refreshes only that receipt', () => {
  let now = 0;
  const receipts = new ImportReceipts(2, 100, () => now);
  receipts.set('one', 'a');
  receipts.set('two', 'b');
  receipts.consume('one', 'a');
  receipts.consume('two', 'b');
  now = 50;
  receipts.set('one', 'changed');
  receipts.set('three', 'c');
  assert.equal(receipts.size, 2);
  assert.equal(receipts.get('two'), undefined);
  now = 100;
  assert.equal(receipts.get('one'), 'changed');
  receipts.delete('one');
  assert.equal(receipts.get('one'), undefined);
  receipts.clear();
  assert.equal(receipts.size, 0);
});

test('queued events remain matched throughout a long busy operation and classification retries', () => {
  let now = 0;
  const receipts = new ImportReceipts(2048, 60_000, () => now, 120_000);
  receipts.set('photos/one.jpg', 'original');
  receipts.observe('photos/one.jpg');
  now = 10 * 60_000;
  assert.equal(receipts.size, 1);
  assert.equal(receipts.get('photos/one.jpg'), 'original');
  now += 90_000;
  assert.equal(receipts.get('photos/one.jpg'), 'original');
  assert.equal(receipts.consume('photos/one.jpg', 'original'), true);
  now += 59_999;
  assert.equal(receipts.get('photos/one.jpg'), 'original');
  now++;
  assert.equal(receipts.get('photos/one.jpg'), undefined);
});

test('events already queued when an import completes can pin newly registered receipts', () => {
  let now = 0;
  const receipts = new ImportReceipts(2048, 60_000, () => now, 120_000);
  receipts.set('photos/one.jpg', 'original', true);
  now = 10 * 60_000;
  assert.equal(receipts.get('photos/one.jpg'), 'original');
  assert.equal(receipts.consume('photos/one.jpg', 'external-change'), false);
  assert.equal(receipts.get('photos/one.jpg'), 'original');
  assert.equal(receipts.consume('photos/one.jpg', 'original'), true);
});

test('unobserved pending receipts expire and an already expired match cannot be resurrected', () => {
  let now = 0;
  const receipts = new ImportReceipts(2048, 60_000, () => now, 120_000);
  receipts.set('pending', 'value');
  now = 120_000;
  receipts.observe('pending');
  assert.equal(receipts.get('pending'), undefined);
  receipts.set('matched', 'value');
  receipts.consume('matched', 'value');
  now += 60_000;
  receipts.observe('matched');
  assert.equal(receipts.get('matched'), undefined);
});

test('a matched event queued before expiration survives its wait without renewing the grace', () => {
  let now = 0;
  const receipts = new ImportReceipts(2048, 60_000, () => now);
  receipts.set('one', 'value');
  receipts.consume('one', 'value');
  now = 59_000;
  receipts.observe('one');
  now = 150_000;
  assert.equal(receipts.get('one'), 'value');
  assert.equal(receipts.consume('one', 'value'), true);
  assert.equal(receipts.get('one'), undefined);
});

test('pending observed receipts remain count bounded', () => {
  const receipts = new ImportReceipts(2);
  receipts.set('one', 'a', true);
  receipts.set('two', 'b', true);
  receipts.set('three', 'c', true);
  assert.equal(receipts.size, 2);
  assert.equal(receipts.get('one'), undefined);
});
