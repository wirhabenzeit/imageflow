/**
 * Canonical JSON (ADR 0010, Guardrail 6): the same bytes for structurally equal values, whatever order their object
 * keys were inserted in. Revision hashes and diffs rely on it, so desktop and web hosts must agree; this module is
 * pure and uses no host APIs.
 *
 * - Object keys are sorted recursively by UTF-16 code unit order, the default `Array.prototype.sort` order for strings
 *   (not locale-aware, so every host agrees). Arrays keep their order.
 * - `undefined` properties are omitted, as `JSON.stringify` does. An `undefined` array item is an error, because
 *   `JSON.stringify` would turn it into `null` and hide the difference.
 * - Numbers must be finite; `-0` is written as `0` like `JSON.stringify` does.
 * - Only plain objects, arrays, strings, numbers, booleans and null are accepted. Functions, symbols, bigints, Dates,
 *   Maps, class instances and the like throw: convert them to plain data first. Cycles throw too.
 */
export class CanonicalJsonError extends TypeError {}

const plain = (value: object) => {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

function encode(value: unknown, indent: string, level: string, path: string, active: Set<object>): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new CanonicalJsonError('Cannot serialize a non-finite number at ' + path + '.');
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') throw new CanonicalJsonError('Cannot serialize a ' + typeof value + ' at ' + path + '.');
  if (active.has(value)) throw new CanonicalJsonError('Cannot serialize a circular structure at ' + path + '.');
  const items = Array.isArray(value) ? value : undefined;
  if (!items && !plain(value)) throw new CanonicalJsonError('Cannot serialize a non-plain object at ' + path + '.');
  active.add(value);
  const inner = level + indent;
  let parts: string[];
  if (items) {
    parts = Array.from({ length: items.length }, (_, index) => {
      if (!(index in items) || items[index] === undefined) throw new CanonicalJsonError('Cannot serialize an undefined array item at ' + path + '[' + index + '].');
      return encode(items[index], indent, inner, path + '[' + index + ']', active);
    });
  } else {
    const record = value as Record<string, unknown>;
    parts = Object.keys(record).sort().filter((key) => record[key] !== undefined)
      .map((key) => JSON.stringify(key) + (indent ? ': ' : ':') + encode(record[key], indent, inner, path + '.' + key, active));
  }
  active.delete(value);
  const [open, close] = items ? ['[', ']'] : ['{', '}'];
  if (!parts.length) return open + close;
  return indent ? open + '\n' + inner + parts.join(',\n' + inner) + '\n' + level + close : open + parts.join(',') + close;
}

/** Compact canonical JSON, the form that is hashed. */
export const canonicalJson = (value: unknown) => encode(value, '', '', '$', new Set());

/** Canonical JSON indented with `indent` spaces (like `JSON.stringify(value, null, indent)`), for saved files. */
export const canonicalJsonIndented = (value: unknown, indent = 2) => encode(value, ' '.repeat(indent), '', '$', new Set());
