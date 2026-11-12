import { useEffect, useRef, useState } from 'react';
import type { ImportMode } from './source-locations';
import { renderOrigin } from './desktop';
import type { TemplateInfo } from './desktop';
import type { Edit } from './Inspector';
import { isParameterValue, resolveParams } from './parameters';
import type { SpreadState, Values } from './project';
import { controlLayout } from './controls';
import { ControlList, Field } from './Fields';
import { useEditorFrame } from './editor-frame';

// What the dialog works on: every parameter of the element, with its declaration and resolved value (the saved
// value, else the template default). Comparing this tells whether a draft was based on values that have since
// changed, whether through project data or through the template (a new default, a changed declaration).
function editingContext(template: TemplateInfo, spread: SpreadState, element: string) {
  const definition = template.spreads[spread.definition]?.elements[element];
  const parameters = definition?.parameters ?? {};
  const resolved = resolveParams(parameters, spread.elements[element]?.params ?? {});
  return JSON.stringify([spread.definition, definition?.editor?.parameters ?? [], definition?.controls ?? null,
    Object.keys(parameters).map((key) => [key, parameters[key], resolved[key]])]);
}

// Hosts a template-supplied element editor. The template's component runs in a frame on the render origin and
// can only report a draft; this dialog owns Cancel/Done, focus, read-only mode, validation, and saving the draft
// as one edit (one Undo step). The element's other parameters are generated controls below the frame, in the same
// draft, so the whole element is edited in one place. File imports the editor asks for run here, in the app.
export function ElementEditorDialog({ project, template, spread, element, readOnly, blocked, edit, close, importFile }: {
  project: string; template: TemplateInfo; spread: SpreadState; element: string; readOnly: boolean;
  blocked?: string;
  edit: (change: Edit, notice?: string) => void; close: () => void;
  importFile?: (accept: string[], mode?: ImportMode) => Promise<{ id: string; project: string } | undefined>;
}) {
  const definition = template.spreads[spread.definition]?.elements[element];
  const editor = definition?.editor;
  const dialog = useRef<HTMLDialogElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const draft = useRef<Values>({});
  // The editor's draft as last reported, and the generated controls' own draft, for showing conditional controls.
  const [frameDraft, setFrameDraft] = useState<Values>({});
  const [local, setLocal] = useState<Values>({});
  // The editor opened on this context. If it changes while the editor is open (Reload, Undo, a template edit),
  // the draft is based on stale data and saving it would silently overwrite the newer values.
  const [opened] = useState(() => editingContext(template, spread, element));
  const stale = editingContext(template, spread, element) !== opened;
  // The frame keeps the project state it opened with; saving starts a new render elsewhere, not here.
  const [source] = useState(() => renderOrigin + '/render/' + project + '?view=editor&spread=' + encodeURIComponent(spread.id) +
    '&element=' + encodeURIComponent(element) + (readOnly ? '&readonly' : ''));
  const title = editor?.label ?? 'Edit ' + (definition?.label ?? element);
  const values = (reported: unknown): Values => reported && typeof reported === 'object' ? reported as Values : {};
  const { height, ready, error, setError, failed, flushing, flush } = useEditorFrame(frame, {
    draft(reported) {
      draft.current = { ...draft.current, ...values(reported) };
      setFrameDraft(draft.current);
    },
    done: (reported) => done(values(reported)),
    cancel: () => dialog.current?.close(),
    import(data) {
      const accept = Array.isArray(data.accept) ? data.accept.filter((value): value is string => typeof value === 'string') : [];
      // The import starts a new render session; the frame reads the new file from it.
      const reply = (imported?: { id: string; project: string }) => frame.current?.contentWindow?.postMessage(
        { type: 'editor-imported', request: data.request, ...imported }, renderOrigin);
      if (readOnly || failed || stale || !importFile || !accept.length) reply();
      else void importFile(accept, data.mode === 'copy' || data.mode === 'link' ? data.mode : undefined).then(reply, () => reply());
    },
  });

  useEffect(() => {
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
  }, []);

  const owned = editor?.parameters ?? [];
  const saved = resolveParams(definition?.parameters ?? {}, spread.elements[element]?.params ?? {});
  const current = { ...saved, ...frameDraft, ...local };
  const generated = definition ? controlLayout(definition.parameters, definition.controls, current, owned) : [];

  function done(latest?: Values) {
    if (latest) draft.current = { ...draft.current, ...latest };
    const changes = [...Object.entries(draft.current), ...Object.entries(local)];
    if (failed || stale || blocked) return;
    if (readOnly || !editor || !definition || !changes.length) return dialog.current?.close();
    const invalid = changes.filter(([key, value]) => !Object.hasOwn(definition.parameters, key) ||
      owned.includes(key) !== Object.hasOwn(draft.current, key) || !isParameterValue(definition.parameters[key], value));
    if (invalid.length) {
      setError('The editor produced values the template does not allow: ' +
        invalid.map(([key]) => definition.parameters[key]?.label ?? key).join(', ') + '.');
      return;
    }
    edit(({ project: files }) => {
      const state = files.spreads.find(({ id }) => id === spread.id);
      if (!state) return;
      state.elements[element] ??= { params: {} };
      Object.assign(state.elements[element].params, Object.fromEntries(changes));
    }, (definition.label ?? element) + ' updated');
    dialog.current?.close();
  }

  function requestDone() {
    if (failed || stale || blocked) return;
    if (!flush()) done();
  }

  // The generated controls' values reach the frame, so the editor previews the whole draft (such as a calendar
  // drawn from the week start chosen below it). The frame shows them but never sends them back.
  useEffect(() => {
    if (ready && Object.keys(local).length) frame.current?.contentWindow?.postMessage({ type: 'editor-values', values: local }, renderOrigin);
  }, [ready, local]);

  return <dialog ref={dialog} className="element-editor" aria-label={title} onClose={close}>
    <header className="ee-header">
      <h2>{title}</h2>
      {readOnly && <span className="muted">Sample projects are read-only.</span>}
    </header>
    <iframe ref={frame} className="element-editor-frame" title={title} src={source} style={{ height }} />
    {!ready && !error && <p className="ee-status muted">Loading the editor…</p>}
    {stale && <p className="ee-status error-text" role="alert">
      {(definition?.label ?? element) + ' changed while this editor was open. Cancel and open the editor again to continue from the current values.'}
    </p>}
    {error && !stale && <p className="ee-status error-text" role="alert">{error}</p>}
    {blocked && !stale && <p className="ee-status muted" role="status">{blocked}</p>}
    {generated.length > 0 && <fieldset className="ee-fields" disabled={readOnly || failed || stale}>
      <ControlList nodes={generated} field={(node, param) => <Field key={node.key} param={param} value={current[node.key]}
        description={node.description} change={(next) => setLocal((previous) => ({ ...previous, [node.key]: next }))} />} />
    </fieldset>}
    <footer className="ee-footer">
      <span className="muted">Esc cancels · ⌘↩ saves</span>
      <button type="button" onClick={() => dialog.current?.close()}>Cancel</button>
      <button type="button" className="primary" disabled={readOnly || failed || stale || !!blocked || flushing !== undefined} onClick={requestDone}>Done</button>
    </footer>
  </dialog>;
}
