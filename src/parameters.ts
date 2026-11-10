import { z } from 'zod';
import { identifier } from './project';
import type { Values } from './project';

const label = z.string().trim().min(1);
const color = z.string().regex(/^#[0-9a-f]{6}$/i);
const date = z.iso.date();
const common = { label };
const numeric = { min: z.number().optional(), max: z.number().optional(), step: z.number().positive().optional(), unit: z.string().optional() };

export const parameterSchema = z.discriminatedUnion('type', [
  z.object({ ...common, type: z.literal('boolean'), default: z.boolean() }),
  z.object({ ...common, type: z.literal('string'), default: z.string(), multiline: z.boolean().optional(), maxLength: z.int().nonnegative().optional(), placeholder: z.string().optional() }),
  z.object({ ...common, ...numeric, type: z.literal('integer'), default: z.int() }),
  z.object({ ...common, ...numeric, type: z.literal('number'), default: z.number() }),
  z.object({ ...common, type: z.literal('enum'), default: z.string(), options: z.array(z.string()).min(1), labels: z.record(z.string(), z.string()).optional() }),
  z.object({ ...common, type: z.literal('color'), default: color }),
  z.object({ ...common, type: z.literal('date'), default: date, min: date.optional(), max: date.optional() }),
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
  }
}

function parameter<T extends Parameter['type']>(type: T) {
  return <const Options extends Omit<Extract<Parameter, { type: T }>, 'type'>>(options: Options) => ({ ...options, type });
}

export const p = {
  boolean: parameter('boolean'), string: parameter('string'), integer: parameter('integer'),
  number: parameter('number'), enum: parameter('enum'), color: parameter('color'), date: parameter('date'),
};

export function resolveParams(schema: Parameters, values: Values) {
  return Object.fromEntries(Object.entries(schema).map(([id, param]) => [
    id, isParameterValue(param, values[id]) ? values[id] : param.default,
  ]));
}

export function parameterWarnings(schema: Parameters, values: Values, scope: string) {
  return Object.entries(values).flatMap(([id, value]) => {
    const param = schema[id];
    return !param || !isParameterValue(param, value) ? [scope + ' · ' + id + ' has a saved value outside the current schema.'] : [];
  });
}
