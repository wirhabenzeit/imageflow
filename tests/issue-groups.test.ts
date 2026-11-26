import assert from 'node:assert/strict';
import test from 'node:test';
import { checkRows, issueKeys, namedMessage, occurrenceText, rowMessages } from '../src/issue-groups';
import { cachedPreviewText, printProblem } from '../src/source-locations';
import type { SourceStatus } from '../src/source-locations';
import { awayDiagnostics, awayOriginal, awayProblem, awayText, sourceWarnings, takeAway, withoutReported } from '../src/away-originals';
import { exportErrorList, foundText } from '../src/export-errors';
import { isUnavailableSource } from '../src/source-diagnostics';
import type { Issue } from '../src/desktop';

const missing = (id: string, extra: Partial<Issue> = {}): Issue => ({ message: cachedPreviewText('Original missing: /Photos/' + id + '.jpg'), code: 'source-unavailable', source: id, sourceKind: 'photo',
  state: 'missing', problem: 'Original missing: /Photos/' + id + '.jpg', spread: 's1', where: 'Pages 2–3 · Story / Hero', box: 'hero', ...extra });
const plain = ({ message }: Issue) => message;

test('an unavailable original on the cover is one problem with those on spreads, and has one full stop', () => {
  const message = cachedPreviewText('Locate this original to approve access on this Mac.');
  assert.doesNotMatch(message, /\.\./);
  const unapproved = (place: Partial<Issue>): Issue => missing('a', { message, state: 'unapproved', problem: 'Locate this original to approve access on this Mac.', ...place });
  const rows = checkRows({ errors: [unapproved({}), unapproved({ spread: undefined, cover: true, where: 'Cover' }), unapproved({ spread: 's2' })], warnings: [] });
  assert.deepEqual(rows.map(({ title, items }) => [title, items.length]), [['Original needs approval', 3]]);
  assert.deepEqual(rowMessages(rows[0], plain), [], 'the row says it in its own words');
});

test('one row per problem, what needs something done first and what is only good to know last', () => {
  const low = (box: string): Issue => ({ message: box + ' is 170 ppi (minimum 180).', code: 'photo-resolution-low', spread: 's2', box, source: 'p-' + box, details: { ppi: 170, minimumPpi: 180 } });
  const warnings: Issue[] = [{ message: 'Text is smaller than the format minimum.', code: 'text-too-small', spread: 's3', box: 'a', details: { sizePt: 4.2, minimumPt: 6 } },
    { message: 'Photo z.jpg · Original missing: /z.jpg', code: 'project-input', source: 'z', sourceKind: 'photo', state: 'missing', problem: 'Original missing: /z.jpg' }];
  const rows = checkRows({ errors: [missing('a'), low('small1'), missing('b', { spread: 's4' }), low('small2'), unavailable('e', { spread: 's1', box: 'x' }), { message: 'Page count is 2.', code: 'page-sequence' }], warnings });
  assert.deepEqual(rows.map(({ level, title, items }) => [level, title, items.length]), [['error', 'Low resolution', 2], ['error', 'Pages to fit the format before export', 1], ['error', 'Original missing', 2],
    ['warning', 'Text too small to print', 1], ['warning', 'Original missing (not placed)', 1], ['info', '1 original is on another Mac. Needed for printing.', 1]]);
  // Each place says only what is its own, from the finding's values; a sentence that is the same for all is said once.
  assert.deepEqual(rows[0].items.map((issue) => occurrenceText(rows[0], issue, plain)), ['170 ppi, needs 180', '170 ppi, needs 180']);
  assert.deepEqual(rowMessages(rows[0], plain), []);
  assert.deepEqual(rowMessages(rows[1], plain), ['Page count is 2.']);
  assert.equal(occurrenceText(rows[1], rows[1].items[0], plain), undefined);
  // A layout that does not fit the format has its own row, apart from the pages to fit before export.
  assert.deepEqual(checkRows({ errors: [{ message: 'Page 2 uses a spread layout, but Calendar has no facing pages.', code: 'layout-format-mismatch' }],
    warnings: [{ message: 'Page count is 2.', code: 'page-sequence' }] }).map(({ level, title }) => [level, title]),
  [['error', 'Layouts don’t fit the format'], ['warning', 'Pages to fit the format before export']]);
  assert.deepEqual(rows[2].items.map((issue) => occurrenceText(rows[2], issue, plain)), ['Original missing: /Photos/a.jpg', 'Original missing: /Photos/b.jpg']);
  assert.equal(occurrenceText(rows[3], rows[3].items[0], plain), '4.2 pt, needs 6');
});

