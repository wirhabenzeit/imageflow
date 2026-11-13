import type { TemplateInfo } from './desktop';
import { resolveParams } from './parameters';
import type { SpreadState, Values } from './project';

// What an open custom editor works on, and the rules that keep its saves safe while the book changes around it.
//
// An editor is opened from one spread: an element's editor for that element, or a document editor for document
// parameters, from a node marked with them. Two kinds of change reach it while it is open:
// - Its context (page numbers, anchors, photos, other parameters) follows the book. The frame recomputes it from
//   each newer render; nothing here treats that as a conflict.
// - Its own values (the parameters it edits, their declarations, the template's choice of owner) changing from
//   elsewhere make its draft stale: the panel says so and saves nothing until it is reopened.
// The spread it was opened from being deleted (or, for a document editor, switching layout, which removes the node
// it was opened from) closes it.

export type EditorTarget =
  | { kind: 'element'; spread: string; element: string }
  | { kind: 'document'; spread: string; layout: string; editor: string };

// The saved values an editor reads: its spread, and the document's parameters.
export type EditorState = { spread: SpreadState; params: Values };

// The draft an editor reports: its own parameters (the element's, or the document's for a document editor), and
// for an element editor the layout parameters it lists.
export type EditorDraft = { values: Values; spread: Values };

export function editorState(project: { spreads: readonly SpreadState[]; params: Values }, spread: string): EditorState | undefined {
  const state = project.spreads.find(({ id }) => id === spread);
  return state && { spread: state, params: project.params };
}

/**
 * The document editor that a node marked with these paths opens: the one that owns every document parameter named,
 * when all paths are document parameters it owns. A node that also shows other parameters keeps the popover.
 */
export function documentEditorFor(template: Pick<TemplateInfo, 'editors'>, edits: readonly string[]): string | undefined {
  if (!edits.length || !edits.every((path) => path.startsWith('document.'))) return undefined;
  const keys = edits.map((path) => path.slice('document.'.length));
  return Object.entries(template.editors ?? {}).find(([, { parameters }]) => keys.every((key) => parameters.includes(key)))?.[0];
}

/** Document parameters some document editor owns: they get no control in template controls. */
export const editorOwnedDocument = (template: Pick<TemplateInfo, 'editors'>) =>
  Object.values(template.editors ?? {}).flatMap(({ parameters }) => parameters);

/**
 * The values an editor's draft is based on, as a comparable string: every parameter of the element (with its
 * declaration and resolved value) and the layout parameters the editor lists, or for a document editor the
 * document parameters it owns. Comparing it tells whether a draft was based on values that have since changed,
 * through project data or through the template (a new default, a changed declaration). Page numbers, photos and
 * other parameters are context, not part of it.
 */
export function editingContext(template: TemplateInfo, state: EditorState, target: EditorTarget) {
  if (target.kind === 'document') {
    const editor = template.editors?.[target.editor];
    const owned = (editor?.parameters ?? []).filter((key) => Object.hasOwn(template.parameters, key));
    const resolved = resolveParams(template.parameters, state.params);
    return JSON.stringify(['document', target.editor, editor?.parameters ?? [], owned.map((key) => [key, template.parameters[key], resolved[key]])]);
  }
  const { spread } = state;
  const layout = template.spreads[spread.definition];
  const definition = layout?.elements[target.element];
  const parameters = definition?.parameters ?? {};
  const resolved = resolveParams(parameters, spread.elements[target.element]?.params ?? {});
  const layoutParameters = layout?.parameters ?? {};
  const owned = (definition?.editor?.spread ?? []).filter((key) => Object.hasOwn(layoutParameters, key));
  const resolvedSpread = resolveParams(layoutParameters, spread.params);
  return JSON.stringify([spread.definition, definition?.editor?.parameters ?? [], definition?.editor?.spread ?? [], definition?.controls ?? null,
    Object.keys(parameters).map((key) => [key, parameters[key], resolved[key]]),
    owned.map((key) => [key, layoutParameters[key], resolvedSpread[key]])]);
}

/** Whether what the editor was opened from is gone, so the editor closes instead of reporting a conflict. */
export function editorTargetGone(spreads: readonly SpreadState[], target: EditorTarget) {
  const spread = spreads.find(({ id }) => id === target.spread);
  return !spread || (target.kind === 'document' && spread.definition !== target.layout);
}

/** The changes of a draft that differ from the saved state, or undefined when there are none. */
export function changedValues(template: TemplateInfo, state: EditorState, target: EditorTarget, draft: EditorDraft): EditorDraft | undefined {
  const differ = (saved: Values, values: Values) => Object.fromEntries(Object.entries(values).filter(([key, value]) => saved[key] !== value));
  if (target.kind === 'document') {
    const values = differ(resolveParams(template.parameters, state.params), draft.values);
    return Object.keys(values).length ? { values, spread: {} } : undefined;
  }
  const layout = template.spreads[state.spread.definition];
  const definition = layout?.elements[target.element];
  const values = differ(resolveParams(definition?.parameters ?? {}, state.spread.elements[target.element]?.params ?? {}), draft.values);
  const spread = differ(resolveParams(layout?.parameters ?? {}, state.spread.params), draft.spread);
  return Object.keys(values).length || Object.keys(spread).length ? { values, spread } : undefined;
}

/** Writes changes into a project state (or a copy the editor keeps as its expected state). */
export function applyEditorChanges(state: EditorState, target: EditorTarget, changes: EditorDraft) {
  if (target.kind === 'document') {
    Object.assign(state.params, changes.values);
    return;
  }
  if (Object.keys(changes.values).length) {
    state.spread.elements[target.element] ??= { params: {} };
    Object.assign(state.spread.elements[target.element].params, changes.values);
  }
  Object.assign(state.spread.params, changes.spread);
}

/**
 * Applies an editor's queued save to the project as it is when the save runs. `before` is the editing context the
 * save was based on; if the project's differs (an Undo, a reload, another editor or an agent changed the editor's
 * values in the meantime), or the target is gone, nothing is written and the save reports false, so an old draft
 * never overwrites newer values.
 */
export function queuedEditorSave(template: TemplateInfo, project: { spreads: SpreadState[]; params: Values }, target: EditorTarget,
  before: string, changes: EditorDraft) {
  const state = editorState(project, target.spread);
  if (!state || editorTargetGone(project.spreads, target) || editingContext(template, state, target) !== before) return false;
  applyEditorChanges(state, target, changes);
  return true;
}
