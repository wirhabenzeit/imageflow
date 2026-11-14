import assert from 'node:assert/strict';
import { test } from 'node:test';
import { charsToSegments, convertClosing, parseFormatted, plainFormatted, segmentsToChars, serializeFormatted, toggleMark, wordAt } from '../src/formatted-text';
import type { RichChar, Segment } from '../src/formatted-text';
import { isParameterValue, p, parameterSchema } from '../src/parameters';
import { textProblem } from '../src/inline-text';

const s = (text: string, bold = false, italic = false, strike = false): Segment => ({ text, bold, italic, strike });
const chars = (text: string) => segmentsToChars([s(text)]);
const text = (input: RichChar[]) => input.map(({ ch }) => ch).join('');

test('parses bold, italic and both, keeping everything else as typed', () => {
  assert.deepEqual(parseFormatted('A **bold** and *italic* word'), [s('A '), s('bold', true), s(' and '), s('italic', false, true), s(' word')]);
  assert.deepEqual(parseFormatted('***both***'), [s('both', true, true)]);
  assert.deepEqual(parseFormatted('**bold *and italic***'), [s('bold ', true), s('and italic', true, true)]);
  assert.deepEqual(parseFormatted('in*word*emphasis'), [s('in'), s('word', false, true), s('emphasis')]);
  assert.deepEqual(parseFormatted('~~gone~~ and ~single~ ~~~three~~~'), [s('gone', false, false, true), s(' and ~single~ ~~~three~~~')]);
  assert.deepEqual(parseFormatted('**~~both~~**'), [s('both', true, false, true)]);
  assert.deepEqual(parseFormatted('# Not a heading, _not italic_, [no](link)'), [s('# Not a heading, _not italic_, [no](link)')]);
});

test('unmatched and spaced markers stay literal', () => {
  for (const literal of ['5 * 3 = 15', 'Footnote*', '**open', 'a ** b', '* list', '**a*', '****x****']) {
    assert.deepEqual(parseFormatted(literal), [s(literal)], literal);
  }
  assert.deepEqual(parseFormatted('\\*not\\* \\\\'), [s('*not* \\')]);
});

test('plain text drops markers and escapes', () => {
  assert.equal(plainFormatted('**Bold** \\*star\\*'), 'Bold *star*');
});

test('serializing round-trips and escapes only where needed', () => {
  const cases: Segment[][] = [
    [s('plain')],
    [s('A '), s('bold', true), s(' word')],
    [s('bold', true), s('both', true, true), s('italic', false, true)],
    [s('italic', false, true), s('bold', true)],
    [s('in'), s('word', false, true), s('emphasis')],
    [s('*not*'), s(' marks '), s('real', true)],
    [s('5 * 3')],
    [s('back\\slash *x*', true)],
    [s('struck', false, false, true), s(' and '), s('bold struck', true, false, true)],
    [s('~~literal~~ tildes')],
    [s('line one', true), s('\n'), s('line two', false, true)],
  ];
  for (const segments of cases) {
    const saved = serializeFormatted(segments);
    assert.deepEqual(parseFormatted(saved), charsToSegments(segmentsToChars(segments)), saved);
    assert.equal(plainFormatted(saved), segments.map(({ text }) => text).join(''), saved);
  }
  assert.equal(serializeFormatted([s('A '), s('bold', true), s(' word')]), 'A **bold** word');
  assert.equal(serializeFormatted([s('5 * 3')]), '5 * 3', 'harmless asterisks are not escaped');
  assert.equal(serializeFormatted([s('*not*')]), '\\*not\\*');
  assert.equal(serializeFormatted([s('a ', false, false, true), s('b', false, false, true)]), '~~a b~~');
});

test('whitespace at the edge of a mark moves outside its markers', () => {
  const saved = serializeFormatted([s('bold ', true), s('plain')]);
  assert.equal(saved, '**bold** plain');
  assert.deepEqual(parseFormatted(saved), [s('bold', true), s(' plain')]);
});

