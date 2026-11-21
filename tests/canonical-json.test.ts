import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalJson, canonicalJsonIndented, CanonicalJsonError } from '../src/canonical-json';

test('canonical JSON does not depend on key insertion order at any depth', () => {
  const a = { b: 1, a: { y: [1, { d: 1, c: 2 }], x: null }, 'é': 'z', Z: true };
  const b = { Z: true, 'é': 'z', a: { x: null, y: [1, { c: 2, d: 1 }] }, b: 1 };
  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.equal(canonicalJson(a), '{"Z":true,"a":{"x":null,"y":[1,{"c":2,"d":1}]},"b":1,"é":"z"}');
  assert.equal(canonicalJsonIndented(a), canonicalJsonIndented(b));
});

test('canonical JSON keeps array order and omits undefined properties', () => {
  assert.equal(canonicalJson([3, 1, 2]), '[3,1,2]');
  assert.equal(canonicalJson({ a: undefined, b: 1 }), '{"b":1}');
  assert.equal(canonicalJson({ a: [], b: {} }), '{"a":[],"b":{}}');
  assert.equal(canonicalJson(-0), '0');
});

test('canonical JSON matches JSON.stringify for input that is already sorted', () => {
  const value = { a: [1, 'two', { b: false }], c: 'd"e\n' };
  assert.equal(canonicalJson(value), JSON.stringify(value));
  assert.equal(canonicalJsonIndented(value), JSON.stringify(value, null, 2));
  assert.equal(canonicalJsonIndented({ a: [], b: {} }), JSON.stringify({ a: [], b: {} }, null, 2));
});

test('canonical JSON rejects values it cannot represent faithfully', () => {
  for (const value of [NaN, Infinity, () => 1, Symbol('s'), 1n, new Date(0), new Map(), new (class A { x = 1; })(), undefined, [1, undefined], { a: { b: NaN } }]) {
    assert.throws(() => canonicalJson(value), CanonicalJsonError);
  }
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  assert.throws(() => canonicalJson(cycle), /circular/);
  const shared = { a: 1 };
  assert.equal(canonicalJson([shared, shared]), '[{"a":1},{"a":1}]');
});
