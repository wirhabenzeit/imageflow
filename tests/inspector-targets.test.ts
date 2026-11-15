import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspectorTargets } from '../src/inspector-targets';
import type { BookGeometry } from '../src/desktop';
const targets: BookGeometry['targets'] = [
  { spread: 'a', edits: ['title'], occurrence: 0, x: 20, y: 10, width: 100, height: 30 },
  { spread: 'a', edits: ['caption'], occurrence: 0, x: 20, y: 80, width: 100, height: 30 },
  { spread: 'b', edits: ['title'], occurrence: 0, x: 20, y: 200, width: 100, height: 30 },
];
test('inspector content is unchanged when canvas geometry scales and moves', () => {
  const resized = targets.map(target => ({ ...target, x: target.x * 2 + 50, y: target.y * 2 + 30, width: target.width * 2 }));
  assert.deepEqual(inspectorTargets(resized, 'a'), inspectorTargets(targets, 'a'));
});
test('content identity and reading order invalidate independently of pixel geometry', () => {
  const before = inspectorTargets(targets, 'a');
  assert.notDeepEqual(inspectorTargets(targets.map(t => ({ ...t, y: -t.y })), 'a'), before);
  assert.notDeepEqual(inspectorTargets(targets.map(t => ({ ...t, edits: ['changed'] })), 'a'), before);
  assert.deepEqual(inspectorTargets(targets, 'missing'), []);
});
test('duplicate occurrences and box-owned targets preserve the existing marked-content order', () => {
  const mixed: BookGeometry['targets'] = [
    ...targets,
    { ...targets[0], occurrence: 1, y: 0 },
    { ...targets[0], edits: ['boxes.hero.caption'], y: 8, owner: { type: 'box', id: 'hero' } },
  ];
  const expected = mixed.filter(t => t.spread === 'a' && !t.owner)
    .filter((t, i, all) => all.findIndex(other => other.edits.join(' ') === t.edits.join(' ')) === i)
    .sort((a, b) => Math.abs(a.y - b.y) > 4 ? a.y - b.y : a.x - b.x);
  const actual = inspectorTargets(mixed, 'a').filter(t => !t.owner)
    .filter((t, i, all) => all.findIndex(other => other.edits.join(' ') === t.edits.join(' ')) === i)
    .sort((a, b) => a.order - b.order);
  assert.deepEqual(actual.map(t => [t.edits, t.occurrence]), expected.map(t => [t.edits, t.occurrence]));
});
