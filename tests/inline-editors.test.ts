import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mm } from '../src/format';
import type { BookGeometry } from '../src/desktop';
import { anchoredTarget, hiddenOccurrence, inlineFits, inlinePlacement, presentationFor } from '../src/inline-editors';
import type { OpenEditor } from '../src/inline-editors';
import { p } from '../src/parameters';
import { capabilities, contract1Capabilities } from '../src/runtime-exports';
import { chooseFormat, templateInfo, templateSchema } from '../src/template';

// #102: inline editors are an additive extension of contract 1, opened on the page where they fit.
const format = {
  label: 'Inline test', trim: { width: mm(100), height: mm(100) },
  bleed: { top: mm(3), bottom: mm(3), outside: mm(3), binding: mm(0) },
  safe: { top: mm(5), bottom: mm(5), outside: mm(5), binding: mm(5) },
  structure: { delivery: 'pages', ends: 'single-pages', pageCount: { min: 2, max: 40, step: 2 } },
  output: { container: 'pdf', colorSpace: 'sRGB', transparency: 'allow' },
};
const render = () => null;
const component = () => null;
const declaration = ({ requires, element = 'inline', document = 'inline' }: { requires?: string[]; element?: string; document?: string } = {}) => ({
  id: 'inline', version: '1', contract: 1, format, ...(requires ? { requires } : {}),
  parameters: { marked: p.string({ label: 'Marked days', default: '' }) },
  editors: { days: { parameters: ['marked'], component, presentation: document } },
  spreads: {
    map: { label: 'Map', render, elements: { map: { label: 'Map', parameters: { zoom: p.number({ label: 'Zoom', default: 8, min: 0, max: 18 }) },
      editor: { parameters: ['zoom'], component, presentation: element } } } },
  },
});
const problems = (value: object) => {
  const result = templateSchema.safeParse(value);
  return result.success ? [] : result.error.issues.map(({ path, message }) => path.join('.') + ': ' + message);
};

test('inline-editors is a declared extension, not part of the frozen baseline', () => {
  assert.ok(capabilities.includes('inline-editors'));
  assert.ok(!(contract1Capabilities as readonly string[]).includes('inline-editors'));
});

test("presentation: 'inline' needs requires: ['inline-editors']; dialog stays the default", () => {
  assert.deepEqual(problems(declaration()), [
    "editors.days.presentation: presentation: 'inline' needs requires: ['inline-editors'].",
    "spreads.map.elements.map.editor.presentation: presentation: 'inline' needs requires: ['inline-editors'].",
  ]);
  assert.deepEqual(problems(declaration({ requires: ['inline-editors'] })), []);
  assert.match(problems(declaration({ requires: ['inline-editors'], element: 'floating' })).join(), /spreads\.map\.elements\.map\.editor\.presentation/);
  // Existing templates keep the panel, with or without the extension.
  const plain = templateInfo(chooseFormat(templateSchema.parse(declaration({ element: 'dialog', document: 'dialog' }))));
  assert.equal(plain.spreads.map.elements.map.editor?.presentation, 'dialog');
  assert.equal(plain.editors?.days.presentation, 'dialog');
  const { editors: _editors, ...withoutEditors } = declaration();
  const declared = templateSchema.parse({ ...withoutEditors, spreads: { map: { label: 'Map', render, elements: { map: { label: 'Map',
    parameters: { zoom: p.number({ label: 'Zoom', default: 8 }) }, editor: { parameters: ['zoom'], component } } } } } });
  assert.equal(declared.spreads.map.elements.map.editor?.presentation, 'dialog');
  const inline = templateInfo(chooseFormat(templateSchema.parse(declaration({ requires: ['inline-editors'] }))));
  assert.equal(inline.spreads.map.elements.map.editor?.presentation, 'inline');
  assert.equal(inline.editors?.days.presentation, 'inline');
});

const sheet = { spread: 's1', x: 32, y: 40, width: 800, height: 400, zoom: .5 };
const geometry: BookGeometry = {
  type: 'geometry', width: 900, height: 500, sheets: [sheet],
  boxes: [
    { spread: 's1', id: 'map', type: 'element', upright: true, x: 32, y: 40, width: 800, height: 400 },
    { spread: 's1', id: 'tilted', type: 'element', upright: false, x: 100, y: 100, width: 200, height: 200 },
  ],
  targets: [
    { spread: 's1', edits: ['document.marked'], occurrence: 0, upright: true, x: 700, y: 60, width: 40, height: 300 },
    { spread: 's1', edits: ['document.marked'], occurrence: 1, upright: true, x: 100, y: 60, width: 40, height: 300 },
  ],
};

test('an editor opens inline only when it asks for it and its rectangle is upright and large enough', () => {
  assert.equal(presentationFor('inline', geometry.boxes[0]), 'inline');
  assert.equal(presentationFor('dialog', geometry.boxes[0]), 'dialog');
  assert.equal(presentationFor(undefined, geometry.boxes[0]), 'dialog');
  // Rotated or skewed: transformed interaction geometry is not attempted; the panel is the fallback.
  assert.equal(presentationFor('inline', geometry.boxes[1]), 'dialog');
  // Not on the page, or too small to use.
  assert.equal(presentationFor('inline', undefined), 'dialog');
  assert.equal(presentationFor('inline', { x: 0, y: 0, width: 20, height: 400 }), 'dialog');
  assert.equal(presentationFor('inline', { x: 0, y: 0, width: 60, height: 60 }), 'dialog');
  assert.ok(inlineFits({ x: 0, y: 0, width: 40, height: 300 }));
});

test('the inline frame follows its element, scaled like the sheet, and hides only that occurrence', () => {
  const map: OpenEditor = { kind: 'element', spread: 's1', element: 'map', presentation: 'inline' };
  assert.deepEqual(inlinePlacement(geometry, map), { x: 32, y: 40, width: 800, height: 400, zoom: .5 });
  assert.deepEqual(hiddenOccurrence(map), { spread: 's1', element: 'map' });
  // In the panel nothing is placed on the page or hidden.
  assert.equal(inlinePlacement(geometry, { ...map, presentation: 'dialog' }), undefined);
  assert.equal(hiddenOccurrence({ ...map, presentation: 'dialog' }), undefined);
  // The element is off the page (another layout drawing): no placement, so the frame keeps its last place, hidden.
  assert.equal(inlinePlacement({ ...geometry, boxes: [] }, map), undefined);
});

test('an inline document editor sits on the marked node it was opened from, and follows it', () => {
  const days: OpenEditor = { kind: 'document', spread: 's1', layout: 'month', editor: 'days', presentation: 'inline', at: 's1|document.marked|1' };
  const target = anchoredTarget(geometry, days)!;
  assert.equal(target.occurrence, 1);
  assert.deepEqual(inlinePlacement(geometry, days, target), { x: 100, y: 60, width: 40, height: 300, zoom: .5 });
  assert.deepEqual(hiddenOccurrence(days, target), { spread: 's1', edits: 'document.marked', occurrence: 1 });
  // A re-render that renumbers the nodes keeps the editor on the node nearest to where it was.
  const anchor = { spread: 's1', edits: 'document.marked', x: (120 - 32) / 800, y: (210 - 40) / 400 };
  const renumbered = { ...geometry, targets: [{ ...geometry.targets[1], occurrence: 0 }, { ...geometry.targets[0], occurrence: 1 }] };
  assert.equal(anchoredTarget(renumbered, days, anchor)?.x, 100);
});
