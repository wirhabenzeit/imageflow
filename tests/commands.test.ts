import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandRegistry, commandState, emptyMenuState } from '../src/commands';
import type { BookMenuState } from '../src/desktop';

const book: BookMenuState = { ...emptyMenuState, document: true, writable: true,
  history: { undo: 'Move photo' }, canExport: true,
  enabled: { 'add-spread': true, 'duplicate-spread': true, 'delete-spread': true, 'move-spread-up': false, 'move-spread-down': true } };

test('document commands are unavailable without a document', () => {
  for (const id of Object.keys(commandRegistry) as (keyof typeof commandRegistry)[]) {
    if (/^(recent-|template-|issue-copy$)/.test(id)) continue;
    assert.equal(commandState(id, emptyMenuState).enabled, false, id);
  }
});
test('menus and toolbar share history labels and export restrictions', () => {
  assert.equal(commandState('undo', book).label, 'Undo Move photo');
  assert.equal(commandState('undo', book).enabled, true);
  assert.equal(commandState('redo', book).enabled, false);
  assert.equal(commandState('export', book).enabled, true);
  assert.equal('print' in commandRegistry, false, 'PDF export is the only export command');
  assert.equal(commandState('export', { ...book, canExport: false }).enabled, false);
  assert.equal(commandState('export', { ...book, busy: true }).enabled, false);
});
test('typing, busy and read-only states protect spread operations', () => {
  for (const patch of [{ editing: true }, { busy: true }, { writable: false }]) {
    for (const id of ['delete-spread', 'duplicate-spread', 'add-spread'] as const) assert.equal(commandState(id, { ...book, ...patch }).enabled, false);
  }
  assert.equal(commandState('move-spread-up', book).enabled, false);
  assert.equal(commandState('move-spread-down', book).enabled, true);
  assert.equal(commandState('grid-columns', book).enabled, false);
  assert.equal(commandState('grid-columns', { ...book, layout: { mode: 'grid', columns: 2 } }).enabled, true);
});


test('Swap Pages requires one eligible page pair and protects editing states', () => {
  const pair = { ...book, canSwapPages: true };
  assert.equal(commandState('swap-pages', pair).enabled, true);
  for (const patch of [{ canSwapPages: false }, { selectionCount: 2 }, { editing: true }, { busy: true }, { writable: false }]) {
    assert.equal(commandState('swap-pages', { ...pair, ...patch }).enabled, false);
  }
});

test('View shows each provider\'s marks as checkboxes that follow the book\'s view and the properties\' defaults', () => {
  assert.equal(commandState('photos-show-lightroom-rating', book).label, 'Show Stars');
  assert.equal(commandState('photos-show-lightroom-flag', book).label, 'Show Flags');
  assert.equal(commandState('photos-show-lightroom-color', book).label, 'Show Color Labels');
  assert.equal(commandState('photos-show-photos-favorite', book).label, 'Show Favorites');
  assert.equal(commandState('photos-show-lightroom-rating', book).checked, true);
  assert.equal(commandState('photos-show-lightroom-color', book).checked, false);
  const view = { sort: 'capture', group: 'none', gapMinutes: 120, showTime: false, showSource: true, sourceProps: { 'lightroom:rating': false, 'lightroom:color': true } } as const;
  assert.equal(commandState('photos-show-lightroom-rating', { ...book, photoView: view }).checked, false);
  assert.equal(commandState('photos-show-lightroom-color', { ...book, photoView: view }).checked, true);
  assert.equal(commandState('photos-show-photos-favorite', { ...book, photoView: view }).checked, true);
  assert.equal(commandState('photos-show-photos-favorite', { ...book, busy: true }).enabled, false);
});
