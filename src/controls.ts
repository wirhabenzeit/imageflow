import { z } from 'zod';
import { isParameterValue } from './parameters';
import type { Parameter, Parameters } from './parameters';
import { identifier } from './project';
import type { Values } from './project';

// How a scope's parameters are presented for editing. This is editing UI only: it never changes what is declared or
// saved. A parameter left out of `controls` keeps its value, its validation and its project commands; it just gets
// no generated control. A condition hides a control while it does not apply, and keeps its saved value too.

type Scalar = string | number | boolean;
export type Condition = Record<string, Scalar | Scalar[]>;
export type ControlItem =
  | string
  | { parameter: string; label?: string; description?: string; when?: Condition }
  | { group: string; description?: string; controls: ControlItem[]; when?: Condition };

const scalar = z.union([z.string(), z.number(), z.boolean()]);
const condition = z.record(identifier, z.union([scalar, z.array(scalar).min(1)]));
const text = z.string().trim().min(1).max(200);
const controlItem: z.ZodType<ControlItem> = z.lazy(() => z.union([
  identifier,
  z.strictObject({ parameter: identifier, label: text.optional(), description: z.string().max(1000).optional(), when: condition.optional() }),
  z.strictObject({ group: text, description: z.string().max(1000).optional(), controls: z.array(controlItem).min(1), when: condition.optional() }),
]));
export const controlsSchema = z.array(controlItem).min(1).optional();

const keyOf = (item: Exclude<ControlItem, { group: string }>) => typeof item === 'string' ? item : item.parameter;

// What is wrong with a controls list for these parameters. `owned` are parameters a custom editor edits, which
// have no generated control.
export function controlProblems(parameters: Parameters, controls: ControlItem[] | undefined, owned: readonly string[] = []) {
  const problems: string[] = [];
  const listed = new Set<string>();
  const checkCondition = (when: Condition | undefined, subject: string, own?: string) => {
    for (const [key, expected] of Object.entries(when ?? {})) {
      const param = Object.hasOwn(parameters, key) ? parameters[key] : undefined;
      if (!param) problems.push(subject + ' depends on ' + key + ', which this scope does not declare.');
      else if (key === own) problems.push(subject + ' depends on its own value, so it could never be shown again once hidden.');
      else {
        const bad = (Array.isArray(expected) ? expected : [expected]).filter((value) => !isParameterValue(param, value));
        if (bad.length) problems.push(subject + ' depends on ' + key + ' being ' + bad.map((value) => JSON.stringify(value)).join(' or ') + ', which it can never be.');
      }
    }
  };
  const walk = (items: ControlItem[]) => {
    for (const item of items) {
      if (typeof item === 'object' && 'group' in item) {
        checkCondition(item.when, 'Group ' + item.group);
        walk(item.controls);
        continue;
      }
      const key = keyOf(item);
      if (!Object.hasOwn(parameters, key)) problems.push('Control ' + key + ' names a parameter this scope does not declare.');
      else if (owned.includes(key)) problems.push('Control ' + key + ' is edited by the custom editor, so it has no generated control.');
      else if (listed.has(key)) problems.push('Control ' + key + ' is listed twice.');
      listed.add(key);
      if (typeof item === 'object') checkCondition(item.when, 'Control ' + key, key);
    }
  };
  if (controls) walk(controls);
  return problems;
}

export function matches(when: Condition | undefined, values: Values) {
  return Object.entries(when ?? {}).every(([key, expected]) =>
    (Array.isArray(expected) ? expected : [expected]).some((value) => value === values[key]));
}

export type ControlNode =
  | { kind: 'field'; key: string; param: Parameter; label: string; description?: string }
  | { kind: 'group'; label: string; description?: string; children: ControlNode[] };

// The controls to show now, in order: the declared `controls` with conditions applied to the resolved values, or
// one control per parameter in declaration order. Parameters in `exclude` (owned by a custom editor, or shown
// elsewhere) never appear. Groups with nothing to show are left out.
export function controlLayout(parameters: Parameters, controls: ControlItem[] | undefined, values: Values, exclude: readonly string[] = []): ControlNode[] {
  const field = (key: string, label?: string, description?: string): ControlNode[] => {
    const param = Object.hasOwn(parameters, key) && !exclude.includes(key) ? parameters[key] : undefined;
    return param ? [{ kind: 'field', key, param, label: label ?? param.label, ...(description ? { description } : {}) }] : [];
  };
  const walk = (items: ControlItem[]): ControlNode[] => items.flatMap((item): ControlNode[] => {
    if (typeof item === 'string') return field(item);
    if (!matches(item.when, values)) return [];
    if ('group' in item) {
      const children = walk(item.controls);
      return children.length ? [{ kind: 'group', label: item.group, ...(item.description ? { description: item.description } : {}), children }] : [];
    }
    return field(item.parameter, item.label, item.description);
  });
  return controls ? walk(controls) : Object.keys(parameters).flatMap((key) => field(key));
}

// The fields of a layout, flattened, for callers that only need to know what is editable.
export const layoutFields = (nodes: ControlNode[]): Extract<ControlNode, { kind: 'field' }>[] =>
  nodes.flatMap((node) => node.kind === 'field' ? [node] : layoutFields(node.children));
