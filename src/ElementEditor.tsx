import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import type { ImportMode } from './source-locations';
import { renderOrigin } from './desktop';
import type { TemplateInfo } from './desktop';
import type { Edit } from './Inspector';
import { isParameterValue, resolveParams } from './parameters';
import type { SpreadState, Values } from './project';
import { controlLayout } from './controls';
import { ControlList, Field } from './Fields';
import { useEditorFrame } from './editor-frame';

// What the editor works on: every parameter of the element, with its declaration and resolved value (the saved
// value, else the template default). Comparing this tells whether a draft was based on values that have since
// changed, whether through project data or through the template (a new default, a changed declaration).
// The layout (spread) parameters the editor edits count too.
function editingContext(template: TemplateInfo, spread: SpreadState, element: string) {
  const layout = template.spreads[spread.definition];
  const definition = layout?.elements[element];
  const parameters = definition?.parameters ?? {};
  const resolved = resolveParams(parameters, spread.elements[element]?.params ?? {});
  const layoutParameters = layout?.parameters ?? {};
  const owned = (definition?.editor?.spread ?? []).filter((key) => Object.hasOwn(layoutParameters, key));
  const resolvedSpread = resolveParams(layoutParameters, spread.params);
  return JSON.stringify([spread.definition, definition?.editor?.parameters ?? [], definition?.editor?.spread ?? [], definition?.controls ?? null,
    Object.keys(parameters).map((key) => [key, parameters[key], resolved[key]]),
    owned.map((key) => [key, layoutParameters[key], resolvedSpread[key]])]);
}

