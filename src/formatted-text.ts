// Inline formatting for string parameters declared with `markdown: 'inline'`. The saved value is a string with a
// small Markdown subset: `**bold**`, `*italic*` (and `***both***`) and `~~strikethrough~~`, with `\*`, `\~` and `\\`
// for literal characters. Nothing else is Markdown here: `#`, `_`, links and HTML are kept as typed. Rendering,
// editing and length checks share these functions so the page, the inline editor and validation agree on a value.

export const marks = ['bold', 'italic', 'strike'] as const;
export type Mark = typeof marks[number];
export type Marks = Record<Mark, boolean>;
export type Segment = { text: string } & Marks;
/** One visible character and its marks: the inline editor's model. */
export type RichChar = { ch: string } & Marks;

const markers: Record<Mark, string> = { bold: '**', italic: '*', strike: '~~' };
const noMarks: Marks = { bold: false, italic: false, strike: false };

type Delim = { kind: 'delim'; char: '*' | '~'; length: number; canOpen: boolean; canClose: boolean; close: number[]; open: number[]; literal: number };
type Token = { kind: 'text'; text: string } | Delim;

const space = (ch: string | undefined) => ch === undefined || /\s/.test(ch);
const escapable = (ch: string | undefined) => ch === '*' || ch === '~' || ch === '\\';

function tokenize(source: string) {
  const tokens: Token[] = [];
  let text = '';
  const flush = () => { if (text) tokens.push({ kind: 'text', text }); text = ''; };
  for (let i = 0; i < source.length;) {
    const ch = source[i];
    if (ch === '\\' && escapable(source[i + 1])) { text += source[i + 1]; i += 2; continue; }
    if (ch !== '*' && ch !== '~') { text += ch; i++; continue; }
    let end = i;
    while (source[end] === ch) end++;
    const length = end - i;
    if (ch === '*' ? length > 3 : length !== 2) { text += source.slice(i, end); i = end; continue; }
    flush();
    // Like CommonMark's flanking rules, simplified: an opener is followed by a visible character, a closer follows one.
    tokens.push({ kind: 'delim', char: ch, length, canOpen: !space(source[end]), canClose: i > 0 && !space(source[i - 1]), close: [], open: [], literal: 0 });
    i = end;
  }
  flush();
  return tokens;
}

/** The visible text and marks of a saved value. Unmatched markers stay as literal characters. */
export function parseFormatted(source: string): Segment[] {
  const tokens = tokenize(source);
  // Each opener: its marker character and length (`*` 1 italic, `*` 2 bold, `~` 2 strikethrough).
  const openers: { char: '*' | '~'; length: number }[] = [];
  const stacks = { '*': [] as number[], '~': [] as number[] };
  const matched = new Set<number>();
  for (const token of tokens) {
    if (token.kind !== 'delim') continue;
    const stack = stacks[token.char];
    let remaining = token.length;
    // A closer matches the nearest opener of the same length, even under another one, so marks may overlap
    // (`**a*b**c*`). A run of three closes a `**` and a `*` separately; what it does not close may open.
    const close = (length: number) => {
      const at = stack.findLastIndex((id) => openers[id].length === length);
      if (at < 0) return false;
      const [id] = stack.splice(at, 1);
      matched.add(id);
      token.close.push(id);
      remaining -= length;
      return true;
    };
    if (token.canClose && !close(remaining) && remaining === 3) {
      const nearest = [1, 2].sort((a, b) => stack.findLastIndex((id) => openers[id].length === b) - stack.findLastIndex((id) => openers[id].length === a));
      nearest.forEach(close);
    }
    if (remaining > 0 && token.canOpen) {
      for (const length of remaining === 3 ? [2, 1] : [remaining]) {
        openers.push({ char: token.char, length });
        token.open.push(openers.length - 1);
        stack.push(openers.length - 1);
      }
      remaining = 0;
    }
    token.literal = remaining;
  }
  const markOf = (id: number): Mark => openers[id].char === '~' ? 'strike' : openers[id].length === 2 ? 'bold' : 'italic';
  const depth: Record<Mark, number> = { bold: 0, italic: 0, strike: 0 };
  const segments: Segment[] = [];
  const push = (text: string) => { if (text) segments.push({ text, bold: depth.bold > 0, italic: depth.italic > 0, strike: depth.strike > 0 }); };
  for (const token of tokens) {
    if (token.kind === 'text') { push(token.text); continue; }
    for (const id of token.close) depth[markOf(id)]--;
    push(token.char.repeat(token.literal));
    for (const id of token.open) {
      if (matched.has(id)) depth[markOf(id)]++;
      else push(token.char.repeat(openers[id].length));
    }
  }
  return mergeSegments(segments);
}

/** The value as plain text, without markers: what `maxLength` counts and what a reader sees. */
export function plainFormatted(source: string) {
  return parseFormatted(source).map(({ text }) => text).join('');
}

const sameMarks = (a: Marks, b: Marks) => marks.every((mark) => a[mark] === b[mark]);
export const marksOf = (value: Marks): Marks => ({ bold: value.bold, italic: value.italic, strike: value.strike });

function mergeSegments(segments: Segment[]) {
  const merged: Segment[] = [];
  for (const segment of segments) {
    if (!segment.text) continue;
    const last = merged[merged.length - 1];
    if (last && sameMarks(last, segment)) last.text += segment.text;
    else merged.push({ ...segment });
  }
  return merged;
}

