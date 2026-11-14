import type { Issue } from './desktop';
import { resolveValue } from './parameters';
import type { ListItem, Parameter, Parameters } from './parameters';
import type { RenderProject, Values } from './project';

// Assigned files that are gone, unreadable, or of a type the parameter does not accept. An unassigned file
// parameter is valid; the template renders without it.
// A list's file fields are checked per item, and each finding names the item (#115).
export function fileErrors(book: RenderProject, schema: Parameters, values: Values, scope: string): Issue[] {
  return Object.entries(schema).flatMap(([id, declared]): Issue[] => {
    if (declared.type === 'list') {
      const items = resolveValue(declared, values[id]) as ListItem[];
      return items.flatMap((item, index) => Object.entries(declared.item).flatMap(([key, field]) =>
        fileFinding(book, field, item[key], scope + ' · ' + declared.label + ' ' + (index + 1) + ' · ' + field.label + ': ', id,
          ' (item ' + item.id + ', field ' + key + ')')));
    }
    return fileFinding(book, declared, values[id], scope + ' · ' + declared.label + ': ', id, '');
  });
}
function fileFinding(book: RenderProject, param: Parameter, value: unknown, where: string, id: string, item: string): Issue[] {
  if (param.type !== 'file' || typeof value !== 'string' || !value) return [];
  const path = book.project.files[value];
  const found = book.files[value];
  const finding = (code: string, message: string, suggestion: string): Issue[] =>
    [{ message: where + message, code, parameter: id, source: value, suggestion }];
  if (!path || !found) {
    return finding('file-missing', 'the assigned file is no longer in the project. Choose it again.',
      'Import the file again with import_sources, then assign its new ID to parameter ' + id + item + '.');
  }
  if (found.problem) return finding('file-unreadable', found.problem, 'Replace the file or assign another file to parameter ' + id + item + '.');
  if (!param.accept.includes(found.extension)) {
    return finding('file-type', found.name + ' is not a ' + param.accept.join(' or ') + ' file. Choose another file.',
      'Assign a ' + param.accept.join(' or ') + ' file to parameter ' + id + item + '.');
  }
  return [];
}

