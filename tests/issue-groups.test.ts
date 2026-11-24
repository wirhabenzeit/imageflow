import assert from 'node:assert/strict';
import test from 'node:test';
import { groupExtent, groupIssues, issueCause } from '../src/issue-groups';
import type { LeveledIssue } from '../src/issue-groups';
import { cachedPreviewNote, cachedPreviewText, printProblem } from '../src/source-locations';
import type { SourceStatus } from '../src/source-locations';
import { awayDiagnostics, awayOriginal, awayProblem, awayText, sourceWarnings, takeAway, withoutReported } from '../src/away-originals';
import { exportErrorList, foundText } from '../src/export-errors';
import { isUnavailableSource } from '../src/source-diagnostics';
import type { Issue } from '../src/desktop';

const placed = (spread: string, message: string): LeveledIssue => ({ level: 'error', issue: { message, spread, where: 'Pages ' + spread, code: 'source-unavailable' } });
const asset = (message: string): LeveledIssue => ({ level: 'warning', issue: { message, code: 'project-input' } });

test('an issue’s cause leaves out the file, the asset and the cached-preview note', () => {
  assert.equal(issueCause({ message: 'Missing project file: photos/sunset.jpg' + cachedPreviewNote }), 'Missing project file');
  assert.equal(issueCause({ message: 'photo aurora · Missing project file: photos/aurora.jpg' }), 'Missing project file');
  assert.equal(issueCause({ message: 'photo ph-1 · Lightroom Classic is not running, or its ImageFlow plugin is not connected.' }),
    'Lightroom Classic is not running, or its ImageFlow plugin is not connected');
});

test('an unavailable original on the cover has the cause of those on spreads, and one full stop', () => {
  const problem = 'Locate this original to approve access on this Mac.';
  const message = cachedPreviewText(problem);
  assert.doesNotMatch(message, /\.\./);
  const cover: LeveledIssue = { level: 'error', issue: { message, cover: true, where: 'Cover', code: 'source-unavailable' } };
  const rows = groupIssues([placed('a', message), cover, placed('b', message)]);
  assert.equal(rows.length, 1);
  assert.ok('group' in rows[0] && rows[0].group.cause === problem.slice(0, -1));
});

test('three or more issues with one cause and level become one group in place of the first; fewer stay single', () => {
  const items = [placed('a', 'Page count is 2.'), placed('a', 'Missing project file: photos/1.jpg'), placed('b', 'Missing project file: photos/2.jpg'),
    asset('photo one · Missing project file: photos/1.jpg'), placed('c', 'Missing project file: photos/3.jpg'), asset('photo two · Missing project file: photos/2.jpg')];
  const rows = groupIssues(items);
  assert.equal(rows.length, 4);
  assert.ok('item' in rows[0] && rows[0].item.issue.message === 'Page count is 2.');
  assert.ok('group' in rows[1]);
  if ('group' in rows[1]) {
    assert.equal(rows[1].group.cause, 'Missing project file');
    assert.equal(rows[1].group.items.length, 3);
    assert.equal(groupExtent(rows[1].group), '3 places on 3 spreads');
  }
  // Two warnings of the same cause are fewer than three: they stay single rows, in their order.
  assert.ok('item' in rows[2] && rows[2].item.level === 'warning');
  assert.ok('item' in rows[3] && rows[3].item.level === 'warning');
  const photos = groupIssues([asset('photo a · Original missing: /x/a.jpg'), asset('photo b · Original missing: /x/b.jpg'), asset('photo c · Original missing: /x/c.jpg')]);
  assert.ok('group' in photos[0] && groupExtent(photos[0].group) === '3 photos');
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

test('a check reports originals that are elsewhere as one error with every place, and as a warning only while none is placed', () => {
  const { errors, warnings } = secondMac();
  const [one, ...rest] = awayDiagnostics(takeAway({ errors, warnings }).notes);
  assert.deepEqual(rest, []);
  assert.deepEqual([one.code, one.severity, one.location], ['source-unavailable', 'error', undefined]);
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
