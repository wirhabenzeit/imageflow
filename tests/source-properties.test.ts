import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activeProvidersOf, bookPhotoMarks, bookPhotoProviders, declaredExtra, declaredProperties, markText, photoFilterPredicate, photoProvider, readPhotoMarks, withDeclaredExtra } from '../src/source-properties';
import type { ProjectSummary } from '../src/desktop';

const marks = (provider: string, extra?: Record<string, unknown>) => readPhotoMarks(provider, extra).map(({ spec, mark }) => [spec.id, mark]);

test('a provider\'s marks are read from its declared keys of extra', () => {
  assert.deepEqual(marks('lightroom', { rating: 4, flag: 'pick', color: 'green', colorLabel: 'Select', fileName: 'a.arw' }), [
    ['lightroom:rating', { kind: 'stars', value: 4 }], ['lightroom:flag', { kind: 'flag', value: 'pick' }],
    ['lightroom:color', { kind: 'color', value: 'green', label: 'Select' }]]);
  assert.deepEqual(marks('photos', { favorite: true, type: 'public.heic' }), [['photos:favorite', { kind: 'heart' }]]);
  // The colour's own name is no label of its own.
  assert.deepEqual(marks('lightroom', { color: 'red', colorLabel: 'Red' }), [['lightroom:color', { kind: 'color', value: 'red' }]]);
});

test('values outside the vocabulary, and other providers\' keys, give no mark', () => {
  assert.deepEqual(marks('lightroom', { rating: 7, flag: 'maybe', color: 'grey', favorite: true }), []);
  assert.deepEqual(marks('lightroom', { rating: 0 }), []);
  assert.deepEqual(marks('lightroom', { rating: '3' }), []);
  assert.deepEqual(marks('photos', { favorite: false, rating: 5 }), []);
  assert.deepEqual(marks('package', { rating: 5, favorite: true }), []);
  assert.deepEqual(marks('lightroom', undefined), []);
});

test('declared properties compare equal whatever else extra holds', () => {
  assert.equal(declaredProperties('lightroom', { rating: 3, fileName: 'a.arw' }), declaredProperties('lightroom', { orientation: 'AB', rating: 3 }));
  assert.notEqual(declaredProperties('lightroom', { rating: 3 }), declaredProperties('lightroom', { rating: 4 }));
  assert.equal(declaredProperties('lightroom', { fileName: 'a.arw' }), '');
  assert.equal(declaredProperties('photos', { rating: 3 }), '');
});

test('the declared part of extra is taken and put back without the rest', () => {
  assert.deepEqual(declaredExtra('lightroom', { rating: 3, color: 'blue', colorLabel: 'Print', fileName: 'a.arw', favorite: true }), { rating: 3, color: 'blue', colorLabel: 'Print' });
  assert.deepEqual(withDeclaredExtra({ rating: 1, flag: 'reject', fileName: 'a.arw' }, { rating: 5 }), { fileName: 'a.arw', rating: 5 });
  assert.equal(withDeclaredExtra({ rating: 1 }, {}), undefined);
  assert.deepEqual(withDeclaredExtra(undefined, { favorite: true }), { favorite: true });
});

test('only providers that declare properties are active', () => {
  assert.deepEqual(activeProvidersOf(['package', 'photos', 'linked', undefined]).map(({ provider }) => provider), ['photos']);
  assert.deepEqual(activeProvidersOf(['photos', 'lightroom']).map(({ provider }) => provider), ['lightroom', 'photos']);
});

const book = [
  { id: 'lr5', provider: 'lightroom', extra: { rating: 5, flag: 'pick', color: 'red' }, used: true },
  { id: 'lr2', provider: 'lightroom', extra: { rating: 2, flag: 'reject' }, used: false },
  { id: 'lr0', provider: 'lightroom', extra: { fileName: 'c.arw' }, used: false },
  { id: 'fav', provider: 'photos', extra: { favorite: true }, used: false },
  { id: 'plain', provider: 'photos', extra: {}, used: true },
  { id: 'file', provider: 'package', used: false },
  { id: 'link', provider: 'linked', used: false },
];
const shown = (filter: Parameters<typeof photoFilterPredicate>[0]) => book.filter(photoFilterPredicate(filter)).map(({ id }) => id);

test('a provider\'s filter leaves the photos of other sources alone', () => {
  assert.deepEqual(shown({ properties: { 'lightroom:rating': 4 } }), ['lr5', 'fav', 'plain', 'file', 'link']);
  assert.deepEqual(shown({ properties: { 'photos:favorite': true } }), ['lr5', 'lr2', 'lr0', 'fav', 'file', 'link']);
});

test('two providers\' filters together never exclude each other', () => {
  assert.deepEqual(shown({ properties: { 'lightroom:rating': 4, 'photos:favorite': true } }), ['lr5', 'fav', 'file', 'link']);
});

