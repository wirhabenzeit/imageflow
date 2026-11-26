import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanFilter, clickStar, filterActive, filterChips, filteredSourceList, fitFilter, fitStripFilters, noStripFilters, orderedSources, quickLookList,
  setPlacement, setProperty, shownProviders, stripSources, toggleColor, toggleSource } from '../src/photo-filter';
import type { PhotoFilter } from '../src/source-properties';
import type { ProjectSummary } from '../src/desktop';

const catalog = 'C0FFEE00-0000-4000-8000-000000000001';
const lr = (n: number) => ({ lightroom: { catalog, uuid: '6A0D2D52-0D4E-4B1E-9B9B-' + String(n).padStart(12, '0') } });
// A book that mixes sources: two Lightroom Classic photos, an Apple Photos one, one in the book and a linked file.
const summary = {
  photoIndex: { lr4: lr(1), lr2: lr(2), fav: { photos: { cloud: 'ABCDEF12-3456:001:AbCd' } }, book: { path: 'photos/book.jpg' }, link: { path: '/Users/me/link.jpg', linked: true } },
  photoExtra: { lr4: { rating: 4 }, lr2: { rating: 2, flag: 'reject' }, fav: { favorite: true } },
  photoDates: {}, photoSizes: {},
  project: { texts: { a: 'texts/a.md', b: { path: '/Users/me/b.md', linked: true } }, files: {}, spreads: [] },
} as unknown as ProjectSummary;
const usage = { photo: { book: [{ spread: 's', pages: '1' }] }, text: {} } as never;
const ids = (filter: PhotoFilter) => filteredSourceList(summary, 'photo', undefined, filter, usage).map(({ id }) => id).sort();

test('the sources of a tab are listed in the pills\' order', () => {
  assert.deepEqual(stripSources(summary, 'photo'), ['package', 'linked', 'lightroom', 'photos']);
  assert.deepEqual(stripSources(summary, 'text'), ['package', 'linked']);
  assert.deepEqual(orderedSources(['photos', undefined, 'future', 'package', 'photos']), ['package', 'photos', 'future']);
});

test('a Lightroom rating filter keeps every photo of another source in the strip', () => {
  assert.deepEqual(ids({ properties: { 'lightroom:rating': 3 } }), ['book', 'fav', 'link', 'lr4']);
  // The Source pill narrows to one source; deselecting it again lets the others back in.
  const only = toggleSource({ properties: { 'lightroom:rating': 3 } }, 'lightroom');
  assert.deepEqual(ids(only), ['lr4']);
  assert.deepEqual(ids(toggleSource(only, 'lightroom')), ['book', 'fav', 'link', 'lr4']);
  assert.deepEqual(ids({ placement: 'unused' }), ['fav', 'link', 'lr2', 'lr4']);
  assert.deepEqual(ids({ placement: 'used' }), ['book']);
});

test('a provider\'s filters rest while its Source pill is off, and apply again when it is on', () => {
  const filter: PhotoFilter = { sources: ['photos', 'package'], properties: { 'lightroom:rating': 5, 'photos:favorite': true } };
  assert.deepEqual(shownProviders(filter, stripSources(summary, 'photo')).map(({ provider }) => provider), ['photos']);
  assert.deepEqual(filterChips(filter, shownProviders(filter, stripSources(summary, 'photo'))).map(({ key }) => key), ['sources', 'photos:favorite']);
  assert.ok(filterActive({ sources: ['photos'], properties: { 'lightroom:rating': 5 } }));
  const back = toggleSource(toggleSource(filter, 'photos'), 'package');
  assert.deepEqual(back, { properties: { 'lightroom:rating': 5, 'photos:favorite': true } }, 'kept while resting');
  assert.deepEqual(ids(back), ['book', 'fav', 'link']);
});

