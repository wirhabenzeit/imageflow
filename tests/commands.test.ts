import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandRegistry, commandState, emptyMenuState } from '../src/commands';
import type { BookMenuState } from '../src/desktop';

const book: BookMenuState = { ...emptyMenuState, document: true, writable: true,
  history: { undo: 'Move photo' }, canExport: true, canPrint: false,
  enabled: { 'add-spread': true, 'duplicate-spread': true, 'delete-spread': true, 'move-spread-up': false, 'move-spread-down': true } };

test('document commands are unavailable without a document', () => {
  for (const id of Object.keys(commandRegistry) as (keyof typeof commandRegistry)[]) assert.equal(commandState(id, emptyMenuState).enabled, false, id);
});
test('menus and toolbar share history labels and export restrictions', () => {
  assert.equal(commandState('undo', book).label, 'Undo Move photo');
  assert.equal(commandState('undo', book).enabled, true);
  assert.equal(commandState('redo', book).enabled, false);
  assert.equal(commandState('export', book).enabled, true);
  assert.equal(commandState('print', book).enabled, false);
  assert.equal(commandState('print', { ...book, canPrint: true }).enabled, true);
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
