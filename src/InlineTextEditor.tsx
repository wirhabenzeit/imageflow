import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { renderOrigin } from './desktop';
import type { BookGeometry, ProjectSummary, TemplateInfo } from './desktop';
import { readEdit, resolveEditPath } from './editing';
import type { SourceUsage } from './editing';
import { useEditorFrame } from './editor-frame';
import { captionElsewhere, captionPhoto, printedCaption, saveInlineCaption } from './inline-caption';
import type { CaptionPlace } from './inline-caption';
import { captionKey, captionParameter, saveInlineText, textEditorOwner, textProblem } from './inline-text';
import type { Edit } from './Inspector';
import { scopeSpread } from './project';
import type { Project, SpreadState } from './project';

// `caption` is what a photo's caption (a target with `caption`, from ctx.Caption) is read and saved with: the photos'
// own entries, and where each is placed, for the hint that the caption changes there too (UI-019).
export function InlineTextEditor({ projectId, project, spread, template, target, zoom, host, canvasReady, blocked,
  edit, close, step, shown, notice, caption }: {
  projectId: string; project: Project; spread: SpreadState; template: TemplateInfo; target: BookGeometry['targets'][number];
  zoom: number; host: HTMLElement | null; canvasReady: boolean; blocked?: string;
  edit: (change: Edit, notice?: string) => Promise<boolean>; close: () => void; step: (direction: 1 | -1) => void;
  shown: (showing: boolean) => void;
  notice: (message: string) => void;
  caption?: { summary: ProjectSummary; usage: SourceUsage };
}) {
  const layout = scopeSpread(spread, target.page)?.definition ?? '';
  // One stable frame and baseline per opening. Saves and unrelated book redraws never replace pending typing.
  const [opened] = useState(() => {
    const frameSource = (query: string) => renderOrigin + '/render/' + projectId + '?view=inline-text&spread=' + encodeURIComponent(spread.id) +
      (target.page ? '&page=' + target.page : '') + query + '&occurrence=' + target.occurrence;
    if (target.caption !== undefined) {
      // A caption starts from the text the template printed, and belongs to the photo the box showed when it opened.
      const at: CaptionPlace = { spread: spread.id, ...(target.page ? { page: target.page } : {}), box: target.caption, layout };
      const photo = captionPhoto(project, at);
      return { key: captionKey, param: captionParameter, layout, caption: { at, photo }, before: photo && caption ? printedCaption(caption.summary, photo) : '',
        source: frameSource('&caption=' + encodeURIComponent(target.caption)) };
    }
    const field = resolveEditPath(template, layout, target.edits[0], target.page)!;
    return { key: field.path, param: field.param, layout, field, before: String(readEdit(project, spread, field)),
      source: frameSource('&parameter=' + encodeURIComponent(field.path)) };
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
  // A caption is stale once its box shows another photo or layout, or its photo's caption changed elsewhere meanwhile.
  const stale = layout !== opened.layout || (opened.caption
    ? !opened.caption.photo || !caption || captionPhoto(project, opened.caption.at) !== opened.caption.photo ||
      (!saving.current && !saved && printedCaption(caption.summary, opened.caption.photo) !== opened.before)
    : !!textEditorOwner(template, layout, opened.field.path) ||
      JSON.stringify(resolveEditPath(template, layout, opened.field.path, target.page)) !== JSON.stringify(opened.field) ||
      (!saving.current && !saved && String(readEdit(project, spread, opened.field)) !== opened.before));
  const disabled = !!blocked || stale || finishing;
  const text = (reported: unknown) => {
    if (reported && typeof reported === 'object' && typeof (reported as Record<string, unknown>)[opened.key] === 'string') {
      draft.current = (reported as Record<string, string>)[opened.key];
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
    const invalid = textProblem(opened.param, draft.current);
    if (invalid || blocked || stale || failed) {
      setProblem(invalid ? invalid + ' Fix the text or choose Discard to continue.' : 'This text cannot be saved right now. Copy your typing below, then choose Discard to continue.');
      after.current = undefined;
      return;
    }
    if (draft.current === opened.before) { close(); after.current?.(); return; }
    saving.current = true;
    setFinishing(true);
    setProblem('');
    const value = draft.current;
    // A caption saves as Edit Caption… does, switching on Show caption for a photo's first caption (UI-014).
    const captioned = opened.caption?.photo && caption && { ...opened.caption, photo: opened.caption.photo, summary: caption.summary };
    const applied = await edit((files) => (captioned
      ? saveInlineCaption(files, captioned.summary, captioned.at, template.spreads[captioned.at.layout]?.boxes[captioned.at.box]?.parameters, captioned.photo, opened.before, value)
      : opened.field && saveInlineText(files.project, template, spread.id, opened.layout, opened.field, opened.before, value)) ? undefined : false,
    opened.param.label + ' updated');
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
  // A caption belongs to the photo, so typing it here changes it wherever else the photo is placed: say where.
  const elsewhere = opened.caption?.photo && caption ? captionElsewhere(caption.usage, opened.caption.photo, spread.id) : undefined;
  const message = problem || (stale ? (opened.caption ? 'This caption' : 'This field') + ' changed while you were typing. Copy your text below, then choose Discard to continue.'
    : blocked ? blocked + ' Your typing is kept. Wait, or copy it below and choose Discard to continue.' : '') || error;
  const toolbar = host && createPortal(<div className="item-controls crop-toolbar inline-editor-bar inline-text-bar" ref={panel} role="toolbar"
    aria-label={'Edit ' + opened.param.label} onPointerDown={(event) => event.stopPropagation()}
    onClick={(event) => event.stopPropagation()} onKeyDown={(event) => {
      event.stopPropagation();
      if (event.key === 'Escape' && !saving.current) { event.preventDefault(); close(); }
    }}>
    <strong>{opened.param.label}</strong>
    {elsewhere && <span className="inline-caption-elsewhere" title="The caption belongs to the photo, wherever it is placed.">{elsewhere}</span>}
    {opened.param.type === 'string' && opened.param.markdown === 'inline' && <span className="inline-text-format" role="group" aria-label="Formatting">
      {([['bold', 'B', 'Bold (⌘B)'], ['italic', 'I', 'Italic (⌘I)'], ['strike', 'S', 'Strikethrough (⇧⌘X)']] as const).map(([mark, letter, title]) =>
        <button key={mark} type="button" className={'format-' + mark} title={title} aria-label={title} disabled={disabled || !ready}
          // Keep focus and the selection in the text while clicking.
          onPointerDown={(event) => event.preventDefault()} onMouseDown={(event) => event.preventDefault()}
          onClick={() => frame.current?.contentWindow?.postMessage({ type: 'text-format', mark }, renderOrigin)}>{letter}</button>)}
    </span>}
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
      <iframe ref={frame} title={'Edit ' + opened.param.label + ' on page'} className="inline-editor-frame"
        src={opened.source} inert={!ready || finishing} />
    </div>
    {toolbar}
  </>;
}
