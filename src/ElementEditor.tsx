import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import type { ImportMode } from './source-locations';
import { renderOrigin } from './desktop';
import type { BookGeometry, TemplateInfo } from './desktop';
import type { Edit } from './Inspector';
import { isParameterValue, resolveParams } from './parameters';
import type { SpreadState, Values } from './project';
import { controlLayout } from './controls';
import { ControlList, Field } from './Fields';
import { useEditorFrame } from './editor-frame';
import { applyEditorChanges, changedValues, editingContext, queuedEditorSave } from './editor-session';
import type { EditorState, EditorTarget } from './editor-session';

// Template components report values from an isolated frame. Apply each valid change through the app's save
// queue, keeping the frame mounted while the book renders. Closing flushes any field still being typed.
// The same panel runs an element's editor and a document editor (`target`). `params` are the document's saved
// parameters; `project` names the current render session, which the frame reads its context from.
export function ElementEditorDialog({ project, template, spread, params, target, readOnly, blocked, canvasReady, edit, close, importFile, prepare, network = '', host, geometry }: {
  project: string; template: TemplateInfo; spread: SpreadState; params: Values; target: EditorTarget; readOnly: boolean;
  blocked?: string; canvasReady: boolean; host?: HTMLElement | null;
  geometry?: BookGeometry;
  edit: (change: Edit, notice?: string) => Promise<boolean>; close: () => void;
  importFile?: (accept: string[], mode?: ImportMode) => Promise<{ id: string; project: string } | undefined>;
  // Settles once the frame may load: the network origins its policy allows are decided before it is served.
  prepare?: () => Promise<string | void>;
  // The network origins the book may reach now; when they change, the frame loads again under the new policy.
  network?: string;
}) {
  const element = target.kind === 'element' ? target.element : '';
  const layout = template.spreads[spread.definition];
  const definition = target.kind === 'element' ? layout?.elements[element] : undefined;
  const documentEditor = target.kind === 'document' ? template.editors?.[target.editor] : undefined;
  const editor = documentEditor ?? definition?.editor;
  // The parameters the editor's `set` writes: the element's, or the document's.
  const declared = target.kind === 'document' ? template.parameters : definition?.parameters;
  const state: EditorState = { spread, params };
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
  const savedState = useRef({ state, template });
  savedState.current = { state, template };
  const [closing, setClosing] = useState(false);
  const outsideAction = useRef<(() => void) | undefined>(undefined);
  const replaying = useRef(false);
  const [warnings, setWarnings] = useState<string[]>([]);
  // Recognize our queued saves without accepting unrelated changes (Reload, Undo, or template edits).
  const expected = useRef(state);
  const contexts = useRef([editingContext(template, state, target)]);
  const context = editingContext(template, state, target);
  const stale = !contexts.current.includes(context);
  useLayoutEffect(() => {
    const index = contexts.current.indexOf(context);
    if (index > 0) contexts.current.splice(0, index);
  }, [context]);
  // The frame keeps the project state it opened with; saving starts a new render elsewhere, not here. Preparing may
  // render the book again (newly allowed network origins), so the frame opens on the project as it is then.
  const address = (id: string) => renderOrigin + '/render/' + id + '?view=editor&spread=' + encodeURIComponent(spread.id) +
    (target.kind === 'document' ? '&editor=' + encodeURIComponent(target.editor) : '&element=' + encodeURIComponent(element)) + (readOnly ? '&readonly' : '');
  const latestProject = useRef(project);
  latestProject.current = project;
  const [source, setSource] = useState(() => address(project));
  const subject = target.kind === 'document' ? editor?.parameters.map((key) => template.parameters[key]?.label ?? key).join(', ') ?? target.editor
    : definition?.label ?? element;
  const title = editor?.label ?? 'Edit ' + subject;
  const [prepared, setPrepared] = useState(!prepare);
  useEffect(() => {
    if (!prepare) return;
    let current = true;
    void prepare().catch(() => undefined).then((id) => {
      if (!current) return;
      setSource(address(typeof id === 'string' ? id : latestProject.current));
      setPrepared(true);
    });
    return () => { current = false; };
  }, []);
  // A frame keeps the content security policy it loaded with, so when network access is allowed or withdrawn while
  // the editor is open (in Settings, or by a change to the template), it loads again on the book as it is now.
  const openedNetwork = useRef(network);
  useEffect(() => {
    if (network === openedNetwork.current) return;
    openedNetwork.current = network;
    setSource(address(latestProject.current));
  }, [network]);
  const values = (reported: unknown): Values => reported && typeof reported === 'object' ? reported as Values : {};
  const { height, ready, generation, error, setError, failed, flushing, flushTimedOut, flush } = useEditorFrame(frame, {
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

  // The book the frame's context comes from follows each new render session, so a reorder or another photo shows
  // in the open editor; the editor's draft is kept.
  const rects = JSON.stringify(Object.fromEntries((canvasReady ? geometry?.boxes ?? [] : [])
    .filter((box) => box.spread === spread.id && box.type === 'element' && box.rect).map((box) => [box.id, box.rect])));
  useEffect(() => {
    if (ready) frame.current?.contentWindow?.postMessage({ type: 'editor-context', project, elementRects: JSON.parse(rects) }, renderOrigin);
  }, [ready, generation, project, rects]);

  const owned = editor?.parameters ?? [];
  const saved = resolveParams(definition?.parameters ?? {}, spread.elements[element]?.params ?? {});
  const current = { ...saved, ...frameDraft, ...local };
  // A document editor's other document parameters stay in template controls; an element's appear below its editor.
  const generated = definition ? controlLayout(definition.parameters, definition.controls, current, owned) : [];

  async function apply(reported: Values, reportedSpread: Values, generatedValues: Values) {
    if (rejected.current || failed || stale || blocked || readOnly || !editor || !declared || !layout) return false;
    const changes = [...Object.entries(reported), ...Object.entries(generatedValues)];
    const spreadChanges = Object.entries(reportedSpread);
    const invalid = changes.filter(([key, value]) => !Object.hasOwn(declared, key) ||
      owned.includes(key) !== Object.hasOwn(reported, key) || !isParameterValue(declared[key], value))
      .map(([key]) => declared[key]?.label ?? key);
    const ownedSpread = definition?.editor?.spread ?? [];
    invalid.push(...spreadChanges.filter(([key, value]) => !ownedSpread.includes(key) || !Object.hasOwn(layout.parameters, key) ||
      !isParameterValue(layout.parameters[key], value)).map(([key]) => layout.parameters[key]?.label ?? key));
    if (invalid.length) {
      setError('The editor produced values the template does not allow: ' + invalid.join(', ') + '.');
      return false;
    }
    const previous = expected.current;
    const changed = changedValues(template, previous, target, { values: Object.fromEntries(changes), spread: Object.fromEntries(spreadChanges) });
    if (!changed) return lastSave.current;
    const next = structuredClone(previous);
    applyEditorChanges(next, target, changed);
    expected.current = next;
    contexts.current.push(editingContext(template, next, target));
    const before = editingContext(template, previous, target);
    // Checked again when this queued edit runs, so an external change cannot be overwritten by an old frame.
    const saving = edit(({ project: files }) => rejected.current ? false : queuedEditorSave(template, files, target, before, changed) && undefined,
      subject + ' updated');
    lastSave.current = saving;
    const applied = await saving;
    if (!applied) {
      // An edit can be skipped during reload/lease changes or fail on disk. Never treat its optimistic state
      // as saved: stop this frame, reset the baseline, and make the recovery visible instead of dropping later edits.
      rejected.current = true;
      const latest = savedState.current;
      expected.current = latest.state;
      contexts.current = [editingContext(latest.template, latest.state, target)];
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
      <h2>{title}</h2>{readOnly && <span className="muted">Read Only</span>}
      <button type="button" className="ep-close" aria-label="Close" title="Close (Esc cancels typing)"
        disabled={flushing !== undefined} onClick={() => requestClose()}><Icon name="close" /></button>
    </header>
    <div className="ee-status-row" aria-live="polite">
      {(saveRejected || stale || error) ? <p className="ee-status error-text" role="alert">
        {saveRejected ? 'The last change could not be saved. Reopen the editor to retry.' : stale ? subject + ' changed. Reopen the editor to continue.' : error}
      </p> : blocked ? <p className="ee-status muted" role="status">{blocked}</p>
        : !ready && <p className="ee-status muted">Loading…</p>}
      {warnings.length > 0 && <details className="ee-warnings"><summary>{warnings.length} editor warnings</summary>
        <ul>{warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></details>}
    </div>
    <div className="ee-body">
    {prepared && <iframe ref={frame} className="element-editor-frame" inert={!!blocked || saveRejected} title={title} src={source} style={{ height }} />}
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