test('toggling marks a range, or clears it when the range already has it', () => {
  const bolded = toggleMark(chars('one two'), 4, 7, 'bold');
  assert.equal(serializeFormatted(bolded), 'one **two**');
  assert.equal(serializeFormatted(toggleMark(bolded, 0, 7, 'bold')), '**one two**');
  assert.equal(serializeFormatted(toggleMark(toggleMark(bolded, 0, 7, 'bold'), 0, 7, 'bold')), 'one two');
  assert.deepEqual(wordAt(chars('one two'), 5), [4, 7]);
  assert.equal(wordAt(chars('one two'), 3), undefined);
});

test('a closing marker that matches its opener converts while typing', () => {
  const bold = convertClosing(chars('say **hi**'), 10)!;
  assert.equal(text(bold.chars), 'say hi');
  assert.equal(bold.caret, 6);
  assert.equal(serializeFormatted(bold.chars), 'say **hi**');
  assert.deepEqual(bold.outside, { bold: false, italic: false, strike: false });
  const italic = convertClosing(chars('*it* rest'), 4)!;
  assert.equal(serializeFormatted(italic.chars), '*it* rest');
  assert.equal(italic.caret, 2);
  assert.equal(serializeFormatted(convertClosing(chars('***both***'), 10)!.chars), '***both***');
  assert.equal(serializeFormatted(convertClosing(chars('~~old~~'), 7)!.chars), '~~old~~');
  assert.equal(convertClosing(chars('~old~'), 5), undefined, 'a single tilde is not strikethrough');
});

test('typing does not convert mismatched, spaced, escaped or multi-line markers', () => {
  assert.equal(convertClosing(chars('**abc*'), 6), undefined, 'one closing star of two waits for the second');
  assert.equal(convertClosing(chars('5 * 3 *'), 7), undefined);
  assert.equal(convertClosing(chars('*abc *'), 6), undefined);
  assert.equal(convertClosing(chars('* abc*'), 6), undefined);
  assert.equal(convertClosing(chars('\\*abc*'), 6), undefined);
  assert.equal(convertClosing(chars('*ab\ncd*'), 7), undefined);
  assert.equal(convertClosing(chars('*abc**'), 5), undefined, 'the caret before another star is still typing a marker');
});

test('markdown string parameters validate and count only visible characters', () => {
  const field = p.string({ label: 'Heading', default: '', maxLength: 4, markdown: 'inline' });
  assert.ok(parameterSchema.safeParse(field).success);
  assert.ok(isParameterValue(field, '**Bold**'));
  assert.ok(!isParameterValue(field, '**Bolder**'));
  assert.equal(textProblem(field, '*abcd*'), '');
  assert.ok(!isParameterValue(p.string({ label: 'Plain', default: '', maxLength: 4 }), '**ab**'));
  assert.ok(!parameterSchema.safeParse({ type: 'string', label: 'X', default: '', markdown: 'full' }).success);
});

test('any text with any marks survives saving and reading back', () => {
  // A seeded generator of hostile input: literal markers, backslashes, newlines and marks changing on every character.
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let n = 0; n < 20000; n++) {
    const input = Array.from({ length: 1 + Math.floor(random() * 8) }, () => ({
      ch: ['a', 'b', ' ', '*', '~', '\\', '\n'][Math.floor(random() * 7)], bold: random() < .4, italic: random() < .4, strike: random() < .3,
    }));
    const saved = serializeFormatted(input);
    const back = segmentsToChars(parseFormatted(saved));
    assert.equal(back.map(({ ch }) => ch).join(''), input.map(({ ch }) => ch).join(''), saved);
    // Whitespace may take its neighbours' marks; every visible character keeps its own.
    back.forEach((char, i) => {
      if (!/\s/.test(char.ch)) assert.deepEqual([char.bold, char.italic, char.strike], [input[i].bold, input[i].italic, input[i].strike], saved);
    });
  }
});