test('each finding has a key of its own, which a changed value keeps', () => {
  const low = (ppi: number): Issue => ({ message: 'Small is ' + ppi + ' ppi (minimum 180).', code: 'photo-resolution-low', spread: 's1', box: 'small', source: 'a', details: { ppi, minimumPpi: 180 } });
  const overlap: Issue = { message: 'Text overlaps.', code: 'text-overlap', spread: 's1' };
  const keysOf = (ppi: number) => [...issueKeys(checkRows({ errors: [low(ppi)], warnings: [overlap, { ...overlap }] })).values()];
  assert.equal(new Set(keysOf(170)).size, 3, 'two findings of one code in one place are two stops');
  assert.deepEqual(keysOf(170), keysOf(175));
});

test('a problem this version has no words for is named by its code, and a template’s plain finding by its message', () => {
  const rows = checkRows({ errors: [{ message: 'The caption is missing.', code: 'template:missing-caption', spread: 's1', suggestion: 'Write a caption.' }, { message: 'Template crashed.' }],
    warnings: [{ message: 'No track chosen.', code: 'template-issue', spread: 's1' }, { message: 'No track chosen.', code: 'template-issue', spread: 's2' }] });
  assert.deepEqual(rows.map(({ title, fix, items }) => [title, fix, items.length]), [['Missing caption', 'Write a caption.', 1], ['Template crashed', undefined, 1], ['No track chosen', undefined, 2]]);
  assert.deepEqual(rowMessages(rows[0], plain), ['The caption is missing.']);
  assert.deepEqual(rowMessages(rows[2], plain), [], 'nothing is said twice');
});

// A synced book on a second Mac (#308): 216 originals on another Mac, 39 boxes on 12 spreads and 2 on the cover, and two real findings.
const elsewhere = (id: string, extra: Partial<SourceStatus> = {}) => ({ key: 'photo:' + id, kind: 'photo', id, name: id + '.jpg', locator: { provider: 'linked', path: '/imageflow-unlocated/' + id + '.jpg' },
  state: 'unapproved', cached: true, away: 'other-mac', problem: 'Original on another Mac', ...extra }) as SourceStatus;
const unavailable = (source: string, place: Partial<Issue>, status = elsewhere(source)): Issue => ({ message: cachedPreviewText(printProblem(status)!), code: 'source-unavailable',
  source, sourceKind: 'photo', problem: printProblem(status), ...(status.away ? { away: status.away } : {}), ...place });
const ids = Array.from({ length: 216 }, (_, i) => 'ph-' + i);
const secondMac = () => {
  const low = (box: string): Issue => ({ message: box + ' is 170 ppi (minimum 180).', code: 'photo-resolution-low', spread: 's1', where: 'Pages 2–3', box, source: 'ph-0', details: { ppi: 170, minimumPpi: 180 } });
  const errors = [unavailable('ph-0', { spread: 's1', where: 'Pages 2–3', box: 'hero' }), low('small1'),
    ...ids.slice(1, 39).map((id, i) => unavailable(id, { spread: 's' + (i % 12 + 1), where: 'Spread', box: 'b' + i })), low('small2'),
    unavailable('ph-0', { cover: true, where: 'Cover', box: 'front' }), unavailable('ph-40', { cover: true, where: 'Cover', box: 'back' })];
  return { errors, warnings: sourceWarnings(Object.fromEntries(ids.map((id) => ['photo:' + id, elsewhere(id)]))) };
};