test('chips start with the provider and spell out its scope', () => {
  const filter: PhotoFilter = { placement: 'unused', sources: ['lightroom', 'package'],
    properties: { 'lightroom:rating': 3, 'lightroom:flag': 'not-reject', 'lightroom:color': ['red', 'blue'] } };
  const chips = filterChips(filter, shownProviders(filter, ['lightroom', 'photos', 'package']));
  assert.deepEqual(chips.map(({ label, title, origins }) => [label, title, origins]), [
    ['Unused', 'Only photos not placed in the book', undefined],
    ['In Book, Lightroom Classic', 'Only photos from In Book or Lightroom Classic', ['package', 'lightroom']],
    ['★★★+', 'Lightroom Classic photos: 3 stars or more', ['lightroom']],
    ['Not Rejected', 'Lightroom Classic photos: not rejected', ['lightroom']],
    ['Red, Blue', 'Lightroom Classic photos: red or blue label', ['lightroom']],
  ]);
  assert.equal(filterChips({ properties: { 'lightroom:rating': 5 } }, shownProviders({}, ['lightroom']))[0].title, 'Lightroom Classic photos: 5 stars');
  assert.equal(filterChips({ properties: { 'photos:favorite': true } }, shownProviders({}, ['photos']))[0].title, 'Apple Photos photos: favorites only');
  // Removing a chip removes that filter alone.
  assert.deepEqual(chips[2].remove(filter).properties, { 'lightroom:flag': 'not-reject', 'lightroom:color': ['red', 'blue'] });
  assert.equal(chips[1].remove(filter).sources, undefined);
  assert.equal(chips[0].remove(filter).placement, undefined);
});

test('the controls change one value each, and a value that narrows nothing is no filter', () => {
  assert.deepEqual(clickStar({}, 'lightroom:rating', 3), { properties: { 'lightroom:rating': 3 } });
  assert.deepEqual(clickStar({ properties: { 'lightroom:rating': 3 } }, 'lightroom:rating', 3), {}, 'the active star clears it');
  assert.deepEqual(clickStar({ properties: { 'lightroom:rating': 3 } }, 'lightroom:rating', 5), { properties: { 'lightroom:rating': 5 } });
  assert.deepEqual(toggleColor(toggleColor({}, 'lightroom:color', 'red'), 'lightroom:color', 'green'), { properties: { 'lightroom:color': ['red', 'green'] } });
  assert.deepEqual(toggleColor({ properties: { 'lightroom:color': ['red'] } }, 'lightroom:color', 'red'), {});
  assert.deepEqual(setProperty({ properties: { 'lightroom:flag': 'pick' } }, 'lightroom:flag', 'reject'), { properties: { 'lightroom:flag': 'reject' } });
  assert.deepEqual(setPlacement({ placement: 'used' }, 'all'), {});
  assert.deepEqual(cleanFilter({ placement: 'all', sources: [], properties: { 'lightroom:rating': 0, 'lightroom:color': [], 'unknown:x': true } }), {});
  assert.equal(filterActive({}), false);
  assert.equal(filterActive({ properties: { 'lightroom:color': [] } }), false);
});

test('a provider whose photos all left the book loses its filters; a source that left loses its pill', () => {
  const filter: PhotoFilter = { sources: ['lightroom', 'photos'], properties: { 'lightroom:rating': 4, 'photos:favorite': true } };
  assert.equal(fitFilter(filter, ['lightroom', 'photos', 'package']), filter, 'unchanged while all are there');
  assert.deepEqual(fitFilter(filter, ['photos', 'package']), { sources: ['photos'], properties: { 'photos:favorite': true } });
  // With one source left there are no pills, so there is no Source filter either.
  assert.deepEqual(fitFilter(filter, ['photos']), { properties: { 'photos:favorite': true } });
  const strip = { photo: filter, text: { placement: 'unused' as const } };
  assert.equal(fitStripFilters(summary, strip), strip);
  assert.equal(fitStripFilters(summary, noStripFilters), noStripFilters);
  const gone = { ...summary, photoIndex: { book: summary.photoIndex.book, link: summary.photoIndex.link } } as ProjectSummary;
  assert.deepEqual(fitStripFilters(gone, strip), { photo: {}, text: { placement: 'unused' } });
});

test('Quick Look steps through the filtered list, or the whole one for a photo the filter hides', () => {
  const list = filteredSourceList(summary, 'photo', undefined, { sources: ['lightroom'] }, usage);
  assert.deepEqual(quickLookList(summary, { kind: 'photo', id: 'lr2' }, undefined, list).map(({ id }) => id).sort(), ['lr2', 'lr4']);
  assert.equal(quickLookList(summary, { kind: 'photo', id: 'fav' }, undefined, list).length, 5);
});

test('texts filter by placement and by being in the book or linked', () => {
  const texts = (filter: PhotoFilter) => filteredSourceList(summary, 'text', undefined, filter, usage).map(({ id }) => id);
  assert.deepEqual(texts({ sources: ['linked'] }), ['b']);
  assert.deepEqual(texts({ placement: 'used' }), []);
  // A photo provider's filter has no hold on a text.
  assert.deepEqual(texts({ properties: { 'lightroom:rating': 5 } }), ['a', 'b']);
});
