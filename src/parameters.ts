import { z } from 'zod';
import { identifier } from './project';
import type { Values } from './project';

const label = z.string().trim().min(1);
const color = z.string().regex(/^#[0-9a-f]{6}$/i);
const date = z.iso.date();
const extension = z.string().regex(/^\.[a-z0-9]{1,10}$/, 'Use lowercase file extensions such as .gpx.');
const common = { label };
const numeric = { min: z.number().optional(), max: z.number().optional(), step: z.number().positive().optional(), unit: z.string().optional() };

export const parameterSchema = z.discriminatedUnion('type', [
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
]).refine((param) => isParameterValue(param, param.default), 'Default must satisfy the parameter constraints.');

export type Parameter = z.infer<typeof parameterSchema>;
export type Parameters = Record<string, Parameter>;
export const parametersSchema = z.record(identifier, parameterSchema).default({});

export function isParameterValue(param: Parameter, value: unknown) {
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

function parameter<T extends Parameter['type']>(type: T) {
  return <const Options extends Omit<Extract<Parameter, { type: T }>, 'type'>>(options: Options) => ({ ...options, type });
}

type FileOptions = Omit<Extract<Parameter, { type: 'file' }>, 'type' | 'default'>;
type EnumParameter = Extract<Parameter, { type: 'enum' }>;
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
};

export function resolveParams(schema: Parameters, values: Values) {
  return Object.fromEntries(Object.entries(schema).map(([id, param]) => [
    id, isParameterValue(param, values[id]) ? values[id] : param.default,
  ]));
}

export function parameterWarnings(schema: Parameters, values: Values, scope: string) {
  return Object.entries(values).flatMap(([id, value]) => {
    const param = schema[id];
    if (!param) return [scope + ' · ' + id + ' is saved but no longer declared by the template.'];
    return isParameterValue(param, value) ? [] : [scope + ' · ' + param.label + ' has a saved value the template does not allow here; the default is used.'];
  });
}
