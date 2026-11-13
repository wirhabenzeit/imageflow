import type { BookGeometry } from './desktop';
import { isParameterValue } from './parameters';
import type { Parameter } from './parameters';
import { readEdit, resolveEditPath, writeEdit } from './editing';
import type { EditTarget } from './editing';
import type { Project } from './project';

// Text needs less screen area than a map, but still needs a usable caret and line.
export function textFits(target: BookGeometry['targets'][number]) {
  return target.inlineText && target.upright !== false && target.width >= 64 && target.height >= 18;
}

export function plainText(value: string, multiline: boolean) {
  const normalized = value.replace(/\r\n?/g, '\n');
  return multiline ? normalized : normalized.replace(/\n/g, ' ');
}

export function textProblem(param: Parameter, value: string) {
  if (param.type !== 'string') return 'This field is not a string parameter.';
  return isParameterValue(param, value) ? '' : 'Use at most ' + param.maxLength + ' characters. Your typing is kept.';
}

// Recheck identity, declaration and value when the shared save queue runs, not just when Apply was clicked.
// An unrelated change can coexist; a changed field or layout must never be overwritten by stale typing.
export function saveInlineText(project: Project, template: Parameters<typeof resolveEditPath>[0], spreadId: string,
  layout: string, field: EditTarget, before: string, value: string) {
  const spread = project.spreads.find(({ id }) => id === spreadId);
  const current = resolveEditPath(template, layout, field.path);
  if (!spread || spread.definition !== layout || !current || JSON.stringify(current) !== JSON.stringify(field) ||
      readEdit(project, spread, current) !== before || textProblem(current.param, value)) return false;
  writeEdit(project, spreadId, current, value);
  return true;
}
