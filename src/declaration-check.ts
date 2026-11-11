import type { Parameters } from './parameters';

// Findings about a template declaration that the schema accepts but that are probably mistakes. They are warnings,
// not errors, so a contract-1 template that loaded before keeps loading. The authoring types reject the same
// mistakes at compile time; this covers untyped templates and spreads typed separately with spreadFor().
export type DeclarationWarning = {
  code: 'declaration-unknown-property' | 'declaration-document-mismatch';
  message: string; path: string; details: Record<string, string>; suggestion: string;
};

// Known keys come from the schema that validates the declaration, so they cannot drift from it. The walk follows
// objects, records, discriminated unions (parameters by `type`) and optional or default wrappers.
type Def = {
  type: string; shape?: Record<string, Schema>; valueType?: Schema; innerType?: Schema; in?: Schema;
  options?: Schema[]; discriminator?: string; values?: unknown[];
};
export type Schema = { _zod: { def: Def } };
function unwrap(schema: Schema): Def {
  const def = schema._zod.def;
  if (def.innerType) return unwrap(def.innerType);
  if (def.type === 'pipe' && def.in) return unwrap(def.in);
  return def;
}
// The union member a value belongs to, by its discriminator, such as a parameter's `type`.
function member(def: Def, value: Record<string, unknown>) {
  const key = def.discriminator;
  if (!key) return undefined;
  return def.options?.map(unwrap).find((option) => option.shape?.[key] && unwrap(option.shape[key]).values?.includes(value[key]));
}

const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

// Edit distance with adjacent transpositions, for "did you mean".
function distance(a: string, b: string) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i ? (j ? 0 : i) : j)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}
// The known key a misspelling most likely meant: same letters in another case, or a few edits away.
export function closest(name: string, known: string[]) {
  const limit = Math.max(1, Math.min(2, Math.floor(name.length / 3)));
  return known.map((key) => ({ key, score: key.toLowerCase() === name.toLowerCase() ? 0 : distance(name, key) }))
    .filter(({ score }) => score <= limit).sort((a, b) => a.score - b.score)[0]?.key;
}

function unknownKeys(value: unknown, schema: Schema, path: string[], found: DeclarationWarning[]) {
  if (!plain(value)) return;
  let def = unwrap(schema);
  if (def.type === 'record' && def.valueType) {
    for (const [key, child] of Object.entries(value)) unknownKeys(child, def.valueType, [...path, key], found);
    return;
  }
  // An unknown parameter type is already a schema error.
  if (def.type === 'union') def = member(def, value) ?? def;
  if (def.type !== 'object' || !def.shape) return;
  const known = Object.keys(def.shape);
  for (const [key, child] of Object.entries(value)) {
    if (Object.hasOwn(def.shape, key)) {
      unknownKeys(child, def.shape[key], [...path, key], found);
      continue;
    }
    const suggestion = closest(key, known);
    found.push({
      code: 'declaration-unknown-property', path: [...path, key].join('.'),
      message: (path.length ? path.join(' → ') : 'Template') + ': ImageFlow does not know property ' + key + ' and ignores it.',
      details: { property: key, ...(suggestion ? { didYouMean: suggestion } : {}) },
      suggestion: suggestion ? 'Rename ' + key + ' to ' + suggestion + '.'
        : 'Remove ' + key + ', or move it where ImageFlow reads it. Known here: ' + known.join(', ') + '.',
    });
  }
}

// Spreads typed with spreadFor(document) remember that document; it must match the template's own parameters, or
// ctx.document is typed with settings that do not exist at runtime.
const typedDocuments = new WeakMap<object, Parameters>();
export function rememberDocument(definition: unknown, document: Parameters) {
  if (plain(definition)) typedDocuments.set(definition, document);
}

function documentMismatches(declared: Record<string, unknown>, found: DeclarationWarning[]) {
  const own = plain(declared.parameters) ? declared.parameters : {};
  if (!plain(declared.spreads)) return;
  for (const [id, definition] of Object.entries(declared.spreads)) {
    const typed = plain(definition) ? typedDocuments.get(definition) : undefined;
    if (!typed || typed === own) continue;
    for (const [key, parameter] of Object.entries(typed)) {
      const missing = !Object.hasOwn(own, key);
      if (!missing && JSON.stringify(own[key]) === JSON.stringify(parameter)) continue;
      found.push({
        code: 'declaration-document-mismatch', path: 'spreads.' + id,
        message: 'spreads → ' + id + ': the layout is typed with document parameter ' + key + ' ' +
          (missing ? 'that the template does not declare; ctx.document.' + key + ' is undefined.' : 'declared differently from the template\'s parameters.'),
        details: { spread: id, parameter: key },
        suggestion: 'Pass the template\'s own parameters object to spreadFor(), or declare spreads as a function: spreads: ({ spread }) => ({ … }).',
      });
    }
  }
}

// `schema` is the template schema (src/template.tsx), passed in to keep this module free of an import cycle.
export function declarationWarnings(declared: unknown, schema: Schema): DeclarationWarning[] {
  const found: DeclarationWarning[] = [];
  unknownKeys(declared, schema, [], found);
  if (plain(declared)) documentMismatches(declared, found);
  // A misspelling repeated in many layouts is reported for each; cap the list like schema errors.
  return found.slice(0, 50);
}
