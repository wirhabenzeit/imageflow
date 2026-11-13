import assert from 'node:assert/strict';
import { test } from 'node:test';
import { changeMark, markOf, monthFor } from '../sample/calendar/template/marks';

// The calendar starter's day picker edits marked dates through these helpers.
const may = new Date('2027-05-01T00:00:00Z');

test('a click marks a date once and a second click unmarks it, leaving other entries alone', () => {
  const marked = changeMark('typo, 24.12', may, 9, { once: true });
  assert.equal(marked, 'typo, 24.12, 2027-05-09');
  assert.deepEqual(markOf(marked, may, 9), { once: true, yearly: false });
  assert.equal(changeMark(marked, may, 9, { once: false }), 'typo, 24.12');
  // A one-off date in another year is a different mark.
  assert.equal(changeMark('2028-05-09', may, 9, { once: false }), '2028-05-09');
});

test('removing a yearly mark keeps a one-off mark of the same day', () => {
  const both = '17.05, 2027-05-17';
  assert.deepEqual(markOf(both, may, 17), { once: true, yearly: true });
  assert.equal(changeMark(both, may, 17, { yearly: false }), '2027-05-17');
  assert.deepEqual(markOf(changeMark(both, may, 17, { yearly: false }), may, 17), { once: true, yearly: false });
  // And the reverse: removing the one-off mark keeps the yearly one.
  assert.equal(changeMark(both, may, 17, { once: false }), '17.05');
});

test('setting a kind writes one entry for it, without duplicates', () => {
  assert.equal(changeMark('17.05, 2027-05-17', may, 17, { yearly: true }), '2027-05-17, 17.05');
  assert.equal(changeMark('17.5, 17.05., 2027-05-17', may, 17, { yearly: true }), '2027-05-17, 17.05');
  assert.equal(changeMark('2027-05-17, 2027-05-17', may, 17, { once: true }), '2027-05-17');
  // Mark every year: the one-off entry becomes a yearly one.
  assert.equal(changeMark('2027-05-09', may, 9, { yearly: true, once: false }), '09.05');
});

test('a page and its picker read the same month from the page position', () => {
  const book = { anchors: () => [{ page: 2 }, { page: 3 }, { page: 4 }] };
  assert.equal(monthFor({ page: { number: 3 }, book, document: { firstMonth: '2027-11-01' } }).toISOString().slice(0, 10), '2027-12-01');
  assert.equal(monthFor({ page: { number: 4 }, book, document: { firstMonth: '2027-11-01' } }).toISOString().slice(0, 10), '2028-01-01');
});