test('one provider\'s filters all apply to its photos', () => {
  assert.deepEqual(shown({ sources: ['lightroom'], properties: { 'lightroom:rating': 2, 'lightroom:flag': 'not-reject' } }), ['lr5']);
  assert.deepEqual(shown({ sources: ['lightroom'], properties: { 'lightroom:color': ['red', 'blue'] } }), ['lr5']);
  assert.deepEqual(shown({ sources: ['lightroom'], properties: { 'lightroom:color': [] } }), ['lr5', 'lr2', 'lr0']);
});

test('the flag filter is one of four choices', () => {
  const flagged = (flag: 'pick' | 'not-reject' | 'reject') => shown({ sources: ['lightroom'], properties: { 'lightroom:flag': flag } });
  assert.deepEqual(flagged('pick'), ['lr5']);
  assert.deepEqual(flagged('not-reject'), ['lr5', 'lr0']);
  assert.deepEqual(flagged('reject'), ['lr2']);
  assert.deepEqual(shown({ sources: ['lightroom'] }), ['lr5', 'lr2', 'lr0']);
});

test('placement and sources apply to every photo, and a deselected source\'s filters rest', () => {
  assert.deepEqual(shown({ placement: 'unused' }), ['lr2', 'lr0', 'fav', 'file', 'link']);
  assert.deepEqual(shown({ placement: 'used', properties: { 'lightroom:rating': 5 } }), ['lr5', 'plain']);
  assert.deepEqual(shown({ sources: ['photos', 'package'], properties: { 'lightroom:rating': 5 } }), ['fav', 'plain', 'file']);
  assert.deepEqual(shown({ sources: [] }), book.map(({ id }) => id));
});

test('a book\'s photo is read through its own provider, and the book lists the providers of its photos', () => {
  const entry = (id: string, provider: string) => ({ ['photo:' + id]: { kind: 'photo', id, name: id, locator: { provider }, state: 'available' } });
  const summary = {
    photoIndex: { lr: {}, ph: {}, pk: {}, gone: {} },
    sources: { ...entry('lr', 'lightroom'), ...entry('ph', 'photos'), ...entry('pk', 'package') },
    // A key of another provider's vocabulary marks nothing, and a photo the book no longer has is not listed.
    photoExtra: { lr: { rating: 5, favorite: true }, ph: { favorite: true, rating: 2 }, pk: { rating: 4 } },
  } as unknown as ProjectSummary;
  assert.equal(photoProvider(summary, 'lr'), 'lightroom');
  assert.equal(photoProvider(summary, 'gone'), undefined);
  assert.deepEqual(bookPhotoMarks(summary, 'lr').map(({ mark }) => mark), [{ kind: 'stars', value: 5 }]);
  assert.deepEqual(bookPhotoMarks(summary, 'ph').map(({ mark }) => mark), [{ kind: 'heart' }]);
  assert.deepEqual(bookPhotoMarks(summary, 'pk'), []);
  assert.deepEqual(bookPhotoProviders(summary), ['lightroom', 'package', 'photos']);
  assert.deepEqual(activeProvidersOf(bookPhotoProviders(summary)).map(({ label }) => label), ['Lightroom Classic', 'Apple Photos']);
});

test('marks are written with filled stars on a thumbnail, empty slots in the Inspector, and an accessible name for each', () => {
  assert.deepEqual(markText({ kind: 'stars', value: 4 }), { glyph: '★★★★', label: '4 of 5 stars', title: '4 of 5 stars', value: '★★★★☆', valueLabel: '4 of 5 stars' });
  assert.equal(markText({ kind: 'stars', value: 1 }).label, '1 of 5 stars');
  assert.deepEqual(markText({ kind: 'flag', value: 'pick' }), { glyph: '⚑', label: 'Picked', title: 'Picked', value: 'Picked', valueLabel: 'Picked' });
  assert.equal(markText({ kind: 'flag', value: 'reject' }).glyph, '✕');
  assert.equal(markText({ kind: 'flag', value: 'reject' }).label, 'Rejected');
  assert.deepEqual(markText({ kind: 'heart' }), { glyph: '♥', label: 'Favorite', title: 'Favorite', value: 'Yes', valueLabel: 'Yes' });
  assert.deepEqual(markText({ kind: 'color', value: 'green' }), { glyph: '', label: 'Green label', title: 'Green label', value: 'Green', valueLabel: 'Green' });
  // A custom label set's name is in the tooltip and the Inspector.
  const custom = markText({ kind: 'color', value: 'green', label: 'To Print' });
  assert.equal(custom.title, 'Green label: To Print');
  assert.equal(custom.value, 'Green (To Print)');
});