// Template components report values from an isolated frame. Apply each valid change through the app's save
// queue, keeping the frame mounted while the book renders. Closing flushes any field still being typed.
export function ElementEditorDialog({ project, template, spread, element, readOnly, blocked, canvasReady, edit, close, importFile, host }: {
  project: string; template: TemplateInfo; spread: SpreadState; element: string; readOnly: boolean;
  blocked?: string; canvasReady: boolean; host?: HTMLElement | null;
  edit: (change: Edit, notice?: string) => Promise<boolean>; close: () => void;
  importFile?: (accept: string[], mode?: ImportMode) => Promise<{ id: string; project: string } | undefined>;
}) {
  const layout = template.spreads[spread.definition];
  const definition = layout?.elements[element];
  const editor = definition?.editor;
  const panel = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const draft = useRef<Values>({});
  const spreadDraft = useRef<Values>({});
  // The editor's draft as last reported, and the generated controls' own draft, for showing conditional controls.
  const [frameDraft, setFrameDraft] = useState<Values>({});
  const [local, setLocal] = useState<Values>({});
  const [saveRejected, setSaveRejected] = useState(false);
  const rejected = useRef(false);
  const lastSave = useRef(Promise.resolve(true));
  const savedState = useRef({ spread, template });
  savedState.current = { spread, template };
  const [closing, setClosing] = useState(false);
  const outsideAction = useRef<(() => void) | undefined>(undefined);
  const replaying = useRef(false);
  const [warnings, setWarnings] = useState<string[]>([]);
  // Recognize our queued saves without accepting unrelated changes (Reload, Undo, or template edits).
  const expected = useRef(spread);
  const contexts = useRef([editingContext(template, spread, element)]);
  const context = editingContext(template, spread, element);
  const stale = !contexts.current.includes(context);
  useLayoutEffect(() => {
    const index = contexts.current.indexOf(context);
    if (index > 0) contexts.current.splice(0, index);
  }, [context]);
  // The frame keeps the project state it opened with; saving starts a new render elsewhere, not here.
  const [source] = useState(() => renderOrigin + '/render/' + project + '?view=editor&spread=' + encodeURIComponent(spread.id) +
    '&element=' + encodeURIComponent(element) + (readOnly ? '&readonly' : ''));
  const title = editor?.label ?? 'Edit ' + (definition?.label ?? element);
  const values = (reported: unknown): Values => reported && typeof reported === 'object' ? reported as Values : {};
  const { height, ready, error, setError, failed, flushing, flushTimedOut, flush } = useEditorFrame(frame, {
    draft(reported, reportedSpread) {
      draft.current = { ...draft.current, ...values(reported) };
      spreadDraft.current = { ...spreadDraft.current, ...values(reportedSpread) };
      setFrameDraft(draft.current);
      void apply(draft.current, spreadDraft.current, local);
    },
    done: (reported, reportedSpread) => { void done(values(reported), values(reportedSpread)); },
    cancel: close,
    warning(reported) {
      const message = typeof reported === 'string' ? reported.slice(0, 500) : '';
      if (message) setWarnings((previous) => previous.includes(message) || previous.length >= 5 ? previous : [...previous, message]);
    },
    import(data) {
      const accept = Array.isArray(data.accept) ? data.accept.filter((value): value is string => typeof value === 'string') : [];
      // The import starts a new render session; the frame reads the new file from it.
      const reply = (imported?: { id: string; project: string }) => frame.current?.contentWindow?.postMessage(
        { type: 'editor-imported', request: data.request, ...imported }, renderOrigin);
      if (readOnly || failed || stale || blocked || rejected.current || !importFile || !accept.length) reply();
      else void importFile(accept, data.mode === 'copy' || data.mode === 'link' ? data.mode : undefined).then(reply, () => reply());
    },
  }, 'The editor has not finished the current field. Click × again to close without the unfinished typing.');

  const latestClose = useRef(requestClose);
  latestClose.current = requestClose;
  useEffect(() => {
    const outside = (event: MouseEvent) => {
      if (replaying.current || panel.current?.contains(event.target as Node)) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      // Complete the active field and its save first, then perform this same click once. Pointer gestures and
      // scrolling remain available; a click on Undo must undo the field we just finished, not the previous edit.
      event.preventDefault();
      event.stopImmediatePropagation();
      latestClose.current(() => {
        if (!target.isConnected) return;
        replaying.current = true;
        try {
          target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window,
            clientX: event.clientX, clientY: event.clientY, button: event.button, detail: event.detail,
            altKey: event.altKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey }));
        } finally { replaying.current = false; }
      });
    };
    document.addEventListener('click', outside, true);
    return () => document.removeEventListener('click', outside, true);
  }, []);
  useEffect(() => {
    if (!closing || (outsideAction.current && !canvasReady && !blocked && !failed && !stale && !saveRejected)) return;
    const action = outsideAction.current;
    outsideAction.current = undefined;
    close();
    action?.();
  }, [closing, canvasReady, blocked, failed, stale, saveRejected, close]);

  const owned = editor?.parameters ?? [];
  const saved = resolveParams(definition?.parameters ?? {}, spread.elements[element]?.params ?? {});
  const current = { ...saved, ...frameDraft, ...local };
  const generated = definition ? controlLayout(definition.parameters, definition.controls, current, owned) : [];

  async function apply(reported: Values, reportedSpread: Values, generatedValues: Values) {
    if (rejected.current || failed || stale || blocked || readOnly || !editor || !definition || !layout) return false;
    const changes = [...Object.entries(reported), ...Object.entries(generatedValues)];
    const spreadChanges = Object.entries(reportedSpread);
    const invalid = changes.filter(([key, value]) => !Object.hasOwn(definition.parameters, key) ||
      owned.includes(key) !== Object.hasOwn(reported, key) || !isParameterValue(definition.parameters[key], value))
      .map(([key]) => definition.parameters[key]?.label ?? key);
    const ownedSpread = editor.spread ?? [];
    invalid.push(...spreadChanges.filter(([key, value]) => !ownedSpread.includes(key) || !Object.hasOwn(layout.parameters, key) ||
      !isParameterValue(layout.parameters[key], value)).map(([key]) => layout.parameters[key]?.label ?? key));
    if (invalid.length) {
      setError('The editor produced values the template does not allow: ' + invalid.join(', ') + '.');
      return false;
    }
    const previous = expected.current;
    const elementValues = resolveParams(definition.parameters, previous.elements[element]?.params ?? {});
    const layoutValues = resolveParams(layout.parameters, previous.params);
    const changed = changes.filter(([key, value]) => elementValues[key] !== value);
    const changedSpread = spreadChanges.filter(([key, value]) => layoutValues[key] !== value);
    if (!changed.length && !changedSpread.length) return lastSave.current;
    const next = structuredClone(previous);
    const update = (state: SpreadState) => {
      if (changed.length) {
        state.elements[element] ??= { params: {} };
        Object.assign(state.elements[element].params, Object.fromEntries(changed));
      }
      Object.assign(state.params, Object.fromEntries(changedSpread));
    };
    update(next);
    expected.current = next;
    contexts.current.push(editingContext(template, next, element));
    const before = editingContext(template, previous, element);
    const saving = edit(({ project: files }) => {
      const state = files.spreads.find(({ id }) => id === spread.id);
      // Check again when this queued edit runs, so an external change cannot be overwritten by an old frame.
      if (rejected.current || !state || editingContext(template, state, element) !== before) return false;
      update(state);
    }, (definition.label ?? element) + ' updated');
    lastSave.current = saving;
    const applied = await saving;
    if (!applied) {
      // An edit can be skipped during reload/lease changes or fail on disk. Never treat its optimistic state
      // as saved: stop this frame, reset the baseline, and make the recovery visible instead of dropping later edits.
      rejected.current = true;
      const latest = savedState.current;
      expected.current = latest.spread;
      contexts.current = [editingContext(latest.template, latest.spread, element)];
      setSaveRejected(true);
    }
    return applied;
  }

  async function done(latest: Values, latestSpread: Values) {
    draft.current = { ...draft.current, ...latest };
    spreadDraft.current = { ...spreadDraft.current, ...latestSpread };
    if (await apply(draft.current, spreadDraft.current, local) || readOnly) setClosing(true);
  }

  function requestClose(action?: () => void) {
    outsideAction.current = action;
    if (failed || stale || blocked || readOnly || flushTimedOut || rejected.current) { setClosing(true); return; }
    if (flushing !== undefined) return;
    if (!flush()) void done({}, {});
  }

  // The generated controls' values reach the frame, so the editor previews the whole draft (such as a calendar
  // drawn from the week start chosen below it). The frame shows them but never sends them back.
  useEffect(() => {
    if (ready && Object.keys(local).length) frame.current?.contentWindow?.postMessage({ type: 'editor-values', values: local }, renderOrigin);
  }, [ready, local]);

  if (!host) return null;
  return createPortal(<div ref={panel} className="item-controls element-editor" role="dialog" aria-label={title}
    onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}
    onDoubleClick={(event) => event.stopPropagation()}
    onMouseMove={(event) => event.stopPropagation()} onMouseLeave={(event) => event.stopPropagation()}
    onDragOver={(event) => { event.preventDefault(); event.stopPropagation(); }}
    onDragLeave={(event) => event.stopPropagation()}
    onDrop={(event) => { event.preventDefault(); event.stopPropagation(); }}
    onKeyDown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
      else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); requestClose(); }
    }}>
    <header className="ee-header">
      <h2>{title}</h2>
      <button type="button" className="ep-close" aria-label="Close" title="Close (Esc cancels typing)"
        disabled={flushing !== undefined} onClick={() => requestClose()}><Icon name="close" /></button>
    </header>
    {saveRejected && <p className="ee-status error-text" role="alert">
      The last change could not be saved. Close and reopen this editor to continue from the saved values.
    </p>}
    {blocked && !stale && <p className="ee-status muted" role="status">{blocked}</p>}
    <div className="ee-body">
    <iframe ref={frame} className="element-editor-frame" inert={!!blocked || saveRejected} title={title} src={source} style={{ height }} />
    {!ready && !error && <p className="ee-status muted">Loading the editor…</p>}
    {stale && <p className="ee-status error-text" role="alert">
      {(definition?.label ?? element) + ' changed while this editor was open. Close and open the editor again to continue from the current values.'}
    </p>}
    {error && !stale && <p className="ee-status error-text" role="alert">{error}</p>}
    {readOnly && <p className="ee-status muted">Sample projects are read-only.</p>}
    {warnings.length > 0 && <div className="ee-status ee-warnings" role="status">
      <strong>The editor asked for changes it cannot make:</strong>
      <ul>{warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
    </div>}
    {generated.length > 0 && <fieldset className="ee-fields" disabled={readOnly || failed || stale || !!blocked || saveRejected}>
      <ControlList nodes={generated} field={(node, param) => <Field key={node.key} param={param} value={current[node.key]}
        description={node.description} change={(next) => {
          const updated = { ...local, [node.key]: next };
          setLocal(updated);
          void apply(draft.current, spreadDraft.current, updated);
        }} />} />
    </fieldset>}
    </div>
  </div>, host);
}
