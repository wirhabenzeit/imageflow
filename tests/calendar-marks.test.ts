import assert from 'node:assert/strict';
import { test } from 'node:test';
import { changeMark, fileDays, markOf, monthFor, parseCalendarFile } from '../sample/calendar/template/marks';

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

// Calendar files (.ics) exported from a calendar app.
const ics = (...events: string[]) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...events.flatMap((lines) => ['BEGIN:VEVENT', lines, 'END:VEVENT']), 'END:VCALENDAR'].join('\r\n');
const days = (text: string, month: string) => {
  const parsed = parseCalendarFile(text);
  assert.ok(!('problem' in parsed));
  return [...fileDays(parsed.events, new Date(month + 'T00:00:00Z'))].sort((a, b) => a - b);
};

test('a calendar file marks its all-day events, once or every year', () => {
  const file = ics(
    'SUMMARY:Anna\r\nDTSTART;VALUE=DATE:19900517\r\nRRULE:FREQ=YEARLY',
    'SUMMARY:Trip\r\nDTSTART;VALUE=DATE:20270509\r\nDTEND;VALUE=DATE:20270512',
    'SUMMARY:Meeting\r\nDTSTART:20270520T090000Z\r\nDTEND:20270520T100000Z',
  );
  assert.deepEqual(days(file, '2027-05-01'), [9, 10, 11, 17]);
  assert.deepEqual(days(file, '2028-05-01'), [17]);
  // A yearly event does not show before its first year.
  assert.deepEqual(days(file, '1989-05-01'), []);
});

test('a yearly event ends with UNTIL or COUNT, and folded lines are joined', () => {
  const file = ics('DTSTART;VALUE=DATE:20250301\r\nRRULE:FREQ=YEARLY;CO\r\n UNT=3', 'DTSTART;VALUE=DATE:20250302\r\nRRULE:FREQ=YEARLY;UNTIL=20260302');
  assert.deepEqual(days(file, '2026-03-01'), [1, 2]);
  assert.deepEqual(days(file, '2027-03-01'), [1]);
  assert.deepEqual(days(file, '2028-03-01'), []);
});

test('a yearly 29 February shows only in leap years', () => {
  const file = ics('DTSTART;VALUE=DATE:20240229\r\nRRULE:FREQ=YEARLY');
  assert.deepEqual(days(file, '2027-02-01'), []);
  assert.deepEqual(days(file, '2028-02-01'), [29]);
});

test('a broken or empty calendar file says why', () => {
  assert.deepEqual(parseCalendarFile('day,km\n1,4'), { problem: 'is not a calendar file (no BEGIN:VCALENDAR)' });
  assert.deepEqual(parseCalendarFile(ics()), { problem: 'has no events' });
  assert.deepEqual(parseCalendarFile(ics('DTSTART:20270520T090000Z')), { events: [], count: 1, unsupported: [] });
});

test('yearly selectors: the last Monday in May, every other year, a fixed day of several months', () => {
  const memorial = ics('DTSTART;VALUE=DATE:20250526\r\nRRULE:FREQ=YEARLY;BYMONTH=5;BYDAY=-1MO');
  assert.deepEqual(days(memorial, '2026-05-01'), [25]);
  assert.deepEqual(days(memorial, '2027-05-01'), [31]);
  const thanksgiving = ics('DTSTART;VALUE=DATE:20251127\r\nRRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=4TH');
  assert.deepEqual(days(thanksgiving, '2026-11-01'), [26]);
  const biennial = ics('DTSTART;VALUE=DATE:20250601\r\nRRULE:FREQ=YEARLY;INTERVAL=2');
  assert.deepEqual(days(biennial, '2026-06-01'), []);
  assert.deepEqual(days(biennial, '2027-06-01'), [1]);
  const quarterly = ics('DTSTART;VALUE=DATE:20250115\r\nRRULE:FREQ=YEARLY;BYMONTH=1,4;BYMONTHDAY=15,-1');
  assert.deepEqual(days(quarterly, '2026-04-01'), [15, 30]);
});

test('UNTIL is a whole date, and COUNT counts only real occurrences', () => {
  const until = ics('DTSTART;VALUE=DATE:20250517\r\nRRULE:FREQ=YEARLY;UNTIL=20270301');
  assert.deepEqual(days(until, '2026-05-01'), [17]);
  assert.deepEqual(days(until, '2027-05-01'), []);
  const leap = ics('DTSTART;VALUE=DATE:20240229\r\nRRULE:FREQ=YEARLY;COUNT=2');
  assert.deepEqual(days(leap, '2028-02-01'), [29]);
  assert.deepEqual(days(leap, '2032-02-01'), []);
});

test('EXDATE and moved or cancelled occurrences are left out', () => {
  const file = ics('UID:a\r\nDTSTART;VALUE=DATE:20250509\r\nRRULE:FREQ=YEARLY\r\nEXDATE;VALUE=DATE:20270509,20280509',
    'UID:a\r\nRECURRENCE-ID;VALUE=DATE:20290509\r\nDTSTART;VALUE=DATE:20290512',
    'UID:a\r\nRECURRENCE-ID;VALUE=DATE:20300509\r\nDTSTART;VALUE=DATE:20300509\r\nSTATUS:CANCELLED');
  assert.deepEqual(days(file, '2026-05-01'), [9]);
  assert.deepEqual(days(file, '2027-05-01'), []);
  assert.deepEqual(days(file, '2029-05-01'), [12]);
  assert.deepEqual(days(file, '2030-05-01'), []);
});

test('DURATION sets the length, and each yearly occurrence keeps its length', () => {
  assert.deepEqual(days(ics('DTSTART;VALUE=DATE:20270509\r\nDURATION:P3D'), '2027-05-01'), [9, 10, 11]);
  const span = ics('DTSTART;VALUE=DATE:20240228\r\nDTEND;VALUE=DATE:20240301\r\nRRULE:FREQ=YEARLY');
  assert.deepEqual(days(span, '2025-02-01'), [28]);
  assert.deepEqual(days(span, '2025-03-01'), [1]);
  const leap = ics('DTSTART;VALUE=DATE:20240229\r\nDTEND;VALUE=DATE:20240303\r\nRRULE:FREQ=YEARLY');
  assert.deepEqual(days(leap, '2025-03-01'), []);
  assert.deepEqual(days(leap, '2028-03-01'), [1, 2]);
  // An event over New Year marks January from the year before.
  assert.deepEqual(days(ics('DTSTART;VALUE=DATE:20261230\r\nDURATION:P4D'), '2027-01-01'), [1, 2]);
});

test('a repeat the calendar cannot follow marks its first date and is reported', () => {
  const parsed = parseCalendarFile(ics('SUMMARY:Rent\r\nDTSTART;VALUE=DATE:20270501\r\nRRULE:FREQ=MONTHLY',
    'SUMMARY:Odd\r\nDTSTART;VALUE=DATE:20270502\r\nRRULE:FREQ=YEARLY;BYSETPOS=1;BYDAY=MO'));
  assert.ok(!('problem' in parsed));
  assert.deepEqual(parsed.unsupported, ['Rent repeats monthly', 'Odd uses BYSETPOS']);
  assert.deepEqual([...fileDays(parsed.events, new Date('2027-05-01T00:00:00Z'))], [1, 2]);
  assert.deepEqual([...fileDays(parsed.events, new Date('2027-06-01T00:00:00Z'))], []);
});
