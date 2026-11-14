import { charsToSegments, convertClosing, marksOf, noMarks, segmentsToChars, serializeFormatted, toggleMark, wordAt, parseFormatted } from './formatted-text';
import type { Mark, Marks, RichChar } from './formatted-text';

// Formatting in the inline text editor, for string parameters declared with `markdown: 'inline'`. The editable node
// shows <strong>, <em> and <s> in the template's own type; the saved value is the Markdown subset of formatted-text.ts.
// Because conversions and shortcuts rewrite the node, this editor keeps its own Undo history instead of the browser's.

const markTags: Record<string, Mark> = { STRONG: 'bold', B: 'bold', EM: 'italic', I: 'italic', S: 'strike', STRIKE: 'strike', DEL: 'strike' };
const blockTags = new Set(['DIV', 'P', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE']);

function elementMarks(element: HTMLElement, marks: Marks): Marks {
  const next = { ...marks };
  const tag = markTags[element.tagName];
  if (tag) next[tag] = true;
  // Chromium keeps formatting as inline styles when it merges lines or deletes across a boundary.
  const weight = element.style.fontWeight;
  if (weight) next.bold = weight === 'bold' || weight === 'bolder' || Number(weight) >= 600;
  if (element.style.fontStyle) next.italic = element.style.fontStyle === 'italic' || element.style.fontStyle === 'oblique';
  const decoration = element.style.textDecorationLine || element.style.textDecoration;
  if (decoration) next.strike = decoration.includes('line-through');
  return next;
}

/** The node's characters with their marks, and the character index of each requested DOM point. */
export function readRich(node: HTMLElement, points: readonly (readonly [Node | null, number])[] = []) {
  const chars: RichChar[] = [];
  const offsets = points.map(() => -1);
  const at = (container: Node, offset: number) => points.forEach(([c, o], i) => { if (c === container && o === offset && offsets[i] < 0) offsets[i] = chars.length; });
  const walk = (parent: Node, marks: Marks) => {
    parent.childNodes.forEach((child, index) => {
      at(parent, index);
      if (child.nodeType === Node.TEXT_NODE) {
        const text = (child as Text).data;
        points.forEach(([c, o], i) => { if (c === child && offsets[i] < 0) offsets[i] = chars.length + Math.min(o, text.length); });
        for (const ch of text) chars.push({ ch, ...marks });
      } else if (child instanceof HTMLElement) {
        // A <br> at the end of a line container is the browser's caret placeholder, not a saved newline.
        if (child.tagName === 'BR') { if (child.nextSibling) chars.push({ ch: '\n', ...noMarks }); return; }
        if (blockTags.has(child.tagName) && chars.length && chars[chars.length - 1].ch !== '\n') chars.push({ ch: '\n', ...noMarks });
        walk(child, elementMarks(child, marks));
      }
    });
    at(parent, parent.childNodes.length);
  };
  walk(node, noMarks);
  return { chars, offsets: offsets.map((offset) => offset < 0 ? chars.length : offset) };
}

export function renderRich(node: HTMLElement, chars: RichChar[]) {
  node.replaceChildren(...charsToSegments(chars).map((segment) => {
    let content: Node = document.createTextNode(segment.text);
    for (const [mark, tag] of [['strike', 's'], ['italic', 'em'], ['bold', 'strong']] as const) {
      if (!segment[mark]) continue;
      const wrapper = document.createElement(tag);
      wrapper.append(content);
      content = wrapper;
    }
    return content;
  }));
}

// The DOM point of a character index: the end of the text before it, so typing continues that text's style.
function pointAt(node: HTMLElement, index: number): [Node, number] {
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  let seen = 0;
  for (let text = walker.nextNode() as Text | null; text; text = walker.nextNode() as Text | null) {
    if (index <= seen + text.data.length) return [text, index - seen];
    seen += text.data.length;
  }
  return [node, node.childNodes.length];
}

type State = { chars: RichChar[]; start: number; end: number };

export function formattedEditing(node: HTMLElement, value: string, changed: () => void) {
  const undo: State[] = [];
  const redo: State[] = [];
  let lastEdit = 0;
  let lastKind = '';
  // Marks for the next typed text at a caret, after a shortcut without a selection or a live conversion.
  let pending: { marks: Marks; at: number } | undefined;

  const selection = () => {
    const current = getSelection();
    const { chars, offsets } = readRich(node, [[current?.anchorNode ?? null, current?.anchorOffset ?? 0], [current?.focusNode ?? null, current?.focusOffset ?? 0]]);
    const inside = !!current?.anchorNode && node.contains(current.anchorNode);
    let [a, b] = inside ? offsets : [chars.length, chars.length];
    // Where the page collapses spaces (pre-line headings), the browser reports a caret after trailing spaces as
    // before them, and typing there still lands after them. Do the same, so formatted typing keeps its space.
    if (a === b && /^(normal|nowrap|pre-line)$/.test(getComputedStyle(node).whiteSpace)) {
      // At the end of the text that includes trailing line breaks: typing after Enter lands on the new last line.
      let end = a;
      while (end < chars.length && /\s/.test(chars[end].ch)) end++;
      if (end !== chars.length) for (end = a; end < chars.length && chars[end].ch !== '\n' && /\s/.test(chars[end].ch);) end++;
      if (end > a && (end === chars.length || chars[end].ch === '\n')) a = b = end;
    }
    return { chars, start: Math.min(a, b), end: Math.max(a, b) };
  };
  const select = (start: number, end = start) => {
    const range = document.createRange();
    range.setStart(...pointAt(node, start));
    range.setEnd(...pointAt(node, end));
    const current = getSelection();
    current?.removeAllRanges();
    current?.addRange(range);
  };
  const show = (state: State) => {
    renderRich(node, state.chars);
    select(state.start, state.end);
    changed();
  };
  // Typing groups into one Undo step until a pause, a different kind of edit, or a conversion.
  const checkpoint = (kind: string, force = false) => {
    const now = performance.now();
    if (force || kind !== lastKind || now - lastEdit > 1000) {
      undo.push(selection());
      if (undo.length > 200) undo.shift();
    }
    redo.length = 0;
    lastEdit = now;
    lastKind = force ? 'format' : kind;
  };
  const step = (from: State[], to: State[]) => {
    const state = from.pop();
    if (!state) return;
    to.push(selection());
    pending = undefined;
    lastKind = 'history';
    show(state);
  };
  // The marks the browser gives typed text: those of the elements around the caret.
  const caretMarks = (): Marks => {
    const chain: HTMLElement[] = [];
    for (let at = getSelection()?.anchorNode ?? null; at && at !== node; at = at.parentNode) if (at instanceof HTMLElement) chain.unshift(at);
    return chain.reduce((marks, element) => elementMarks(element, marks), { ...noMarks });
  };
  const marksBefore = (chars: RichChar[], index: number): Marks => pending?.at === index ? pending.marks : index > 0 ? marksOf(chars[index - 1]) : { ...noMarks };

  renderRich(node, segmentsToChars(parseFormatted(value)));
  document.addEventListener('selectionchange', () => {
    if (pending && selection().start !== pending.at) pending = undefined;
  });

  return {
    read: (multiline: boolean) => serializeFormatted(readRich(node).chars.map((char) => multiline || char.ch !== '\n' ? char : { ...char, ch: ' ' })),
    checkpoint,
    undo: () => step(undo, redo),
    redo: () => step(redo, undo),
    toggle(mark: Mark) {
      const { chars, start, end } = selection();
      const range = start === end ? wordAt(chars, start) : [start, end];
      if (!range) {
        const marks = marksBefore(chars, start);
        pending = { marks: { ...marks, [mark]: !marks[mark] }, at: start };
        return;
      }
      checkpoint('format', true);
      pending = undefined;
      show({ chars: toggleMark(chars, range[0], range[1], mark), start, end });
    },
    /** Handles text typed with pending marks. True when the input was handled here. */
    insert(event: InputEvent) {
      if (event.inputType !== 'insertText' || !event.data || !pending) return false;
      const { chars, start, end } = selection();
      if (start !== end || start !== pending.at) { pending = undefined; return false; }
      const marks = pending.marks;
      pending = undefined;
      // The browser types into the elements around the caret: let it, when they already carry these marks.
      if (marks.bold === caretMarks().bold && marks.italic === caretMarks().italic && marks.strike === caretMarks().strike) return false;
      event.preventDefault();
      checkpoint('insert');
      const typed = [...event.data].map((ch) => ({ ch, ...marks }));
      show({ chars: [...chars.slice(0, start), ...typed, ...chars.slice(start)], start: start + typed.length, end: start + typed.length });
      return true;
    },
    /** A typed line break. The browser inserts it, which keeps a caret on a new last line; the next text keeps the
     * style of the text before it, or the style chosen for it. */
    newline(insert: () => void) {
      const { chars, start } = selection();
      const marks = marksBefore(chars, start);
      checkpoint('insert');
      insert();
      pending = { marks, at: selection().start };
    },
    /** After typing a marker character: converts `**text**`, `*text*` and `~~text~~` once the closing marker matches. */
    convert(event: InputEvent) {
      if (event.inputType !== 'insertText' || !/[*~]$/.test(event.data ?? '')) return;
      const { chars, start, end } = selection();
      const converted = start === end ? convertClosing(chars, start) : undefined;
      if (!converted) return;
      // The typed markers are their own Undo step: Undo right after a conversion brings them back, as typed.
      checkpoint('format', true);
      renderRich(node, converted.chars);
      select(converted.caret);
      pending = { marks: converted.outside, at: converted.caret };
    },
  };
}
