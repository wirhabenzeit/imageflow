import assert from 'node:assert/strict';
import { test } from 'node:test';
import { controlCycles, controlLayout, controlProblems, layoutFields, matches } from '../src/controls';
import { declarationWarnings, withoutReachableControls } from '../src/declaration-check';
import type { Schema } from '../src/declaration-check';
import { mm, printFormat } from '../src/format';
import { p } from '../src/parameters';
import { templateInfo, chooseFormat, templateSchema } from '../src/template';

const parameters = {
  show: p.boolean({ label: 'Show stamp', default: true }),
  kind: p.enum({ label: 'Kind', default: 'text', options: ['text', 'file'] }),
  text: p.string({ label: 'Text', default: 'Visited' }),
  track: p.file({ label: 'Track', accept: ['.gpx'] }),
  tilt: p.number({ label: 'Tilt', default: 0, min: -30, max: 30 }),
};
const values = { show: true, kind: 'text', text: 'Visited', track: '', tilt: 0 };

test('without controls, every parameter gets a control in declaration order, minus excluded ones', () => {
  assert.deepEqual(controlLayout(parameters, undefined, values, ['track']).map((node) => node.kind === 'field' && node.key),
    ['show', 'kind', 'text', 'tilt']);
});

test('controls order, label, describe, group and conditionally hide controls without touching values', () => {
  const controls = [
    'show',
    { group: 'Stamp', description: 'How the stamp looks.', when: { show: true }, controls: [
      'kind',
      { parameter: 'text', when: { kind: 'text' } },
      { parameter: 'track', label: 'GPX file', when: { kind: ['file'] } },
      { parameter: 'tilt', label: 'Rotation', description: 'In degrees.' },
    ] },
  ];
  assert.deepEqual(controlProblems(parameters, controls), []);
  const shown = controlLayout(parameters, controls, values);
  assert.deepEqual(shown, [
    { kind: 'field', key: 'show', param: parameters.show, label: 'Show stamp' },
    { kind: 'group', label: 'Stamp', description: 'How the stamp looks.', children: [
      { kind: 'field', key: 'kind', param: parameters.kind, label: 'Kind' },
      { kind: 'field', key: 'text', param: parameters.text, label: 'Text' },
      { kind: 'field', key: 'tilt', param: parameters.tilt, label: 'Rotation', description: 'In degrees.' },
    ] },
  ]);
  assert.deepEqual(layoutFields(controlLayout(parameters, controls, { ...values, kind: 'file' })).map(({ key, label }) => [key, label]),
    [['show', 'Show stamp'], ['kind', 'Kind'], ['track', 'GPX file'], ['tilt', 'Rotation']]);
  // A group whose condition fails, or whose children are all hidden, disappears entirely.
  assert.deepEqual(controlLayout(parameters, controls, { ...values, show: false }).map((node) => node.kind), ['field']);
  assert.deepEqual(controlLayout(parameters, controls, values, ['kind', 'text', 'track', 'tilt']).map((node) => node.kind), ['field']);
  // Listing a subset hides the rest: no control, but nothing about the data changes.
  assert.deepEqual(layoutFields(controlLayout(parameters, ['tilt'], values)).map(({ key }) => key), ['tilt']);
});

test('conditions match every named value, and any value of an array', () => {
  assert.equal(matches(undefined, values), true);
  assert.equal(matches({ show: true, kind: ['file', 'text'] }, values), true);
  assert.equal(matches({ show: true, kind: 'file' }, values), false);
});

test('controls problems name unknown, repeated, owned and impossible entries', () => {
  assert.deepEqual(controlProblems(parameters, [
    'nope', 'show', 'show', 'track',
    { parameter: 'text', when: { text: 'x' } },
    { group: 'G', when: { missing: 1, kind: 'image' }, controls: ['tilt'] },
  ], ['track']), [
    'Control nope names a parameter this scope does not declare.',
    'Control show is listed twice.',
    'Control track is edited by the custom editor, so it has no generated control.',
    'Control text depends on its own value, so it could never be shown again once hidden.',
    'Group G depends on missing, which this scope does not declare.',
    'Group G depends on kind being "image", which it can never be.',
  ]);
});

const format = printFormat({ label: 'F', trim: { width: mm(100), height: mm(100) }, bleed: mm(0), safe: mm(5),
  pageCount: { min: 2, max: 20, step: 2 }, ends: 'inside-covers' });
const declare = (spread: Record<string, unknown>) => templateSchema.safeParse({
  id: 't', version: '1', contract: 1, format, spreads: { main: { label: 'Main', render: () => null, ...spread } },
});

