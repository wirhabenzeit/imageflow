import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectSchema } from '../src/project';
import { pullChanges, pullLabel } from '../src/pull-summary';

const book = (spreads: unknown[]) => projectSchema.parse({ schemaVersion: 1, title: 'Book', template: { id: 't', version: '1' }, spreads });
const spread = (id: string, heading = '') => ({ id, definition: 'story', params: { heading }, boxes: {}, elements: {} });

test('a sync pull says what it changed', () => {
  const changes = pullChanges(book([spread('a'), spread('b'), spread('c')]), book([spread('b', 'Edited'), spread('a'), spread('d'), spread('e')]),
    ['template/styles.css', 'template/index.tsx', 'texts/tx-1.md']);
  assert.deepEqual(changes, { spreads: { added: 2, removed: 1, changed: 1 }, files: ['template/index.tsx', 'template/styles.css', 'texts/tx-1.md'] });
  assert.equal(pullLabel(changes), 'Sync pull: 2 spreads added, 1 removed, 1 changed; 2 template files, 1 text');
  assert.equal(pullLabel({ spreads: { added: 0, removed: 1, changed: 0 }, files: [] }), 'Sync pull: 1 spread removed');
  assert.equal(pullLabel({ spreads: { added: 0, removed: 0, changed: 0 }, files: ['template/a.css'] }), 'Sync pull: 1 template file');
  assert.equal(pullLabel({ spreads: { added: 0, removed: 0, changed: 0 }, files: [] }), 'Sync pull', 'a change of photos or settings only');
});
