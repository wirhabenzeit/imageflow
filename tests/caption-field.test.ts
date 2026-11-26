import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captionEdit, captionSwitch, declaresCaptionBoxes, printsCaption } from '../src/CaptionField';
import { p, parameterSchema } from '../src/parameters';
import type { Parameters } from '../src/parameters';
import { projectSchema } from '../src/project';

const parameters = { frame: p.boolean({ label: 'Frame', default: false }), showCaption: p.boolean({ label: 'Show caption', default: false, shows: 'caption' }) };
const files = (caption?: string, params: Record<string, boolean> = {}) => ({
  photoIndex: { photo: { path: 'photos/photo.jpg', ...(caption === undefined ? {} : { caption }) } } as Record<string, { path: string; caption?: string }>,
  project: projectSchema.parse({ schemaVersion: 1, title: 'Book', template: { id: 't', version: '1' }, spreads: [{ id: 's', definition: 'a', boxes: { hero: { photo: 'photo', params } } }] }),
});
const apply = (book: ReturnType<typeof files>, value: string, toggle = true) => {
  captionEdit(book, 'photo', value, toggle ? { parameters, find: ({ project }) => project.spreads[0].boxes.hero } : undefined)(book);
  return [book.photoIndex.photo.caption, book.project.spreads[0].boxes.hero.params.showCaption];
};

test('a photo’s first caption switches on the box parameter that shows it (UI-014)', () => {
  assert.equal(captionSwitch(parameters), 'showCaption');
  assert.equal(captionSwitch({ frame: parameters.frame }), undefined);
  assert.equal(parameterSchema.safeParse(parameters.showCaption).success, true);
  assert.equal(parameterSchema.safeParse({ ...parameters.showCaption, shows: 'weather' }).success, false);
  assert.deepEqual(apply(files(), 'At the pass'), ['At the pass', true]);
  assert.deepEqual(apply(files(' '), 'At the pass'), ['At the pass', true]);
  assert.deepEqual(apply(files(), 'At the pass', false), ['At the pass', undefined], 'without a declared switch');
  assert.deepEqual(apply(files(), ' '), [' ', undefined]);
  assert.deepEqual(apply(files('Before', { showCaption: false }), 'After'), ['After', false], 'a switch turned off stays off when a caption changes');
  assert.deepEqual(apply(files('Before', { showCaption: true }), ''), ['', true]);
});

test('a caption from the photo’s provider counts as one, and a box that holds another photo by now is left alone', () => {
  const book = files(undefined);
  captionEdit({ ...book, photoProvided: { photo: { caption: 'From Lightroom' } } }, 'photo', 'Own', { parameters, find: ({ project }) => project.spreads[0].boxes.hero })(book);
  assert.equal(book.project.spreads[0].boxes.hero.params.showCaption, undefined);
  const other = files();
  other.project.spreads[0].boxes.hero.photo = 'other';
  assert.deepEqual(apply(other, 'Late'), ['Late', undefined]);
  const gone = files();
  delete gone.photoIndex.photo;
  captionEdit(gone, 'photo', 'Late')(gone);
  assert.equal(gone.photoIndex.photo, undefined);
});

test('a template that says which boxes print captions offers Caption… only on those (UI-017)', () => {
  const plain: Parameters = { frame: parameters.frame };
  const layouts = (hero: Parameters, cover?: Parameters) => ({
    spreads: { single: { boxes: { hero: { parameters: hero }, grid: { parameters: {} } } } },
    ...(cover ? { coverLayouts: { front: { boxes: { photo: { parameters: cover } } } } } : {}),
  });
  assert.equal(declaresCaptionBoxes(undefined), false);
  assert.equal(declaresCaptionBoxes(layouts(plain)), false, 'no box declares shows');
  assert.equal(declaresCaptionBoxes(layouts(parameters)), true);
  assert.equal(declaresCaptionBoxes(layouts(plain, parameters)), true, 'a cover box counts');
  assert.equal(printsCaption(true, parameters), true);
  assert.equal(printsCaption(true, plain), false, 'a box without the switch, in a template that has it elsewhere');
  assert.equal(printsCaption(true, undefined), false);
  assert.equal(printsCaption(false, plain), undefined, 'a template that never says: any box may print it');
  assert.equal(printsCaption(false, undefined), undefined);
});
