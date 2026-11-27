import assert from 'node:assert/strict';
import { test } from 'node:test';
import { unlabeledControl } from '../src/editor-label';

test('a focused control without a label is named by what and where it is (27 Nov)', () => {
  assert.equal(unlabeledControl('field', 'Search', 'Assets'), '"Search" field in Assets (focused)');
  assert.equal(unlabeledControl('menu', undefined, 'Inspector'), 'a menu in Inspector (focused)');
  assert.equal(unlabeledControl('text'), 'a text (focused)');
});
