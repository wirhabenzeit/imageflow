import { controlCycles, controlsSchema } from './controls';
import type { Parameters } from './parameters';

// Findings about a template declaration that the schema accepts but that are probably mistakes. They are warnings,
// not errors, so a contract-1 template that loaded before keeps loading. The authoring types reject the same
// mistakes at compile time; this covers untyped templates and spreads typed separately with spreadFor().
export type DeclarationWarning = {
  code: 'declaration-unknown-property' | 'declaration-document-mismatch' | 'declaration-control-cycle' | 'declaration-span-unused';
  message: string; path: string; details: Record<string, string>; suggestion: string;
};

// Known keys come from the schema that validates the declaration, so they cannot drift from it. The walk follows
// objects, records, discriminated unions (parameters by `type`) and optional or default wrappers.
type Def = {
  type: string; shape?: Record<string, Schema>; valueType?: Schema; innerType?: Schema; in?: Schema; out?: Schema;
  options?: Schema[]; discriminator?: string; values?: unknown[];
};
export type Schema = { _zod: { def: Def } };
// A schema that picks its shape from the value it validates, such as a print format by `facingPages`, names the
// schema to walk for a value here.
const chosenShapes = new WeakMap<object, (value: unknown) => Schema>();
export function walkShape<T extends object>(schema: T, choose: (value: unknown) => Schema) {
  chosenShapes.set(schema, choose);
  return schema;
}
function unwrap(schema: Schema, value?: unknown): Def {
  const chosen = chosenShapes.get(schema);
  if (chosen) return unwrap(chosen(value), value);
  const def = schema._zod.def;
  if (def.innerType) return unwrap(def.innerType, value);
  // A preprocessed schema (a transform piped into the schema) is walked as the schema it feeds.
  if (def.type === 'pipe' && def.in) return unwrap(def.in._zod.def.type === 'transform' && def.out ? def.out : def.in, value);
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
  let def = unwrap(schema, value);
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
  if (plain(declared)) controlCycleWarnings(declared, found);
  if (plain(declared)) spanWarnings(declared, found);
  // A misspelling repeated in many layouts is reported for each; cap the list like schema errors.
  return found.slice(0, 50);
}

// Layouts no declared format can use: single-page layouts (`span: 'page'`) need a format without facing pages, the
// others one with them. `span` defaults to 'page' when no format has facing pages, so that case only arises when a
// layout states its span.
function spanWarnings(declared: Record<string, unknown>, found: DeclarationWarning[]) {
  if (!plain(declared.spreads)) return;
  const formats = plain(declared.formats) ? Object.values(declared.formats) : [declared.format];
  const facing = formats.map((format) => !plain(format) || !plain(format.structure) || format.structure.facingPages !== false);
  const anyFacing = facing.includes(true), anySingle = facing.includes(false);
  for (const [id, definition] of Object.entries(declared.spreads)) {
    if (!plain(definition)) continue;
    const span = definition.span ?? (anyFacing ? 'spread' : 'page');
    if (span === 'page' ? anySingle : anyFacing) continue;
    found.push({
      code: 'declaration-span-unused', path: 'spreads.' + id + '.span',
      message: 'spreads → ' + id + ': ' + (span === 'page'
        ? "the layout is a single page (span: 'page'), but every format of the template has facing pages. No book can use it."
        : 'the layout is for facing pages (span: ' + JSON.stringify(span) + '), but no format of the template has facing pages. No book can use it.'),
      details: { spread: id, span: String(span) },
      suggestion: span === 'page' ? 'Add a format with facingPages: false, or give the layout a facing span.'
        : "Set span: 'page' on the layout, or add a format with facing pages.",
    });
  }
}

// Conditional controls that can hide each other for good (controlCycles), at spread, box and element scope. This runs
// on the declaration as exported, before schema validation, so a controls list the schema rejects is skipped here
// and reported by the schema instead. `details.edit` is the scope's edit-path prefix (empty for the layout's own
// parameters), so the Book check can drop the warning for a layout that marks one of them on the page (render.tsx).
function controlCycleWarnings(declared: Record<string, unknown>, found: DeclarationWarning[]) {
  if (!plain(declared.spreads)) return;
  const check = (scope: unknown, path: string[], layout: string, edit: string) => {
    if (!plain(scope) || scope.controls === undefined) return;
    const controls = controlsSchema.safeParse(scope.controls);
    if (!controls.success) return;
    for (const cycle of controlCycles(controls.data)) {
      const names = cycle.join(', ');
      const where = path.join(' → ') + ': ';
      found.push({
        code: 'declaration-control-cycle', path: [...path, 'controls'].join('.'),
        message: where + (cycle.length === 1
          ? 'control ' + names + ' is in a group that is shown only depending on ' + names + '. Once hidden, the generated controls cannot show it again.'
          : 'controls ' + names + ' are each shown only depending on another of them. Once all are hidden, the generated controls cannot show them again.'),
        details: { controls: names, layout, edit },
        suggestion: (cycle.length === 1 ? 'Move ' + names + ' out of the group' : 'Make one of ' + names + ' unconditional') +
          (edit ? '.' : ', or mark ' + (cycle.length === 1 ? 'it' : 'one') + ' as editable on the page with ctx.edit or ctx.Text.'),
      });
    }
  };
  for (const [id, definition] of Object.entries(declared.spreads)) {
    if (!plain(definition)) continue;
    check(definition, ['spreads', id], id, '');
    for (const group of ['boxes', 'elements'] as const) {
      const scopes = definition[group];
      if (plain(scopes)) for (const [key, scope] of Object.entries(scopes)) check(scope, ['spreads', id, group, key], id, group + '.' + key + '.');
    }
  }
}

// Where control-cycle warnings apply in a rendered book. A layout (spread) parameter is reachable on a spread that
// marks it on the page (ctx.edit, ctx.Text), since a marked node's popover always shows layout parameters; whether a
// spread marks it can depend on its own values, so this is decided per spread, not per layout. A cycle among layout
// parameters is therefore reported once for each spread using the layout that marks none of them, located on that
// spread, and not at all when every such spread marks one. Box and element parameters follow the same `controls` and
// conditions in a marked node's popover, so marking them opens no way back: those warnings, and warnings about
// layouts no spread uses, stay as they are.
export type RenderedSpread = { spread: string; layout: string; marked: ReadonlySet<string> };
export function placeControlWarnings(warnings: DeclarationWarning[], rendered: RenderedSpread[]): (DeclarationWarning & { spread?: string })[] {
  return warnings.flatMap((warning) => {
    const { code, details } = warning;
    if (code !== 'declaration-control-cycle' || details.edit !== '') return [warning];
    const instances = rendered.filter(({ layout }) => layout === details.layout);
    if (!instances.length) return [warning];
    const keys = details.controls.split(', ');
    return instances.filter(({ marked }) => !keys.some((key) => marked.has(key))).map(({ spread }) => ({ ...warning, spread }));
  });
}
