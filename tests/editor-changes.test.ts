import assert from 'node:assert/strict';
import { test } from 'node:test';
import { editorChanges, unknownControl } from '../src/editor-changes';
import { p } from '../src/parameters';

const parameters = {
  month: p.date({ label: 'Month', default: '2027-01-01' }),
  firstWeekday: p.enum({ label: 'Week starts', default: 'monday', options: ['monday', 'sunday'] }),
  marked: p.string({ label: 'Marked days', default: '', maxLength: 10 }),
  zoom: p.number({ label: 'Zoom', default: 1, min: 1, max: 8 }),
};
const owned = ['month', 'marked', 'zoom'];

test('set() applies valid values of the editor\'s own parameters', () => {
  assert.deepEqual(editorChanges(parameters, owned, { month: '2027-03-01', marked: '3,14', zoom: 2.5 }),
    { allowed: { month: '2027-03-01', marked: '3,14', zoom: 2.5 }, rejected: [] });
});

test('set() reports an unknown key, naming the parameters the editor edits', () => {
  const { allowed, rejected } = editorChanges(parameters, owned, { zoon: 'large', marked: '1' });
  assert.deepEqual(allowed, { marked: '1' });
  assert.deepEqual(rejected, [{ key: 'zoon', message: 'set() ignored zoon: the element has no such parameter. This editor edits month, marked, zoom.' }]);
});

test('set() reports a parameter of the element that the generated controls edit', () => {
  const { allowed, rejected } = editorChanges(parameters, owned, { firstWeekday: 'sunday' });
  assert.deepEqual(allowed, {});
  assert.match(rejected[0].message, /^set\(\) ignored firstWeekday: it is not one of this editor's parameters/);
});

test('set() reports values the parameter does not allow, with what it takes', () => {
  const { allowed, rejected } = editorChanges(parameters, owned, { month: 'March', zoom: 12, marked: 3 });
  assert.deepEqual(allowed, {});
  assert.deepEqual(rejected.map(({ message }) => message), [
    'set() ignored month: "March" is not a valid value; Month takes an ISO date such as "2027-03-01".',
    'set() ignored zoom: 12 is not a valid value; Zoom takes a number from 1 to 8.',
    'set() ignored marked: 3 is not a valid value; Marked days takes a string of at most 10 characters.',
  ]);
  assert.match(editorChanges({ size: p.enum({ label: 'Size', default: 'a', options: ['a', 'b'] }) }, ['size'], { size: 'c' }).rejected[0].message,
    /Size takes one of "a", "b"\.$/);
});

test('set() with something other than an object applies nothing and says what it expects', () => {
  for (const changes of [undefined, 'month', ['month']]) {
    const { allowed, rejected } = editorChanges(parameters, owned, changes);
    assert.deepEqual(allowed, {});
    assert.equal(rejected[0].message, 'set() expects an object of parameter values, such as set({ month: … }).');
  }
});

test('an unknown Control lists the parameters it can show', () => {
  assert.equal(unknownControl('zoon', owned), 'Control "zoon" is not one of the parameters this editor edits. Use one of: month, marked, zoom.');
});
