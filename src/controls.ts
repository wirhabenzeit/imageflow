import { z } from 'zod';
import { isParameterValue, maxParameterDescription } from './parameters';
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
  z.strictObject({ parameter: identifier, label: text.optional(), description: z.string().trim().min(1).max(maxParameterDescription).optional(), when: condition.optional() }),
  z.strictObject({ group: text, description: z.string().trim().min(1).max(maxParameterDescription).optional(), controls: z.array(controlItem).min(1), when: condition.optional() }),
]));
// An empty list is allowed: it shows no generated controls while keeping every declaration. A group needs controls.
export const controlsSchema = z.array(controlItem).optional();

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

// Controls whose conditions depend on each other, such as A shown only when B is on and B only when A is on, or a
// control inside a group that is shown only depending on that control. Once all of them are hidden, the generated
// controls cannot show them again. That is not always a mistake: a marked edit target (`ctx.edit`, `ctx.Text`) or an
// agent can still set the values, so these are warnings, not problems. A control whose own `when` names itself has
// no other reading and stays a problem (controlProblems).
export function controlCycles(controls: ControlItem[] | undefined): string[][] {
  const depends = new Map<string, Set<string>>();
  // Controls an enclosing group hides depending on the control itself.
  const hidden = new Set<string>();
  const walk = (items: ControlItem[], inherited: Condition[]) => {
    for (const item of items) {
      if (typeof item === 'object' && 'group' in item) {
        walk(item.controls, item.when ? [...inherited, item.when] : inherited);
        continue;
      }
      const key = keyOf(item);
      const conditions = typeof item === 'object' && item.when ? [...inherited, item.when] : inherited;
      const keys = depends.get(key) ?? new Set<string>();
      for (const when of conditions) for (const other of Object.keys(when)) if (other !== key) keys.add(other);
      if (inherited.some((when) => Object.hasOwn(when, key))) hidden.add(key);
      depends.set(key, keys);
    }
  };
  if (controls) walk(controls, []);
  // Strongly connected components of two or more controls (Tarjan), in declaration order.
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  const visit = (key: string) => {
    index.set(key, index.size);
    low.set(key, index.get(key)!);
    stack.push(key);
    for (const next of depends.get(key) ?? []) {
      if (!depends.has(next)) continue;
      if (!index.has(next)) {
        visit(next);
        low.set(key, Math.min(low.get(key)!, low.get(next)!));
      } else if (stack.includes(next)) low.set(key, Math.min(low.get(key)!, index.get(next)!));
    }
    if (low.get(key) !== index.get(key)) return;
    const component: string[] = [];
    let member: string;
    do { member = stack.pop()!; component.unshift(member); } while (member !== key);
    if (component.length > 1 || hidden.has(key)) cycles.push(component);
  };
  for (const key of depends.keys()) if (!index.has(key)) visit(key);
  const order = [...depends.keys()];
  return cycles.map((cycle) => cycle.sort((a, b) => order.indexOf(a) - order.indexOf(b)))
    .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
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
