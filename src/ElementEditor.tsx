import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { renderOrigin } from './desktop';
import type { TemplateInfo } from './desktop';
import type { Edit } from './Inspector';
import { isParameterValue } from './parameters';
import type { SpreadState, Values } from './project';

type EditorMessage =
  | { type: 'editor-ready' } | { type: 'editor-draft'; values: Values } | { type: 'editor-size'; height: number }
  | { type: 'editor-commit'; values: Values } | { type: 'editor-cancel' } | { state: 'error'; message: string };

// The saved values an editor works on, to tell whether they changed while it was open.
const savedValues = (spread: SpreadState, element: string, keys: string[]) =>
  JSON.stringify([spread.definition, keys.map((key) => spread.elements[element]?.params[key] ?? null)]);

// Hosts a template-supplied element editor. The template's component runs in a frame on the render origin and
// can only report a draft; this dialog owns Cancel/Done, focus, read-only mode, validation, and saving the draft
// as one edit (one Undo step).
export function ElementEditorDialog({ project, template, spread, element, readOnly, edit, close }: {
  project: string; template: TemplateInfo; spread: SpreadState; element: string; readOnly: boolean;
  edit: (change: Edit, notice?: string) => void; close: () => void;
}) {
  const definition = template.spreads[spread.definition]?.elements[element];
  const editor = definition?.editor;
  const dialog = useRef<HTMLDialogElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const draft = useRef<Values>({});
  const [height, setHeight] = useState(240);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [failed, setFailed] = useState(false);
  // The editor opened on these saved values. If they change while it is open (Reload, Undo, another window),
  // its draft is based on stale data and saving it would silently overwrite the newer values.
  const [opened] = useState(() => savedValues(spread, element, editor?.parameters ?? []));
  const stale = savedValues(spread, element, editor?.parameters ?? []) !== opened;
  // The frame keeps the project state it opened with; saving starts a new render elsewhere, not here.
  const [source] = useState(() => renderOrigin + '/render/' + project + '?view=editor&spread=' + encodeURIComponent(spread.id) +
    '&element=' + encodeURIComponent(element) + (readOnly ? '&readonly' : ''));
  const title = editor?.label ?? 'Edit ' + (definition?.label ?? element);

  useEffect(() => {
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
  }, []);

  function done(latest?: Values) {
    if (latest) draft.current = { ...draft.current, ...latest };
    const changes = Object.entries(draft.current);
    if (failed || stale) return;
    if (readOnly || !editor || !definition || !changes.length) return dialog.current?.close();
    const invalid = changes.filter(([key, value]) => !editor.parameters.includes(key) || !isParameterValue(definition.parameters[key], value));
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

  const receive = useEffectEvent((event: MessageEvent<EditorMessage>) => {
    if (event.origin !== renderOrigin || event.source !== frame.current?.contentWindow || !event.data) return;
    const data = event.data;
    if ('state' in data) {
      if (data.state === 'error') {
        setFailed(true);
        setError(data.message);
      }
    } else if (data.type === 'editor-ready') {
      setReady(true);
      frame.current?.focus();
    } else if (data.type === 'editor-draft') {
      draft.current = { ...draft.current, ...data.values };
      if (!failed) setError('');
    } else if (data.type === 'editor-size') {
      setHeight(Math.max(120, Math.min(data.height, window.innerHeight * 0.7)));
    } else if (data.type === 'editor-commit') done(data.values);
    else if (data.type === 'editor-cancel') dialog.current?.close();
  });
  useEffect(() => {
    const listener = (event: MessageEvent) => receive(event);
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }, []);

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
    <footer className="ee-footer">
      <span className="muted">Esc cancels · ⌘↩ saves</span>
      <button type="button" onClick={() => dialog.current?.close()}>Cancel</button>
      <button type="button" className="primary" disabled={readOnly || failed || stale} onClick={() => done()}>Done</button>
    </footer>
  </dialog>;
}
