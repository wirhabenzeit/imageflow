import assert from 'node:assert/strict';
import { test } from 'node:test';
import { plainText, saveInlineText, textEditorOwner, textFits, textProblem } from '../src/inline-text';
import { readEdit, resolveEditPath } from '../src/editing';
import { p } from '../src/parameters';
import { projectSchema } from '../src/project';
import { capabilities, contract1Capabilities } from '../src/runtime-exports';

test('inline-text is discoverable in the pre-release contract-1 baseline', () => {
  assert.ok(capabilities.includes('inline-text'));
  assert.ok((contract1Capabilities as readonly string[]).includes('inline-text'));
});

test('inline text normalizes paste without truncating invalid drafts', () => {
  assert.equal(plainText('a\r\nb\rc\nd', true), 'a\nb\nc\nd');
  assert.equal(plainText('a\r\nb\rc\nd', false), 'a b c d');
  const field = p.string({ label: 'Heading', default: '', maxLength: 3 });
  assert.equal(textProblem(field, ''), '');
  assert.match(textProblem(field, 'four'), /at most 3 characters.*typing is kept/);
});

test('small, transformed and non-opted-in targets use the parameter panel', () => {
  const target = { spread: 'one', edits: ['heading'], occurrence: 0, inlineText: true, x: 0, y: 0, width: 200, height: 30 };
  assert.ok(textFits(target));
  assert.ok(!textFits({ ...target, inlineText: false }));
  assert.ok(!textFits({ ...target, upright: false }));
  assert.ok(!textFits({ ...target, width: 40 }));
  assert.ok(!textFits({ ...target, height: 12 }));
});

const field = p.string({ label: 'Heading', default: 'Default', multiline: true, maxLength: 30 });
const template = { parameters: { title: field }, spreads: { title: { parameters: { heading: field },
  boxes: { hero: { parameters: { caption: field } } }, elements: { note: { parameters: { text: field } } } } } };

test('custom editor ownership wins for document, element and owned layout strings, but not unowned box strings', () => {
  const owned = { ...template, editors: { titles: { parameters: ['title'] } }, spreads: { title: {
    ...template.spreads.title, elements: { note: { parameters: { text: field }, editor: { parameters: ['text'], spread: ['heading'] } } },
  } } };
  assert.deepEqual(textEditorOwner(owned, 'title', 'document.title'), { kind: 'document', editor: 'titles' });
  assert.deepEqual(textEditorOwner(owned, 'title', 'elements.note.text'), { kind: 'element', element: 'note' });
  assert.deepEqual(textEditorOwner(owned, 'title', 'heading'), { kind: 'element', element: 'note' });
  assert.equal(textEditorOwner(owned, 'title', 'boxes.hero.caption'), undefined);
  assert.equal(textEditorOwner(owned, 'missing', 'heading'), undefined);
  const project = projectSchema.parse({ schemaVersion: 1, title: 'Book', template: { id: 'test', version: '1' },
    spreads: [{ id: 'one', definition: 'title' }] });
  const before = structuredClone(project);
  for (const path of ['document.title', 'elements.note.text', 'heading']) {
    // The draft was opened when there was no owner. Adding an owner before the save queue runs must reject it.
    const target = resolveEditPath(template, 'title', path)!;
    assert.equal(saveInlineText(project, owned, 'one', 'title', target, 'Default', 'Changed'), false);
  }
  assert.deepEqual(project, before);
});

for (const path of ['heading', 'document.title', 'boxes.hero.caption', 'elements.note.text']) {
  test('inline text uses the existing saved scope: ' + path, () => {
    const project = projectSchema.parse({ schemaVersion: 1, title: 'Book', template: { id: 'test', version: '1' },
      spreads: [{ id: 'one', definition: 'title' }, { id: 'two', definition: 'title' }] });
    const target = resolveEditPath(template, 'title', path)!;
    assert.ok(saveInlineText(project, template, 'one', 'title', target, 'Default', 'First\nSecond'));
    assert.equal(readEdit(project, project.spreads[0], target), 'First\nSecond');
    assert.equal(readEdit(project, project.spreads[1], target), path.startsWith('document.') ? 'First\nSecond' : 'Default');
    const saved = structuredClone(project);
    assert.equal(saveInlineText(project, template, 'one', 'title', target, 'Default', 'stale'), false);
    assert.deepEqual(project, saved);
    assert.equal(saveInlineText(project, template, 'one', 'other-layout', target, 'First\nSecond', 'wrong layout'), false);
    assert.equal(saveInlineText(project, template, 'one', 'title', target, 'First\nSecond', 'x'.repeat(31)), false);
    const changed = { ...template, spreads: { title: { ...template.spreads.title,
      parameters: { heading: { ...field, maxLength: 10 } } } } };
    if (path === 'heading') assert.equal(saveInlineText(project, changed, 'one', 'title', target, 'First\nSecond', 'changed'), false);
    assert.deepEqual(project, saved);
  });
}
