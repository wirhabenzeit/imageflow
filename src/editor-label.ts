/**
 * The name an agent is told for a focused field, menu or text that has no label of its own (`activeEditor`, 27 Nov):
 * what it is and where, rather than "focused editor control" alone.
 */
export function unlabeledControl(kind: 'field' | 'menu' | 'text', placeholder?: string, where?: string) {
  return (placeholder ? '"' + placeholder + '" ' + kind : 'a ' + kind) + (where ? ' in ' + where : '') + ' (focused)';
}
