import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { renderOrigin } from './desktop';
import type { BookGeometry, TemplateInfo } from './desktop';
import { readEdit, resolveEditPath } from './editing';
import { useEditorFrame } from './editor-frame';
import { saveInlineText, textEditorOwner, textProblem } from './inline-text';
import type { Edit } from './Inspector';
import type { Project, SpreadState } from './project';

export function InlineTextEditor({ projectId, project, spread, template, target, zoom, host, canvasReady, blocked, readOnly,
  edit, close, step, shown, notice }: {
  projectId: string; project: Project; spread: SpreadState; template: TemplateInfo; target: BookGeometry['targets'][number];
  zoom: number; host: HTMLElement | null; canvasReady: boolean; blocked?: string; readOnly: boolean;
  edit: (change: Edit, notice?: string) => Promise<boolean>; close: () => void; step: (direction: 1 | -1) => void;
  shown: (showing: boolean) => void;
  notice: (message: string) => void;
}) {
  // One stable frame and baseline per opening. Saves and unrelated book redraws never replace pending typing.
  const [opened] = useState(() => {
    const field = resolveEditPath(template, spread.definition, target.edits[0])!;
    return { field, layout: spread.definition, before: String(readEdit(project, spread, field)),
      source: renderOrigin + '/render/' + projectId + '?view=inline-text&spread=' + encodeURIComponent(spread.id) +
        '&parameter=' + encodeURIComponent(field.path) + '&occurrence=' + target.occurrence };
  });
  const frame = useRef<HTMLIFrameElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const inlineBox = useRef<HTMLDivElement>(null);
  const draft = useRef(opened.before);
  const [typing, setTyping] = useState(opened.before);
  const [textHeight, setTextHeight] = useState(0);
  const [problem, setProblem] = useState('');
  const saving = useRef(false);
  const [finishing, setFinishing] = useState(false);
  const [saved, setSaved] = useState(false);
  const after = useRef<(() => void) | undefined>(undefined);
  const latestStep = useRef(step);
  latestStep.current = step;
  const field = resolveEditPath(template, spread.definition, opened.field.path);
  const stale = spread.definition !== opened.layout || !!textEditorOwner(template, spread.definition, opened.field.path) || JSON.stringify(field) !== JSON.stringify(opened.field) ||
    (!saving.current && !saved && String(readEdit(project, spread, opened.field)) !== opened.before);
  const disabled = readOnly || !!blocked || stale || finishing;
  const text = (reported: unknown) => {
    if (reported && typeof reported === 'object' && typeof (reported as Record<string, unknown>)[opened.field.path] === 'string') {
      draft.current = (reported as Record<string, string>)[opened.field.path];
      setTyping(draft.current);
    }
  };
  const { ready, error, failed, flush, flushing } = useEditorFrame(frame, {
    draft: text,
    done: (reported) => { text(reported); void apply(); },
    cancel: () => { if (!saving.current) close(); },
    step: (direction, reported) => { text(reported); after.current = () => latestStep.current(direction); void apply(); },
    textSize: setTextHeight,
  }, 'The text has not finished composing. Your typing is kept. Finish the input and try Done again, or choose Discard to continue.', { focusOnReady: false });

  async function apply() {
    if (saving.current || saved) return;
    const invalid = textProblem(opened.field.param, draft.current);
    if (invalid || readOnly || blocked || stale || failed) {
      setProblem(invalid ? invalid + ' Fix the text or choose Discard to continue.' : 'This text cannot be saved right now. Copy your typing below, then choose Discard to continue.');
      after.current = undefined;
      return;
    }
    if (draft.current === opened.before) { close(); after.current?.(); return; }
    saving.current = true;
    setFinishing(true);
    setProblem('');
    const value = draft.current;
    const applied = await edit(({ project: files }) => saveInlineText(files, template, spread.id, opened.layout, opened.field, opened.before, value) ? undefined : false,
      opened.field.param.label + ' updated');
    if (applied) setSaved(true);
    else {
      saving.current = false;
      setFinishing(false);
      setProblem('The text could not be saved. Your typing is kept. Try Done again, or copy it below and choose Discard to continue.');
      after.current = undefined;
    }
  }
  // Keep the replacement visible until the confirmed artwork has rendered, including a click that opens another field.
  useEffect(() => {
    if (!saved || !canvasReady) return;
    close();
    after.current?.();
  }, [saved, canvasReady, close]);
  function requestClose(action?: () => void) {
    if (action) after.current = action;
    if (saving.current || saved || flushing !== undefined) return;
    if (!flush()) void apply();
  }
  const latestRequestClose = useRef(requestClose);
  latestRequestClose.current = requestClose;
  const latestNotice = useRef(notice);
  latestNotice.current = notice;
  useEffect(() => {
    let replaying = false;
    const inside = (target: EventTarget | null) => panel.current?.contains(target as Node) || inlineBox.current?.contains(target as Node);
    const pointer = (event: Event) => {
      if (inside(event.target)) return;
      // Hold the whole gesture until typing settles. In particular, do not start a photo drag underneath it.
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const outside = (event: MouseEvent) => {
      if (replaying || inside(event.target)) return;
      const clicked = event.target;
      if (!(clicked instanceof Element)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      latestRequestClose.current(() => {
        if (!clicked.isConnected) return;
        // Browser file inputs, links and explicitly marked actions need a fresh, trusted activation. Never pretend
        // that a synthetic event grants one: finish the edit and ask for the actual action on the next click.
        if (clicked.closest('a[href], input[type="file"], [data-requires-user-activation]')) {
          latestNotice.current('Text saved. Click again to continue.');
          return;
        }
        clicked.closest<HTMLElement>('input, textarea, select, button, [tabindex]')?.focus({ preventScroll: true });
        replaying = true;
        try { clicked.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window,
          clientX: event.clientX, clientY: event.clientY, detail: event.detail, button: event.button,
          metaKey: event.metaKey, ctrlKey: event.ctrlKey, altKey: event.altKey, shiftKey: event.shiftKey })); }
        finally { replaying = false; }
      });
    };
    document.addEventListener('pointerdown', pointer, true);
    document.addEventListener('mousedown', pointer, true);
    document.addEventListener('click', outside, true);
    return () => {
      document.removeEventListener('pointerdown', pointer, true);
      document.removeEventListener('mousedown', pointer, true);
      document.removeEventListener('click', outside, true);
    };
  }, []);
  useEffect(() => {
    if (ready) frame.current?.contentWindow?.postMessage({ type: 'text-disabled', disabled }, renderOrigin);
  }, [ready, disabled]);
  const onShown = useEffectEvent(shown);
  useEffect(() => { onShown(ready && !failed); return () => onShown(false); }, [ready, failed]);
  const message = problem || (stale ? 'This field changed while you were typing. Copy your text below, then choose Discard to continue.'
    : blocked ? blocked + ' Your typing is kept. Wait, or copy it below and choose Discard to continue.' : '') || error;
  const toolbar = host && createPortal(<div className="item-controls crop-toolbar inline-editor-bar inline-text-bar" ref={panel} role="toolbar"
    aria-label={'Edit ' + opened.field.param.label} onPointerDown={(event) => event.stopPropagation()}
    onClick={(event) => event.stopPropagation()} onKeyDown={(event) => {
      event.stopPropagation();
      if (event.key === 'Escape' && !saving.current) { event.preventDefault(); close(); }
    }}>
    <strong>{opened.field.param.label}</strong>
    {message && <div className="inline-text-recovery" role="alert"><p>{message}</p>
      <textarea aria-label="Unsaved text — copy before discarding" readOnly value={typing} /></div>}
    <button type="button" disabled={finishing} onClick={close}>Discard</button>
    <button type="button" className="primary" disabled={finishing || flushing !== undefined} onClick={() => requestClose()}>Done</button>
  </div>, host);
  return <>
    <div ref={inlineBox} className={'inline-editor inline-text-editor' + (ready && !failed ? ' showing' : '')}
      style={{ left: target.x, top: target.y, width: target.width / zoom, height: Math.max(target.height / zoom, textHeight),
        transform: 'scale(' + zoom + ')', '--inline-zoom': zoom } as React.CSSProperties}
      onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()} onMouseMove={(event) => event.stopPropagation()}>
      <iframe ref={frame} title={'Edit ' + opened.field.param.label + ' on page'} className="inline-editor-frame"
        src={opened.source} inert={!ready || finishing} />
    </div>
    {toolbar}
  </>;
}
