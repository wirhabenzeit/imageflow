import assert from 'node:assert/strict';
import { test } from 'node:test';
import { declaredKey, declaredName, declaredNodes, findDeclared, notDrawnMessage, ownerOf, ownTarget, pageOf } from '../src/page-scope';

// The render frame finds boxes and elements by page as well as ID (ADR 0009). Unit tests run without a DOM, so this
// is a minimal element tree with the few DOM methods the lookups use: attribute selectors, closest and dataset.

type Selector = { name: string; value?: string };
const parse = (selectors: string): Selector[] => selectors.split(',').map((part) => {
  const match = /^\s*\[([\w-]+)(?:="([^"]*)")?\]\s*$/.exec(part);
  if (!match) throw new Error('Unsupported selector ' + part);
  return { name: match[1], value: match[2] };
});
const camel = (name: string) => name.slice(5).replace(/-(\w)/g, (_, letter: string) => letter.toUpperCase());

class Node {
  parentElement: Node | null = null;
  children: Node[] = [];
  constructor(readonly attributes: Record<string, string> = {}, children: Node[] = []) {
    for (const child of children) { child.parentElement = this; this.children.push(child); }
  }
  get dataset() {
    return Object.fromEntries(Object.entries(this.attributes).filter(([name]) => name.startsWith('data-')).map(([name, value]) => [camel(name), value]));
  }
  matches(selectors: string) {
    return parse(selectors).some(({ name, value }) => Object.hasOwn(this.attributes, name) && (value === undefined || this.attributes[name] === value));
  }
  closest(selectors: string): Node | null {
    for (let node: Node | null = this; node; node = node.parentElement) if (node.matches(selectors)) return node;
    return null;
  }
  querySelectorAll(selectors: string): Node[] {
    return this.children.flatMap((child) => [...(child.matches(selectors) ? [child] : []), ...child.querySelectorAll(selectors)]);
  }
}
const el = (attributes: Record<string, string>, ...children: Node[]) => new Node(attributes, children);
const asDom = <T,>(node: Node) => node as unknown as T;

// A spread shown as pages, each drawing a `hero`, and a sheet drawn by a spread layout with the same IDs.
const leftHero = el({ 'data-box': 'hero', 'data-box-type': 'photo' }, el({ class: 'caption' }));
const rightHero = el({ 'data-box': 'hero', 'data-box-type': 'photo' });
const rightGrid = el({ 'data-element': 'grid', 'data-edit': 'elements.grid.size' });
const split = el({ class: 'if-sheet' },
  el({ 'data-if-page': 'left' }, leftHero),
  el({ 'data-if-page': 'right' }, rightHero, rightGrid));
const spreadHero = el({ 'data-box': 'hero', 'data-box-type': 'photo' });
const whole = el({ class: 'if-sheet' }, el({ 'data-page': 'left' }, spreadHero));

test('boxes on a page are addressed by their page; on a spread layout by ID alone', () => {
  assert.deepEqual(declaredNodes(asDom<HTMLElement>(split)).map(declaredKey), ['left:box:hero', 'right:box:hero', 'right:element:grid']);
  assert.deepEqual(declaredNodes(asDom<HTMLElement>(whole)).map(declaredKey), ['spread:box:hero']);
  // A template's own `data-page` markup is not a page container.
  assert.equal(pageOf(asDom<Element>(spreadHero)), undefined);
});

test('a lookup finds only the box on the page it names', () => {
  const sheet = asDom<HTMLElement>(split);
  assert.equal(findDeclared(sheet, { box: 'hero', page: 'left' })[0].node, asDom<HTMLElement>(leftHero));
  assert.equal(findDeclared(sheet, { box: 'hero', page: 'right' })[0].node, asDom<HTMLElement>(rightHero));
  assert.deepEqual(findDeclared(sheet, { box: 'hero' }), [], 'no page means the spread layout, which this sheet does not draw');
  assert.deepEqual(findDeclared(sheet, { element: 'grid', page: 'left' }), []);
  assert.equal(findDeclared(asDom<HTMLElement>(whole), { box: 'hero' })[0].boxType, 'photo');
});

test('a target looked for without its page names the page that draws it (27 Nov)', () => {
  const sheet = asDom<HTMLElement>(split);
  assert.equal(notDrawnMessage(sheet, { element: 'grid' }, 's3'), 'Element grid is on the right page of spread s3, which shows page layouts: add "page": "right".');
  assert.equal(notDrawnMessage(sheet, { box: 'hero' }, 's3'), 'Both pages of spread s3 draw box hero: add "page": "left" or "right".');
  assert.equal(notDrawnMessage(sheet, { element: 'grid', page: 'left' }, 's3'), 'Element grid is not rendered on the left page of spread s3.');
  assert.equal(notDrawnMessage(sheet, { element: 'map' }, 's3'), 'The requested box or element is not rendered on spread s3.');
});

test('findings and edit targets name the page of their box or element', () => {
  assert.deepEqual(ownerOf(asDom<Element>(leftHero.children[0])), { box: 'hero', page: 'left' });
  assert.deepEqual(ownerOf(asDom<Element>(spreadHero)), { box: 'hero' });
  assert.deepEqual(ownerOf(asDom<Element>(split)), {});
  // Edit targets carry their page themselves (render.tsx uses pageOf for every target), so the owner only names the node.
  assert.deepEqual(ownTarget(asDom<HTMLElement>(rightGrid)), { owner: { type: 'element', id: 'grid' } });
  assert.equal(pageOf(asDom<Element>(rightGrid)), 'right');
  assert.deepEqual(ownTarget(asDom<HTMLElement>(spreadHero)), { owner: { type: 'box', id: 'hero' } });
  assert.equal(declaredName({ kind: 'box', id: 'hero', page: 'left' }), 'left page · box hero');
  assert.equal(declaredName({ kind: 'element', id: 'grid' }), 'element grid');
});

test('ordinary page artwork retains page attribution without a box or element', () => {
  const text = el({ 'data-edit': 'heading' });
  el({ 'data-if-page': 'right' }, text);
  assert.deepEqual(ownerOf(asDom<Element>(text)), { page: 'right' });
});

test('a further rectangle of a box belongs to that box without being a declared node', () => {
  const caption = el({ class: 'text' });
  const second = el({ 'data-box-rect': 'body', 'data-rect': '1', 'data-box-type': 'markdown' }, caption);
  const sheet = el({ class: 'if-sheet' }, el({ 'data-if-page': 'right' }, el({ 'data-box': 'body', 'data-box-type': 'markdown' }), second));
  assert.deepEqual(ownerOf(asDom<Element>(caption)), { box: 'body', page: 'right' });
  assert.deepEqual(declaredNodes(asDom<HTMLElement>(sheet)).map(declaredKey), ['right:box:body'], 'The rectangle is not a second box');
  const spreadSecond = el({ 'data-box-rect': 'body', 'data-rect': '1' });
  assert.deepEqual(ownerOf(asDom<Element>(spreadSecond)), { box: 'body' });
});
