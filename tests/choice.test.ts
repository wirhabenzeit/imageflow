import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Choice, nextChoice } from '../src/choice';

test('arrow keys move to the next enabled option and wrap around', () => {
  const enabled = [true, false, true, true];
  assert.equal(nextChoice(enabled, 0, 1), 2);
  assert.equal(nextChoice(enabled, 3, 1), 0);
  assert.equal(nextChoice(enabled, 0, -1), 3);
  assert.equal(nextChoice(enabled, 2, -1), 0);
  assert.equal(nextChoice(enabled, 2, 'first'), 0);
  assert.equal(nextChoice(enabled, 0, 'last'), 3);
  assert.equal(nextChoice([false, false], 0, 1), 0);
});

test('a choice is the app control: a labelled radio group with one tab stop', () => {
  const html = renderToStaticMarkup(createElement(Choice<number>, { label: 'Facing photos', value: 2, onChange: () => {},
    options: [{ value: 1, label: 'Full-page photo' }, { value: 2, label: 'Two photos' }, { value: 3, label: 'Three', disabled: true }] }));
  assert.match(html, /^<fieldset class="if-control if-choice"><div class="field"><span class="field-name" id="([^"]+)">Facing photos<\/span><div class="pc-segmented" role="radiogroup" aria-labelledby="\1">/);
  assert.match(html, /aria-checked="false"[^>]*tabindex="-1"[^>]*>Full-page photo/);
  assert.match(html, /aria-checked="true"[^>]*tabindex="0"[^>]*>Two photos/);
  assert.match(html, /disabled=""[^>]*tabindex="-1"[^>]*>Three/);
  const hidden = renderToStaticMarkup(createElement(Choice<string>, { label: 'Grid size', hideLabel: true, value: 'x', onChange: () => {},
    options: [{ value: 'a', label: 'A' }], disabled: true }));
  assert.match(hidden, /<fieldset class="if-control if-choice" disabled=""><div class="field"><div class="pc-segmented" role="radiogroup" aria-label="Grid size">/);
  assert.match(hidden, /tabindex="-1"/, 'nothing is focusable while the whole choice is disabled');
});