export function segmentsToChars(segments: Segment[]): RichChar[] {
  return segments.flatMap((segment) => [...segment.text].map((ch) => ({ ch, ...marksOf(segment) })));
}

export function charsToSegments(chars: RichChar[]): Segment[] {
  return mergeSegments(chars.map(({ ch, ...rest }) => ({ text: ch, ...marksOf(rest) })));
}

// Whitespace takes the marks both of its neighbours share, so markers never sit next to a space (`**a **b` would
// not close). A bold space looks the same as a plain one; a struck-through space between struck words keeps its line.
function settleWhitespace(chars: RichChar[]) {
  const out = chars.map((char) => ({ ...char }));
  for (let i = 0; i < out.length;) {
    if (!/\s/.test(out[i].ch)) { i++; continue; }
    let end = i;
    while (end < out.length && /\s/.test(out[end].ch)) end++;
    const before = out[i - 1];
    const after = out[end];
    for (let j = i; j < end; j++) for (const mark of marks) out[j][mark] = !!before?.[mark] && !!after?.[mark];
    i = end;
  }
  return out;
}

function sameSegments(a: Segment[], b: Segment[]) {
  return a.length === b.length && a.every((segment, i) => segment.text === b[i].text && sameMarks(segment, b[i]));
}

function write(segments: Segment[], escape: boolean) {
  let out = '';
  const open: Mark[] = [];
  for (const segment of segments) {
    // Close the marks that end here, then open what this segment adds. Marks may overlap rather than nest.
    for (const mark of [...open].reverse()) if (!segment[mark]) { open.splice(open.indexOf(mark), 1); out += markers[mark]; }
    for (const mark of marks) if (segment[mark] && !open.includes(mark)) { open.push(mark); out += markers[mark]; }
    out += escape ? segment.text.replace(/[\\*~]/g, '\\$&') : segment.text;
  }
  for (const mark of open.reverse()) out += markers[mark];
  return out;
}

/** The saved string for formatted text. Literal markers are escaped only when they would otherwise turn into marks. */
export function serializeFormatted(input: Segment[] | RichChar[]): string {
  const chars = input.length && 'ch' in input[0] ? input as RichChar[] : segmentsToChars(input as Segment[]);
  const target = charsToSegments(settleWhitespace(chars));
  const plain = write(target, false);
  return sameSegments(parseFormatted(plain), target) ? plain : write(target, true);
}

/** Adds a mark to a range, or removes it when every visible character there already has it. */
export function toggleMark(chars: RichChar[], start: number, end: number, mark: Mark): RichChar[] {
  const range = chars.slice(start, end).filter(({ ch }) => !/\s/.test(ch));
  const on = !range.length || !range.every((char) => char[mark]);
  return chars.map((char, i) => i >= start && i < end ? { ...char, [mark]: on } : char);
}

/** The word around a collapsed caret, for Cmd+B without a selection. Undefined between words. */
export function wordAt(chars: RichChar[], index: number): [number, number] | undefined {
  const word = (i: number) => i >= 0 && i < chars.length && /[\p{L}\p{N}'’-]/u.test(chars[i].ch);
  if (!word(index - 1) || !word(index)) return;
  let start = index;
  let end = index;
  while (word(start - 1)) start--;
  while (word(end)) end++;
  return [start, end];
}

/**
 * Live conversion while typing: when the caret follows a closing `*`, `**`, `***` or `~~` that matches an opener of
 * the same kind on the same line, the markers are removed and the text between them is marked. Returns the new
 * characters, the caret, and the marks the text had before, which typing after the caret continues with.
 */
export function convertClosing(chars: RichChar[], caret: number): { chars: RichChar[]; caret: number; outside: Marks } | undefined {
  const char = chars[caret - 1]?.ch;
  if (char !== '*' && char !== '~') return;
  const is = (i: number) => chars[i]?.ch === char;
  if (is(caret)) return;
  let length = 0;
  while (length < 4 && is(caret - 1 - length)) length++;
  if (char === '*' ? length > 3 : length !== 2) return;
  const closeStart = caret - length;
  const last = chars[closeStart - 1];
  if (!last || /\s/.test(last.ch) || last.ch === '\\') return;
  for (let innerStart = closeStart - 1; innerStart > 0; innerStart--) {
    const ch = chars[innerStart - 1].ch;
    if (ch === '\n') return;
    if (ch !== char) continue;
    let openStart = innerStart - 1;
    while (is(openStart - 1)) openStart--;
    if (innerStart - openStart !== length || chars[openStart - 1]?.ch === '\\' || /\s/.test(chars[innerStart].ch)) return;
    const inner = chars.slice(innerStart, closeStart);
    const added: Mark[] = char === '~' ? ['strike'] : length === 3 ? ['bold', 'italic'] : length === 2 ? ['bold'] : ['italic'];
    const marked = inner.map((c) => ({ ...c, ...Object.fromEntries(added.map((mark) => [mark, true])) }));
    return { chars: [...chars.slice(0, openStart), ...marked, ...chars.slice(caret)], caret: openStart + inner.length, outside: marksOf(chars[innerStart]) };
  }
}

export { noMarks };
