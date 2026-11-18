import { parseDocument } from 'yaml';

/** A value from a Markdown source's frontmatter: what JSON can hold. */
export type TextMetaValue = string | number | boolean | null | TextMetaValue[] | { [key: string]: TextMetaValue };
export type TextMeta = { [key: string]: TextMetaValue };

export type Frontmatter = {
  // The source with the header replaced by blank lines of the same length, so Markdown offsets still point into
  // the file as saved (the text flow matches split blocks by them).
  body: string;
  // The header's fields; null when the source has no header.
  meta: TextMeta | null;
  // Set when the source starts with what is meant as a header but its YAML cannot be read. The header is still
  // left out of the text, and `meta` is null.
  error?: { message: string; line: number };
};

const OPEN = /^\uFEFF?---[ \t]*$/;
const CLOSE = /^(?:---|\.\.\.)[ \t]*$/;
// A first line like `title: …` or `- item`: the block was written as YAML, not as Markdown between two rules.
const LOOKS_LIKE_YAML = /^\s*(?:[A-Za-z0-9_"'][^:\n]*:(?:\s|$)|-\s)/;

const blank = (text: string) => text.replace(/[^\r\n]/g, ' ');

/**
 * Reads an optional YAML header at the very start of a Markdown source: a line `---`, YAML, and a closing line
 * `---` or `...`. The YAML must be a mapping; anything else (Markdown between two thematic breaks, say) is left as
 * Markdown. Values follow YAML 1.2's core schema, so dates and `yes`/`no` stay strings.
 */
export function splitFrontmatter(source: string): Frontmatter {
  const lines = source.split('\n');
  if (!OPEN.test(lines[0].replace(/\r$/, ''))) return { body: source, meta: null };
  const close = lines.findIndex((line, i) => i > 0 && CLOSE.test(line.replace(/\r$/, '')));
  if (close < 0) return { body: source, meta: null };
  const yaml = lines.slice(1, close).map((line) => line.replace(/\r$/, '')).join('\n');
  const end = lines.slice(0, close + 1).join('\n').length;
  const body = blank(source.slice(0, end)) + source.slice(end);
  const intended = yaml.split('\n').find((line) => line.trim())?.match(LOOKS_LIKE_YAML) != null || !yaml.trim();
  const document = parseDocument(yaml, { schema: 'core', version: '1.2', uniqueKeys: true });
  const problem = document.errors[0];
  if (problem) {
    if (!intended) return { body: source, meta: null };
    const line = (problem.linePos?.[0].line ?? 1) + 1;
    return { body, meta: null, error: { message: problem.message.split('\n')[0].replace(/ at line \d+, column \d+:?$/, ''), line } };
  }
  let value: unknown;
  try { value = document.toJS({ maxAliasCount: 50 }); }
  catch (error) { return { body, meta: null, error: { message: error instanceof Error ? error.message : String(error), line: 2 } }; }
  if (value == null) return { body, meta: {} };
  if (typeof value !== 'object' || Array.isArray(value)) {
    if (!intended) return { body: source, meta: null };
    return { body, meta: null, error: { message: 'The header must be a list of `key: value` fields.', line: 2 } };
  }
  return { body, meta: plain(value) as TextMeta };
}

// Plain JSON values: no Infinity or NaN, keys as strings, own properties only.
function plain(value: unknown): TextMetaValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(plain);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item)]));
  return String(value);
}