test('originals on another Mac are one line, and no errors or warnings, while editing', () => {
  const found = secondMac();
  assert.equal(found.warnings.length, 216);
  const { errors, warnings, notes } = takeAway({ errors: found.errors, warnings: withoutReported(found.warnings, found.errors) });
  assert.deepEqual(errors.map(({ code }) => code), ['photo-resolution-low', 'photo-resolution-low']);
  assert.deepEqual(warnings, []);
  assert.deepEqual(notes.map(awayText), ['216 originals are on another Mac. Needed for printing.']);
  assert.equal(notes[0].placed.length, 41);
  assert.deepEqual(checkRows(found).map(({ level, title, items }) => [level, title, items.length]), [['error', 'Low resolution', 2], ['info', awayText(notes[0]), 41]], 'the two photos come first');
  assert.equal(awayText({ away: 'uploading', sources: ['a'] }), '1 original is still uploading from another Mac. Needed for printing.');
  // Nothing left but the originals: the book reads as clear.
  assert.deepEqual(takeAway({ errors: found.errors.filter(isUnavailableSource), warnings: [] }).errors, []);
});

test('each reason has its own line, and what is really missing stays a finding', () => {
  const statuses = { 'photo:a': elsewhere('a'), 'photo:b': elsewhere('b', { away: 'catalog', state: 'offline', problem: 'Lightroom Classic is not running.' }),
    'photo:c': elsewhere('c', { away: 'not-downloaded', state: 'missing', problem: 'Original not downloaded yet' }), 'photo:d': elsewhere('d', { away: 'uploading', state: 'missing', problem: 'Original still uploading from another Mac' }),
    'photo:e': elsewhere('e', { away: undefined, state: 'missing', problem: 'Original missing: /Photos/e.jpg' }),
    'photo:f': elsewhere('f', { away: undefined, cached: false, problem: 'Locate this original to approve access on this Mac.' }) };
  const { warnings, notes } = takeAway({ errors: [], warnings: sourceWarnings(statuses) });
  assert.deepEqual(notes.map(({ away, sources }) => [away, sources]), [['other-mac', ['a']], ['catalog', ['b']], ['not-downloaded', ['c']], ['uploading', ['d']]]);
  assert.equal(new Set(notes.map(awayText)).size, 4);
  assert.deepEqual(warnings.map(({ source }) => source), ['e', 'f']);
});

test('a source that a page reports is not reported again as an asset, whatever is wrong with it', () => {
  const warnings = sourceWarnings({ 'photo:a': elsewhere('a', { away: undefined, state: 'missing', problem: 'Original missing: /a.jpg' }), 'photo:b': elsewhere('b', { away: undefined, problem: 'Missing' }),
    'photo:c': elsewhere('c', { away: undefined, cached: false, problem: 'Missing' }) });
  const errors: Issue[] = [{ message: 'x', code: 'source-unavailable', source: 'a', sourceKind: 'photo', spread: 's' }, { message: 'x', code: 'photo-missing', source: 'c', sourceKind: 'photo', spread: 's' },
    // A finding of another kind about a photo, or about a text of that ID, reports nothing of its original.
    { message: 'low', code: 'photo-resolution-low', source: 'b', spread: 's' }, { message: 'x', code: 'text-source-missing', source: 'b', sourceKind: 'markdown', spread: 's' }];
  assert.deepEqual(withoutReported(warnings, errors).map(({ source }) => source), ['b']);
});

