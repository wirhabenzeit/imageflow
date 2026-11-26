import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activeProvidersOf, declaredExtra, declaredProperties, photoFilterPredicate, readPhotoMarks, withDeclaredExtra } from '../src/source-properties';

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
