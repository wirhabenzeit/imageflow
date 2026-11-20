import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentFootprint, leavesEditorAlone } from '../src/agent-footprint';
import { coverInstance } from '../src/project';

const batch = (...operations: unknown[]) => agentFootprint('apply_project_changes', { operations });

test('layout-local operations name their spread, page or cover', () => {
  assert.deepEqual(batch(
    { op: 'set_parameter', scope: 'spread', spread: 'a', key: 'heading', value: 'x' },
    { op: 'assign_source', spread: 'b', page: 'left', box: 'hero', photo: 'p' },
    { op: 'set_crop', cover: true, box: 'front', centerX: .5, centerY: .5, zoom: 1 },
    { op: 'swap_content', from: { spread: 'c', box: 'one' }, to: { spread: 'd', box: 'two' } },
  ), { units: [{ spread: 'a' }, { spread: 'b', page: 'left' }, { spread: coverInstance }, { spread: 'c' }, { spread: 'd' }] });
});

test('a cover parameter names the cover by its scope', () => {
  assert.deepEqual(batch({ op: 'set_parameter', scope: 'cover', key: 'heading', value: 'x' }), { units: [{ spread: coverInstance }] });
  assert.deepEqual(batch({ op: 'set_parameter', scope: 'box', cover: true, owner: 'front', key: 'k', value: 1 }), { units: [{ spread: coverInstance }] });
  const editor = { label: 'parameter editor', spread: 'a', field: 'heading' };
  assert.equal(leavesEditorAlone(batch({ op: 'set_parameter', scope: 'cover', key: 'heading', value: 'x' }), editor), true);
  assert.equal(leavesEditorAlone(batch({ op: 'set_parameter', scope: 'cover', key: 'heading', value: 'x' }), { ...editor, spread: coverInstance }), false);
});

test('book-wide, structural, unknown and malformed changes take the whole book', () => {
  for (const operation of [
    { op: 'set_title', title: 'T' }, { op: 'select_format', format: 'f' }, { op: 'set_parameter', scope: 'document', key: 'color', value: '#000' },
    { op: 'insert_spread', definition: 'x' }, { op: 'move_spread', spread: 'a', after: 'b' }, { op: 'remove_spread', spread: 'a' },
    { op: 'duplicate_spread', spread: 'a' }, { op: 'set_photo_metadata', photo: 'p', values: {} },
    { op: 'assign_source', spread: '$new', box: 'hero', photo: 'p' }, { op: 'clear_box', spread: 'a', page: 'middle', box: 'x' },
    { op: 'future_operation', spread: 'a' }, null, 'set_title',
  ]) assert.deepEqual(batch({ op: 'set_parameter', scope: 'spread', spread: 'z', key: 'k', value: 1 }, operation), { book: true }, JSON.stringify(operation));
  assert.deepEqual(batch(), { book: true });
  assert.deepEqual(agentFootprint('apply_project_changes', {}), { book: true });
  assert.deepEqual(agentFootprint('import_sources', { kind: 'photo', paths: ['a.jpg'] }), { book: true });
});

test('an editor keeps only its own spread, or its page of a split sheet', () => {
  const editor = { label: 'parameter editor', spread: 'a', field: 'heading' };
  assert.equal(leavesEditorAlone(batch({ op: 'clear_box', spread: 'b', box: 'x' }), editor), true);
  assert.equal(leavesEditorAlone(batch({ op: 'clear_box', spread: 'a', box: 'x' }), editor), false);
  assert.equal(leavesEditorAlone(batch({ op: 'set_title', title: 'T' }), editor), false);
  assert.equal(leavesEditorAlone(undefined, editor), false, 'an app without footprints keeps the old lock');
  const page = { ...editor, page: 'left' as const };
  assert.equal(leavesEditorAlone(batch({ op: 'clear_box', spread: 'a', page: 'right', box: 'x' }), page), true);
  assert.equal(leavesEditorAlone(batch({ op: 'clear_box', spread: 'a', page: 'left', box: 'x' }), page), false);
  assert.equal(leavesEditorAlone(batch({ op: 'switch_layout', spread: 'a', definition: 'y' }), page), false, 'the whole sheet includes the page');
  assert.equal(leavesEditorAlone(batch({ op: 'clear_box', spread: 'b', box: 'x' }), { label: 'Note' }), false, 'a focused field without a spread');
  assert.equal(leavesEditorAlone(batch({ op: 'clear_box', cover: true, box: 'x' }), { label: 'crop editor', spread: coverInstance }), false);
});
