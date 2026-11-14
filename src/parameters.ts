import { z } from 'zod';
import { identifier } from './project';
import type { Values } from './project';

const label = z.string().trim().min(1);
const color = z.string().regex(/^#[0-9a-f]{6}$/i);
const date = z.iso.date();
const extension = z.string().regex(/^\.[a-z0-9]{1,10}$/, 'Use lowercase file extensions such as .gpx.');
const common = { label };
const numeric = { min: z.number().optional(), max: z.number().optional(), step: z.number().positive().optional(), unit: z.string().optional() };

const scalarParameterOptions = [
  z.object({ ...common, type: z.literal('boolean'), default: z.boolean() }),
  z.object({ ...common, type: z.literal('string'), default: z.string(), multiline: z.boolean().optional(), maxLength: z.int().nonnegative().optional(), placeholder: z.string().optional() }),
  z.object({ ...common, ...numeric, type: z.literal('integer'), default: z.int() }),
  z.object({ ...common, ...numeric, type: z.literal('number'), default: z.number() }),
  z.object({ ...common, type: z.literal('enum'), default: z.string(), options: z.array(z.string()).min(1), labels: z.record(z.string(), z.string()).optional() }),
  z.object({ ...common, type: z.literal('color'), default: color }),
  z.object({ ...common, type: z.literal('date'), default: date, min: date.optional(), max: date.optional(), precision: z.enum(['day', 'month']).optional() }),
  // A file the user adds to the project. The value is its ID in the project's `files` registry, or '' when none is
  // assigned, which is always allowed. `accept` lists the extensions offered when choosing a file.
  z.object({ ...common, type: z.literal('file'), default: z.literal(''), accept: z.array(extension).min(1) }),
] as const;
const validDefault = (param: Parameter) => isParameterValue(param, param.default);
const defaultMessage = 'Default must satisfy the parameter constraints.';
// The fields of a list item: scalar parameters, keyed like parameters. `id` is the item's own stable ID.
export const scalarParameterSchema = z.discriminatedUnion('type', scalarParameterOptions).refine(validDefault, defaultMessage);
const itemField = identifier.refine((key) => key !== 'id', 'id is the item\'s own ID; give the field another name.');
const scalarValue = z.union([z.string(), z.boolean(), z.number()]);
// A list of flat items (ADR 0008 baseline, #115). Each saved item is an object with a stable `id` and the values of
// its fields; a missing field takes its default.
const listOption = z.object({
  ...common, type: z.literal('list'),
  item: z.record(itemField, scalarParameterSchema).refine((fields) => Object.keys(fields).length > 0, 'A list item needs at least one field.'),
  min: z.int().nonnegative().optional(), max: z.int().positive().optional(),
  default: z.array(z.record(z.string(), scalarValue)),
}).refine(({ min, max }) => min === undefined || max === undefined || min <= max, 'A list\'s min cannot be more than its max.');
export const parameterSchema = z.discriminatedUnion('type', [...scalarParameterOptions, listOption]).refine(validDefault, defaultMessage);

export type ScalarParameter = z.infer<typeof scalarParameterSchema>;
export type ListParameter = z.infer<typeof listOption>;
export type Parameter = ScalarParameter | ListParameter;
export type Parameters = Record<string, Parameter>;
export const parametersSchema = z.record(identifier, parameterSchema).default({});
export type Scalar = string | number | boolean;
export type ListItem = { id: string; [field: string]: Scalar };
export type ParameterValue = Scalar | ListItem[];

const own = <T,>(record: Record<string, T>, key: string) => Object.hasOwn(record, key) ? record[key] : undefined;
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * What is wrong with a saved list value, one message per problem, naming the item (1-based) it is about. Empty when
 * the value is valid: an array within `min`/`max` of objects with unique valid IDs whose fields the list declares and
 * allows. Missing fields are allowed; they take their defaults.
 */
export function listProblems(param: ListParameter, value: unknown): string[] {
  if (!Array.isArray(value)) return ['is not a list of items'];
  const problems: string[] = [];
  if (value.length < (param.min ?? 0)) problems.push('has ' + value.length + ' items; it needs at least ' + param.min);
  if (param.max !== undefined && value.length > param.max) problems.push('has ' + value.length + ' items; it allows at most ' + param.max);
  const seen = new Set<string>();
  value.forEach((item: unknown, index) => {
    const name = 'item ' + (index + 1);
    if (!isRecord(item)) { problems.push(name + ' is not an object'); return; }
    if (typeof item.id !== 'string' || !identifier.safeParse(item.id).success) problems.push(name + ' has no valid id');
    else if (seen.has(item.id)) problems.push(name + ' repeats the id ' + item.id);
    else seen.add(item.id);
    for (const [key, field] of Object.entries(item)) {
      if (key === 'id') continue;
      const declared = own(param.item, key);
      if (!declared) problems.push(name + ' has a field ' + key + ' the list does not declare');
      else if (!isParameterValue(declared, field)) problems.push(name + ' · ' + declared.label + ' has a value the template does not allow');
    }
  });
  return problems;
}

export function isParameterValue(param: Parameter, value: unknown): boolean {
  if (param.type === 'list') return listProblems(param, value).length === 0;
  if (param.type === 'boolean') return typeof value === 'boolean';
  if (param.type === 'number' || param.type === 'integer') {
    return typeof value === 'number' && Number.isFinite(value)
      && (param.type !== 'integer' || Number.isInteger(value))
      && value >= (param.min ?? -Infinity) && value <= (param.max ?? Infinity);
  }
  if (typeof value !== 'string') return false;
  switch (param.type) {
    case 'string': return param.maxLength === undefined || value.length <= param.maxLength;
    case 'enum': return param.options.includes(value);
    case 'color': return color.safeParse(value).success;
    case 'date': return date.safeParse(value).success && (!param.min || value >= param.min) && (!param.max || value <= param.max);
    // Any ID is a valid value: a reference to a file that is gone is kept and reported, not replaced.
    case 'file': return value === '' || identifier.safeParse(value).success;
  }
}

function parameter<T extends ScalarParameter['type']>(type: T) {
  return <const Options extends Omit<Extract<ScalarParameter, { type: T }>, 'type'>>(options: Options) => ({ ...options, type });
}

type ListOptions = { label: string; item: Record<string, ScalarParameter>; min?: number; max?: number; default?: readonly Record<string, Scalar>[] };
// A list starts empty unless it has a default. Default items without an `id` get one from their position, skipping
// IDs other default items already have.
function listParameter<const Options extends ListOptions>(options: Options) {
  const items = options.default ?? [];
  const taken = new Set(items.map(({ id }) => id));
  const positional = (index: number) => {
    let id = 'item' + (index + 1);
    for (let n = 2; taken.has(id); n++) id = 'item' + (index + 1) + '-' + n;
    taken.add(id);
    return id;
  };
  const declared = { ...options, type: 'list' as const, default: items.map((item, index): ListItem => ({ ...item, id: typeof item.id === 'string' ? item.id : positional(index) })) };
  return declared as Omit<Options, 'default'> & { type: 'list'; default: ListItem[] };
}

type FileOptions = Omit<Extract<Parameter, { type: 'file' }>, 'type' | 'default'>;
type EnumParameter = Extract<ScalarParameter, { type: 'enum' }>;
type EnumKeys<C> = `${Extract<keyof C, string | number>}`;
function enumParameter<const Options extends Omit<EnumParameter, 'type'>>(options: Options): Options & { type: 'enum' };
function enumParameter<const Choices extends Record<string, string>>(options: { label: string; options: Choices; default: NoInfer<EnumKeys<Choices>> }):
  { type: 'enum'; label: string; options: EnumKeys<Choices>[]; labels: Choices; default: EnumKeys<Choices> };
function enumParameter(options: { label: string; options: string[] | Record<string, string>; default: string; labels?: Record<string, string> }) {
  return Array.isArray(options.options) ? { ...options, type: 'enum' as const }
    : { label: options.label, type: 'enum' as const, default: options.default, options: Object.keys(options.options), labels: { ...options.options } };
}
export const p = {
  boolean: parameter('boolean'), string: parameter('string'), integer: parameter('integer'),
  number: parameter('number'), enum: enumParameter, color: parameter('color'), date: parameter('date'),
  // A file parameter starts unassigned.
  file: <const Options extends FileOptions>(options: Options) => ({ ...options, type: 'file' as const, default: '' as const }),
  list: listParameter,
};

// A list's items as `render` reads them: every declared field, the saved value where it is allowed and the field's
// default otherwise. Items that are not objects or lack a unique valid ID are left out, and fields the list does not
// declare are dropped. If what is left breaks `min`/`max`, or the value is not a list, the list's default is used.
// Nothing is written back: the saved value is kept and reported (parameterWarnings).
function resolveList(param: ListParameter, value: unknown): ListItem[] {
  const items = (source: unknown[]) => {
    const seen = new Set<string>();
    return source.flatMap((item): ListItem[] => {
      if (!isRecord(item) || typeof item.id !== 'string' || !identifier.safeParse(item.id).success || seen.has(item.id)) return [];
      seen.add(item.id);
      return [{ id: item.id, ...Object.fromEntries(Object.entries(param.item).map(([key, field]) =>
        [key, isParameterValue(field, item[key]) ? item[key] as Scalar : field.default])) }];
    });
  };
  const resolved = Array.isArray(value) ? items(value) : undefined;
  if (resolved && resolved.length >= (param.min ?? 0) && resolved.length <= (param.max ?? Infinity)) return resolved;
  return items(param.default);
}

/** A parameter's value as `render` reads it: the saved one where it is allowed, else the default. */
export function resolveValue(param: Parameter, value: unknown): ParameterValue {
  if (param.type === 'list') return resolveList(param, value);
  return isParameterValue(param, value) ? value as Scalar : param.default;
}

export function resolveParams(schema: Parameters, values: Values): Values {
  return Object.fromEntries(Object.entries(schema).map(([id, param]) => [id, resolveValue(param, own(values, id))]));
}

/** Whether two parameter values are the same, comparing lists by content. */
export function sameValue(a: unknown, b: unknown) {
  return a === b || (Array.isArray(a) && Array.isArray(b) && JSON.stringify(a) === JSON.stringify(b));
}

/** A new item ID, unique among `items`. */
export function newItemId(items: readonly { id?: unknown }[] = []) {
  const taken = new Set(items.map(({ id }) => id));
  let id: string;
  do id = 'i' + crypto.randomUUID().replace(/-/g, '').slice(0, 10); while (taken.has(id));
  return id;
}

export function parameterWarnings(schema: Parameters, values: Values, scope: string) {
  return Object.entries(values).flatMap(([id, value]) => {
    const param = own(schema, id);
    if (!param) return [scope + ' · ' + id + ' is saved but no longer declared by the template.'];
    if (param.type === 'list') {
      // Each problem names its item, so one bad track does not hide which one it is. Items that can still be read
      // are drawn; the saved list is kept as it is.
      return listProblems(param, value).map((problem) => scope + ' · ' + param.label + ' ' + problem +
        (/^item \d+ · /.test(problem) ? '; its default is used.' : /^item \d+ has a field /.test(problem) ? '; that field is ignored.'
          : /^item /.test(problem) ? '; the item is left out.' : '; the default is used.'));
    }
    return isParameterValue(param, value) ? [] : [scope + ' · ' + param.label + ' has a saved value the template does not allow here; the default is used.'];
  });
}
