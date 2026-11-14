import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Field } from '../src/Fields';

const zoom = { type: 'number' as const, label: 'Zoom', default: 1, min: 1, max: 8, description: 'Higher values zoom in.' };
const field = (props: object) => renderToStaticMarkup(createElement(Field, { param: zoom, value: 1, change: () => {}, ...props }));

test('a parameter description is only the field tooltip: no button, no text under the field', () => {
  const html = field({});
  assert.match(html, /<div class="field" title="Higher values zoom in.">/);
  assert.doesNotMatch(html, /<button|field-description/);
});

test('a control description shows under the field and replaces the parameter help', () => {
  const html = field({ description: 'How close the map is.' });
  assert.match(html, /<small class="field-description">How close the map is.<\/small>/);
  assert.doesNotMatch(html, /title=/);
});

test('compact fields put the help in their tooltip', () => {
  assert.match(field({ compact: true }), /title="Zoom\nHigher values zoom in."/);
});
