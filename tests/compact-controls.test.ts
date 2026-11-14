import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compactParameter } from '../src/compact-controls';
import { p } from '../src/parameters';
test('only short discrete controls, toggles and numeric controls fit inline; files and text stay in overflow', () => {
  assert.equal(compactParameter(p.boolean({ label: 'Show', default: true })), true);
  assert.equal(compactParameter(p.number({ label: 'Size', default: 11, min: 8, max: 16 })), true);
  assert.equal(compactParameter(p.enum({ label: 'Columns', default: '1', options: ['1', '2', '3'] })), true);
  assert.equal(compactParameter(p.enum({ label: 'Kind', default: '1', options: ['1', '2', '3', '4', '5'] })), false);
  assert.equal(compactParameter(p.string({ label: 'Title', default: '' })), false);
  assert.equal(compactParameter(p.file({ label: 'Track', accept: ['.gpx'] })), false);
});