test('the template schema validates controls at spread, box and element scope and passes them to the editor', () => {
  const ok = declare({
    parameters: { gap: parameters.tilt, heading: parameters.text }, controls: ['gap'],
    boxes: { hero: { type: 'photo', label: 'Hero', parameters: { show: parameters.show }, controls: [{ parameter: 'show', label: 'Caption' }] } },
    elements: { stamp: { label: 'Stamp', parameters, controls: ['show', 'tilt'], editor: { parameters: ['kind'], component: () => null } } },
  });
  assert.ok(ok.success, JSON.stringify(ok.error?.issues));
  const info = templateInfo(chooseFormat(ok.data!));
  assert.deepEqual(info.spreads.main.controls, ['gap']);
  assert.deepEqual(info.spreads.main.boxes.hero.controls, [{ parameter: 'show', label: 'Caption' }]);
  assert.deepEqual(info.spreads.main.elements.stamp.controls, ['show', 'tilt']);
  const bad = declare({
    parameters: { gap: parameters.tilt }, controls: ['gaps'],
    boxes: { hero: { type: 'photo', label: 'Hero', controls: [{ group: 'Empty', controls: [] }] } },
    elements: { stamp: { label: 'Stamp', parameters, controls: ['kind'], editor: { parameters: ['kind'], component: () => null } } },
  });
  assert.equal(bad.success, false);
  assert.deepEqual(bad.error!.issues.map(({ path }) => path.join('.')).sort(),
    ['spreads.main.boxes.hero.controls.0.controls', 'spreads.main.controls', 'spreads.main.elements.stamp.controls'].sort());
});

test('a control inside a group that depends on it is a warning, not a problem, through any number of groups', () => {
  // A marked edit target can still show it again, so loading the template must not fail.
  assert.deepEqual(controlProblems(parameters, [{ group: 'Options', when: { show: true }, controls: ['show', 'tilt'] }]), []);
  assert.deepEqual(controlCycles([{ group: 'Options', when: { show: true }, controls: ['show', 'tilt'] }]), [['show']]);
  assert.deepEqual(controlCycles([
    { group: 'Outer', when: { kind: 'text' }, controls: [{ group: 'Inner', controls: [{ parameter: 'kind', label: 'Kind' }, 'text'] }] },
  ]), [['kind']]);
  // Depending on a control outside the group is the ordinary case.
  assert.deepEqual(controlCycles(['show', { group: 'Options', when: { show: true }, controls: ['kind'] }]), []);
});

test('controls that hide each other are reported as cycles, groups included', () => {
  assert.deepEqual(controlCycles([
    'tilt',
    { parameter: 'show', when: { kind: 'text' } },
    { group: 'Kind', when: { show: true }, controls: ['kind'] },
    { parameter: 'text', when: { kind: 'text' } },
  ]), [['show', 'kind']]);
  assert.deepEqual(controlCycles(['show', { parameter: 'kind', when: { show: true } }]), []);
  assert.deepEqual(controlCycles(undefined), []);
});

test('an empty controls list is valid and shows no generated controls', () => {
  const ok = declare({ parameters: { gap: parameters.tilt }, controls: [],
    elements: { stamp: { label: 'Stamp', parameters, controls: [] } } });
  assert.ok(ok.success, JSON.stringify(ok.error?.issues));
  assert.deepEqual(controlLayout(parameters, [], values), []);
});

test('a group that hides its own control loads with a warning, and cycles are warned about at every scope', () => {
  const grouped = {
    id: 't', version: '1', contract: 1, format, spreads: { main: { label: 'Main', render: () => null, parameters,
      controls: [{ group: 'Options', when: { show: true }, controls: ['show', 'tilt'] }] } },
  };
  assert.ok(templateSchema.safeParse(grouped).success);
  assert.deepEqual(declarationWarnings(grouped, templateSchema as unknown as Schema).map(({ code, path, details }) => [code, path, details]),
    [['declaration-control-cycle', 'spreads.main.controls', { controls: 'show', layout: 'main', edit: '' }]]);
  // A layout that marks show on the page, such as ctx.edit('show'), offers a way back: no warning for it.
  const warnings = declarationWarnings(grouped, templateSchema as unknown as Schema);
  assert.deepEqual(withoutReachableControls(warnings, new Set(['main|show'])), []);
  assert.equal(withoutReachableControls(warnings, new Set(['other|show', 'main|tilt'])).length, 1);
  const cyclic = {
    id: 't', version: '1', contract: 1, format, spreads: { main: { label: 'Main', render: () => null, boxes: {
      hero: { type: 'photo', label: 'Hero', parameters: { show: parameters.show, kind: parameters.kind },
        controls: [{ parameter: 'show', when: { kind: 'text' } }, { parameter: 'kind', when: { show: true } }] },
    } } },
  };
  assert.ok(templateSchema.safeParse(cyclic).success);
  assert.deepEqual(declarationWarnings(cyclic, templateSchema as unknown as Schema).map(({ code, path, details }) => [code, path, details]),
    [['declaration-control-cycle', 'spreads.main.boxes.hero.controls', { controls: 'show, kind', layout: 'main', edit: 'boxes.hero.' }]]);
  assert.deepEqual(withoutReachableControls(declarationWarnings(cyclic, templateSchema as unknown as Schema), new Set(['main|boxes.hero.kind'])), []);
});

test('malformed controls reach the schema error instead of crashing the cycle check', () => {
  for (const controls of [[{ group: 'Options' }], 'show', [{ group: 'Options', controls: 'show' }], [42]]) {
    const declared = { id: 't', version: '1', contract: 1, format, spreads: { main: { label: 'Main', render: () => null, parameters, controls } } };
    assert.deepEqual(declarationWarnings(declared, templateSchema as unknown as Schema).filter(({ code }) => code === 'declaration-control-cycle'), []);
    assert.equal(templateSchema.safeParse(declared).success, false);
  }
});
