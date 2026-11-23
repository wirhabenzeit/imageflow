import assert from 'node:assert/strict';
import test from 'node:test';
import { groupExtent, groupIssues, issueCause } from '../src/issue-groups';
import type { LeveledIssue } from '../src/issue-groups';
import { cachedPreviewNote } from '../src/source-locations';

const placed = (spread: string, message: string): LeveledIssue => ({ level: 'error', issue: { message, spread, where: 'Pages ' + spread, code: 'source-unavailable' } });
const asset = (message: string): LeveledIssue => ({ level: 'warning', issue: { message, code: 'project-input' } });

test('an issue’s cause leaves out the file, the asset and the cached-preview note', () => {
  assert.equal(issueCause({ message: 'Missing project file: photos/sunset.jpg' + cachedPreviewNote }), 'Missing project file');
  assert.equal(issueCause({ message: 'photo aurora · Missing project file: photos/aurora.jpg' }), 'Missing project file');
  assert.equal(issueCause({ message: 'photo ph-1 · Lightroom Classic is not running, or its ImageFlow plugin is not connected.' }),
    'Lightroom Classic is not running, or its ImageFlow plugin is not connected');
});

test('three or more issues with one cause and level become one group in place of the first; fewer stay single', () => {
  const items = [placed('a', 'Page count is 2.'), placed('a', 'Missing project file: photos/1.jpg'), placed('b', 'Missing project file: photos/2.jpg'),
    asset('photo one · Missing project file: photos/1.jpg'), placed('c', 'Missing project file: photos/3.jpg'), asset('photo two · Missing project file: photos/2.jpg')];
  const rows = groupIssues(items);
  assert.equal(rows.length, 4);
  assert.ok('item' in rows[0] && rows[0].item.issue.message === 'Page count is 2.');
  assert.ok('group' in rows[1]);
  if ('group' in rows[1]) {
    assert.equal(rows[1].group.cause, 'Missing project file');
    assert.equal(rows[1].group.items.length, 3);
    assert.equal(groupExtent(rows[1].group), '3 places on 3 spreads');
  }
  // Two warnings of the same cause are fewer than three: they stay single rows, in their order.
  assert.ok('item' in rows[2] && rows[2].item.level === 'warning');
  assert.ok('item' in rows[3] && rows[3].item.level === 'warning');
  const photos = groupIssues([asset('photo a · Original missing: /x/a.jpg'), asset('photo b · Original missing: /x/b.jpg'), asset('photo c · Original missing: /x/c.jpg')]);
  assert.ok('group' in photos[0] && groupExtent(photos[0].group) === '3 photos');
});
