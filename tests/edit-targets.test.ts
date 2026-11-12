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

test('an open editor stays on its node when an earlier node with the same field appears or disappears', () => {
  const before = numberOccurrences([node(10), node(300)]);
  const anchor = targetAnchor(before[1], before);
  const key = targetKey(before[1]);
  // A conditional heading appears above both: occurrence 1 is now the old first heading.
  const added = numberOccurrences([node(0), node(12), node(302)]);
  assert.equal(resolveTarget(added, key, anchor), added[2]);
  // The first heading disappears: occurrence 1 no longer exists.
  const removed = numberOccurrences([node(305)]);
  assert.equal(resolveTarget(removed, key, anchor), removed[0]);
  // Nothing changed in number: the key still names the node, even if it moved.
  const moved = numberOccurrences([node(10), node(40)]);
  assert.equal(resolveTarget(moved, key, anchor), moved[1]);
  // The field is gone from the sheet.
  assert.equal(resolveTarget(numberOccurrences([node(10, ['caption'])]), key, anchor), undefined);
});