test('exports still name, count and mark originals that are elsewhere', () => {
  const { errors, warnings } = secondMac();
  const list = exportErrorList(errors).split('\n');
  assert.equal(list[0], 'Original on another Mac: 40 photos on 12 spreads and the cover will print from cached previews.');
  assert.equal(list.filter((line) => line.includes('another Mac')).length, 1, 'named once');
  assert.equal(list.length, 3, 'and the two other errors');
  // What marks PDF and proof pages, and what asks before the export, still sees every one of them.
  assert.equal(errors.filter(isUnavailableSource).length, 41);
  assert.ok(errors.filter(isUnavailableSource).every(({ code, spread, cover }) => code === 'source-unavailable' && (spread || cover)));
  assert.equal(foundText({ errors, warnings }, 'print'), ' 2 errors in Book check. 40 photos print from previews, on marked pages.');
  assert.equal(foundText({ errors: [], warnings: [] }, 'proof'), '');
});

test('a check reports originals that are elsewhere as one warning with every place', () => {
  const { errors, warnings } = secondMac();
  const [one, ...rest] = awayDiagnostics(takeAway({ errors, warnings }).notes);
  assert.deepEqual(rest, []);
  assert.deepEqual([one.code, one.severity, one.location], ['source-unavailable', 'warning', undefined]);
  assert.match(one.message, /Needed for printing\..*marked proofs/);
  assert.equal(one.occurrences!.length, 41);
  assert.deepEqual(one.occurrences![0], { spread: 's1', box: 'hero', source: 'ph-0', where: 'Pages 2–3' });
  assert.deepEqual(one.occurrences!.at(-1), { cover: true, box: 'back', source: 'ph-40', where: 'Cover' });
  assert.deepEqual(one.details, { reason: 'other-mac', originals: 216, placed: 40 });
  const [unplaced] = awayDiagnostics(takeAway({ errors: [], warnings }).notes);
  assert.deepEqual([unplaced.code, unplaced.severity, unplaced.occurrences], ['project-input', 'warning', undefined]);
});

test('a Lightroom photo is elsewhere while its catalog cannot be reached, and a finding once it left the catalog', () => {
  const photo = (state: SourceStatus['state'], cached = true) => elsewhere('a', { locator: { provider: 'lightroom', catalog: 'catalog1', uuid: 'uuid-0001' } as never, state, cached, away: undefined, problem: 'Lightroom Classic is not running.' });
  assert.equal(awayOriginal(photo('offline')), 'catalog');
  assert.equal(awayProblem('catalog', 'Lightroom Classic is not running.'), 'Lightroom Classic is not running.', 'what is wrong with the connection stays readable');
  assert.equal(awayOriginal(photo('offline', false)), undefined, 'no preview: the photo is missing from the page');
  for (const state of ['missing', 'unreadable', 'available'] as const) assert.equal(awayOriginal(photo(state)), undefined);
});

test('a message names its source in place of its ID and path, and leaves its words alone', () => {
  const named = (message: string, id: string, name: string, path?: string) => namedMessage(message, { id, path, name });
  assert.equal(named('Missing Markdown source a.', 'a', 'alps.md'), 'Missing Markdown source alps.md.');
  assert.equal(named('Cover photo is missing photo cover.', 'cover', 'Harbour'), 'Cover photo is missing photo Harbour.');
  assert.equal(named('Text box is missing text text.', 'text', 'Story'), 'Text box is missing text Story.');
  assert.equal(named('Main is missing photo ph-12-ab.', 'ph-12-ab', 'Harbour'), 'Main is missing photo Harbour.');
  assert.equal(named('Main is missing photo ph-12-abc.', 'ph-12-ab', 'Harbour'), 'Main is missing photo ph-12-abc.', 'part of another ID');
  assert.equal(named('files/map-route.gpx cannot be read (map).', 'map', 'route.gpx', 'files/map-route.gpx'), 'route.gpx cannot be read (map).');
  assert.equal(named('Original missing: /a/alps.jpg', 'alps', 'alps.jpg', '/a/alps.jpg'), 'Original missing: alps.jpg', 'a name that holds the ID');
  assert.equal(named('Missing file x1.', 'x1', 'cost $& (1).csv'), 'Missing file cost $& (1).csv.');
});
