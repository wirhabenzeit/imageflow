import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renameIds } from '../src/svg-ids';
import { photoBoxUid } from '../src/template';

// A minimal element tree: renameIds reads ids, attributes and descendants only.
type Fake = { id: string; attributes: { name: string; value: string }[]; children: Fake[]; querySelectorAll(selector: string): Fake[] };
function el(attributes: Record<string, string>, ...children: Fake[]): Fake {
  const list = Object.entries(attributes).map(([name, value]) => ({ name, value }));
  const node: Fake = {
    get id() { return list.find(({ name }) => name === 'id')?.value ?? ''; },
    set id(value: string) { const attribute = list.find(({ name }) => name === 'id'); if (attribute) attribute.value = value; else list.push({ name: 'id', value }); },
    attributes: list, children,
    querySelectorAll(selector: string) {
      const all = children.flatMap((child) => [child, ...child.querySelectorAll('*')]);
      return selector === '[id]' ? all.filter((child) => child.id) : all;
    },
  };
  return node;
}
const attr = (node: Fake, name: string) => node.attributes.find((attribute) => attribute.name === name)?.value;

test('a copied sheet gets its own SVG ids and its references follow them', () => {
  const clip = el({ id: 'if-3-one-hero' });
  const image = el({ 'clip-path': 'url(#if-3-one-hero)', style: "mask: url('#fade')", href: 'imageflow://render/b/photo/x' });
  const use = el({ href: '#if-3-one-hero', 'xlink:href': '#fade' });
  const outside = el({ fill: 'url(#elsewhere)' });
  const sheet = el({ class: 'sheet' }, el({}, clip, el({ id: 'fade' })), image, use, outside);
  renameIds(sheet as unknown as Element, '-p1');
  assert.equal(clip.id, 'if-3-one-hero-p1');
  assert.equal(attr(image, 'clip-path'), 'url(#if-3-one-hero-p1)');
  assert.equal(attr(image, 'style'), "mask: url('#fade-p1')");
  assert.equal(attr(image, 'href'), 'imageflow://render/b/photo/x');
  assert.equal(attr(use, 'href'), '#if-3-one-hero-p1');
  assert.equal(attr(use, 'xlink:href'), '#fade-p1');
  assert.equal(attr(outside, 'fill'), 'url(#elsewhere)', 'references outside the copy are left alone');
});

test('photo box uids keep hyphenated spread and box pairs apart', () => {
  assert.notEqual(photoBoxUid('one-x', 'hero'), photoBoxUid('one', 'x-hero'));
  assert.notEqual(photoBoxUid('a-1', '2'), photoBoxUid('a', '1-2'));
});
