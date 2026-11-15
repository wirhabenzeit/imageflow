import type { BookGeometry } from './desktop';
import { isParameterValue } from './parameters';
import type { Parameter } from './parameters';
import { readEdit, resolveEditPath, writeEdit } from './editing';
import type { EditTarget } from './editing';
import type { Project } from './project';

// Text needs less screen area than a map, but still needs a usable caret and line: 64 px along the line and 18 px
// across it. Vertical text (a non-horizontal writing mode) runs its lines down the box, so the two sides swap.
export function textFits(target: BookGeometry['targets'][number]) {
  const [along, across] = target.vertical ? [target.height, target.width] : [target.width, target.height];
  return target.inlineText && target.upright !== false && along >= 64 && across >= 18;
}

/** A custom editor remains the sole editing surface for the parameters it owns, including layout fields. */
export function textEditorOwner(template: Parameters<typeof resolveEditPath>[0], layout: string, path: string):
  { kind: 'element'; element: string } | { kind: 'document'; editor: string } | undefined {
  const field = resolveEditPath(template, layout, path);
  if (!field) return;
  if (field.scope === 'document') {
    const found = Object.entries(template.editors ?? {}).find(([, editor]) => editor.parameters.includes(field.key));
    return found && { kind: 'document', editor: found[0] };
  }
  const elements = template.spreads[layout]?.elements ?? {};
  if (field.scope === 'element' && elements[field.owner!]?.editor?.parameters.includes(field.key)) {
    return { kind: 'element', element: field.owner! };
  }
  if (field.scope === 'spread') {
    const found = Object.entries(elements).find(([, element]) => element.editor?.spread?.includes(field.key));
    return found && { kind: 'element', element: found[0] };
  }
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
      readEdit(project, spread, current) !== before || textProblem(current.param, value) || textEditorOwner(template, layout, field.path)) return false;
  writeEdit(project, spreadId, current, value);
  return true;
}
