import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mm, printFormat } from '../src/format';
import { spreadOrder } from '../src/spread-order';
import { chooseFormat, templateInfo, templateSchema } from '../src/template';
import { projectSchema } from '../src/project';

const template = templateInfo(chooseFormat(templateSchema.parse({
  id: 'ordering', version: '1', contract: 1,
  format: printFormat({ label: 'Test', trim: { width: mm(100), height: mm(100) }, bleed: mm(3), safe: mm(5),
    pageCount: { min: 20, max: 100, step: 2 } }),
  spreads: {
    opening: { label: 'Opening', span: 'right', render: () => null },
    body: { label: 'Body', render: () => null },
    closing: { label: 'Closing', span: 'left', render: () => null },
  },
})));
const spreads = projectSchema.parse({ schemaVersion: 1, title: 'Order', template: { id: 'ordering', version: '1' },
  spreads: ['opening', 'body', 'body', 'body', 'closing'].map((definition, i) => ({ id: 's' + i, definition })),
}).spreads;

test('moves use final indices, preserve content and do not mutate the input', () => {
  const before = structuredClone(spreads);
  assert.deepEqual(spreadOrder(spreads, 's1', 3, template)?.map(({ id }) => id), ['s0', 's2', 's3', 's1', 's4']);
  assert.deepEqual(spreadOrder(spreads, 's3', 1, template)?.map(({ id }) => id), ['s0', 's3', 's1', 's2', 's4']);
  assert.deepEqual(spreads, before);
  assert.equal(spreadOrder(spreads, 's1', 3, template)?.[3], spreads[1]);
  // The fixture is below its minimum page count; that does not prevent reordering.
});

test('end pages stay fixed and interior spreads cannot cross them', () => {
  for (let from = 0; from < spreads.length; from++) {
    for (let to = 0; to < spreads.length; to++) {
      const allowed = from !== to && from > 0 && from < 4 && to > 0 && to < 4;
      assert.equal(!!spreadOrder(spreads, spreads[from].id, to, template), allowed, `${from} → ${to}`);
    }
  }
});

test('unchanged, missing and out-of-range moves offer no edit', () => {
  for (const target of [-1, 1, 5, 1.5, NaN]) assert.equal(spreadOrder(spreads, 's1', target, template), undefined);
  assert.equal(spreadOrder(spreads, 'missing', 2, template), undefined);
});

test('full-spread books can reorder into either end', () => {
  const full = spreads.map((spread) => ({ ...spread, definition: 'body' }));
  for (const delivery of ['pages', 'spreads'] as const) {
    const format = { ...template.format, structure: { ...template.format.structure, ends: 'inside-covers' as const, delivery } };
    assert.deepEqual(spreadOrder(full, 's4', 0, { ...template, format })?.map(({ id }) => id), ['s4', 's0', 's1', 's2', 's3']);
    assert.deepEqual(spreadOrder(full, 's0', 4, { ...template, format })?.map(({ id }) => id), ['s1', 's2', 's3', 's4', 's0']);
  }
});

test('a book with two misplaced end pages can be repaired one move at a time', () => {
  const broken = [spreads[1], spreads[0], spreads[2], spreads[4], spreads[3]];
  const openingFixed = spreadOrder(broken, 's0', 0, template);
  assert.deepEqual(openingFixed?.map(({ id }) => id), ['s0', 's1', 's2', 's4', 's3']);
  assert.deepEqual(spreadOrder(openingFixed!, 's4', 4, template), spreads);
});

test('existing placement errors do not block unrelated moves or trade away valid end pages', () => {
  const broken = spreads.map((spread, i) => i === 2 ? { ...spread, definition: 'opening' } : spread);
  assert.deepEqual(spreadOrder(broken, 's1', 3, template)?.map(({ id }) => id), ['s0', 's2', 's3', 's1', 's4']);
  // This would fix the second opening page but displace the previously valid first one.
  assert.equal(spreadOrder(broken, 's2', 0, template), undefined);
  assert.equal(spreadOrder(broken, 's4', 3, template), undefined);
});

test('single pages incompatible with the delivery format do not freeze full-spread moves', () => {
  const format = { ...template.format, structure: { ...template.format.structure, delivery: 'spreads' as const } };
  assert.deepEqual(spreadOrder(spreads, 's1', 3, { ...template, format })?.map(({ id }) => id), ['s0', 's2', 's3', 's1', 's4']);
});
