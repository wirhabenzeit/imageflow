import assert from 'node:assert/strict';
import { test } from 'node:test';
import { numberOccurrences, resolveTarget, targetAnchor, targetKey } from '../src/edit-targets';

const node = (y: number, edits = ['heading']) => ({ spread: 's1', edits, x: 10, y, width: 100, height: 20 });

test('repeated uses of a field are separate targets editing the same field', () => {
  const targets = numberOccurrences([node(10), node(50, ['caption']), node(300)]);
  assert.deepEqual(targets.map(({ occurrence }) => occurrence), [0, 0, 1]);
  assert.notEqual(targetKey(targets[0]), targetKey(targets[2]));
  assert.deepEqual(targets[0].edits, targets[2].edits);
  // The second heading resolves to itself, not to the first one.
  assert.equal(resolveTarget(targets, targetKey(targets[2])), targets[2]);
});

test('an open editor stays on its node when nodes with the same field appear or disappear', () => {
  const before = numberOccurrences([node(10), node(300)]);
  const anchor = targetAnchor(before[1]);
  const key = targetKey(before[1]);
  // A conditional heading appears above both: occurrence 1 is now the old first heading.
  const added = numberOccurrences([node(0), node(12), node(302)]);
  assert.equal(resolveTarget(added, key, anchor), added[2]);
  // The first heading disappears: occurrence 1 no longer exists.
  const removed = numberOccurrences([node(305)]);
  assert.equal(resolveTarget(removed, key, anchor), removed[0]);
  // The field is gone from the sheet.
  assert.equal(resolveTarget(numberOccurrences([node(10, ['caption'])]), key, anchor), undefined);
});

test('an unchanged count of nodes does not mean unchanged occurrence numbers', () => {
  // [conditional before, stable] becomes [stable, conditional after]: the editor stays on the stable node, which
  // is now occurrence 0, rather than jumping to the new occurrence 1.
  const before = numberOccurrences([node(10), node(150)]);
  const key = targetKey(before[1]);
  const after = numberOccurrences([node(150), node(400)]);
  assert.equal(resolveTarget(after, key, targetAnchor(before[1])), after[0]);
  // Without an anchor (the editor is opening), the key names the node.
  assert.equal(resolveTarget(after, key), after[1]);
});
