import type { Parameter } from './parameters';
// Inline controls fit a toolbar. Everything else keeps its full labelled control in the overflow panel.
export function compactParameter(param: Parameter) {
  return param.type === 'boolean' || param.type === 'integer' || param.type === 'number' || (param.type === 'enum' && param.options.length <= 4);
}
