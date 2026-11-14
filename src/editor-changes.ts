import { isParameterValue, listProblems } from './parameters';
import type { Parameter, Parameters } from './parameters';
import type { Values } from './project';

/** A change a custom editor asked for that was not applied, with a message naming what it can do instead. */
export type RejectedChange = { key: string; message: string };

const show = (value: unknown) => {
  if (typeof value !== 'object' || value === null) return typeof value === 'string' ? JSON.stringify(value) : String(value);
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 200 ? text.slice(0, 199) + '…' : text;
};
const list = (keys: readonly string[]) => keys.length ? keys.join(', ') : 'no parameters';

// What a valid value looks like, for the message about an invalid one.
function expected(param: Parameter) {
  switch (param.type) {
    case 'boolean': return 'true or false';
    case 'integer':
    case 'number': {
      const kind = param.type === 'integer' ? 'a whole number' : 'a number';
      if (param.min !== undefined && param.max !== undefined) return kind + ' from ' + param.min + ' to ' + param.max;
      if (param.min !== undefined) return kind + ' of at least ' + param.min;
      if (param.max !== undefined) return kind + ' of at most ' + param.max;
      return kind;
    }
    case 'string': return param.maxLength === undefined ? 'a string' : 'a string of at most ' + param.maxLength + ' characters';
    case 'enum': return 'one of ' + param.options.map(show).join(', ');
    case 'color': return 'a colour such as "#243b30"';
    case 'date': return 'an ISO date such as "2027-03-01"' + (param.min ? ', from ' + param.min : '') + (param.max ? ', until ' + param.max : '');
    case 'file': return 'a file ID, or "" for none';
    case 'list': return 'an array of items, each an object with a unique id and the fields ' + Object.keys(param.item).join(', ') +
      (param.min !== undefined || param.max !== undefined ? ', ' + (param.min ?? 0) + (param.max !== undefined ? ' to ' + param.max : ' or more') + ' items' : '');
  }
}

/**
 * Splits the changes a custom editor passes to `set()` into those it may make, the editor's own parameters with
 * valid values, and those that are ignored, each with a message saying why. Untyped template code can pass
 * anything, so `changes` is not trusted to be an object.
 */
export function editorChanges(parameters: Parameters, owned: readonly string[], changes: unknown, scope: 'element' | 'spread' = 'element',
  editor: 'element' | 'document' = 'element'): { allowed: Values; rejected: RejectedChange[] } {
  // What `set()` writes to: an element's parameters, or a document editor's document parameters.
  const kind = scope === 'spread' ? 'layout' : editor;
  const elsewhere = scope === 'spread' ? ' in the spread scope' : editor === 'document' ? ', so it is edited in template controls' : ', so it is edited by the generated controls';
  const setter = scope === 'spread' ? 'setSpread' : 'set';
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
    return { allowed: {}, rejected: [{ key: '', message: setter + '() expects an object of parameter values, such as ' + setter + '({ ' + (owned[0] ?? 'parameter') + ': … }).' }] };
  }
  const allowed: Values = {};
  const rejected: RejectedChange[] = [];
  for (const [key, value] of Object.entries(changes)) {
    const param = Object.hasOwn(parameters, key) ? parameters[key] : undefined;
    if (!owned.includes(key)) {
      rejected.push({ key, message: setter + '() ignored ' + key + ': ' + (param
        ? 'it is not one of this editor\'s parameters' + elsewhere + '. This editor edits ' + list(owned) + '.'
        : 'the ' + kind + ' has no such parameter. This editor edits ' + list(owned) + '.') });
    } else if (!param || !isParameterValue(param, value)) {
      // For a list, the first problem says which item is wrong.
      const problem = param?.type === 'list' ? ' (it ' + listProblems(param, value)[0] + ')' : '';
      rejected.push({ key, message: setter + '() ignored ' + key + ': ' + show(value) + ' is not a valid value' + problem +
        (param ? '; ' + param.label + ' takes ' + expected(param) : '') + '.' });
    } else allowed[key] = value as Values[string];
  }
  return { allowed, rejected };
}

/** The message for `<Control parameter>` naming a parameter the editor does not own. */
export function unknownControl(parameter: unknown, owned: readonly string[], scope: 'element' | 'spread' = 'element') {
  return 'Control ' + show(parameter) + (scope === 'spread' ? ' (scope spread)' : '') + ' is not one of the parameters this editor edits. Use one of: ' + list(owned) + '.';
}
