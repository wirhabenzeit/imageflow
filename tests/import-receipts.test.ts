import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ImportReceipts } from '../desktop/import-receipts';

test('import receipts suppress delayed duplicate events without extending retention', () => {
  let now = 0;
  const receipts = new ImportReceipts(3, 60_000, () => now);
  receipts.set('photos/one.jpg', 'original');
  for (now = 0; now < 60_000; now += 10_000) assert.equal(receipts.get('photos/one.jpg'), 'original');
  assert.equal(receipts.get('photos/one.jpg'), undefined);
  assert.equal(receipts.size, 0);
});

test('receipt count is bounded and replacing a path refreshes only that receipt', () => {
  let now = 0;
  const receipts = new ImportReceipts(2, 100, () => now);
  receipts.set('one', 'a');
  receipts.set('two', 'b');
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
