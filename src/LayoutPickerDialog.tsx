import { useEffect, useRef, useState } from 'react';
import { renderOrigin } from './desktop';
import type { TemplateInfo } from './desktop';
import type { Edit } from './Inspector';
import type { SpreadState } from './project';
import { describeLayoutChange, familyLayouts, planLayoutChange, switchLayout } from './layouts';
import { useEditorFrame } from './editor-frame';

// What the picker works on: the spread's layout and the family's variants with their footprint and tags. If either
// changes while the dialog is open (Undo, an agent, a template edit), the choice was made against stale data.
function pickingContext(template: TemplateInfo, spread: SpreadState, family: string) {
  return JSON.stringify([spread.definition, template.layoutFamilies?.[family] ?? null,
    familyLayouts(template.spreads, family).map((id) => [id, template.spreads[id].span, template.spreads[id].variant ?? null])]);
}

// Hosts a layout family's picker. The template's component runs in a frame on the render origin and only reports
// the layout it chose; this dialog owns Cancel/Done, shows what switching would carry over and keep, checks that the
// choice is a variant of the family, and switches the layout as one edit (one Undo step), as the sidebar does.
export function LayoutPickerDialog({ project, template, spread, family, layout, readOnly, blocked, edit, close }: {
  project: string; template: TemplateInfo; spread: SpreadState; family: string; layout?: string; readOnly: boolean; blocked?: string;
  edit: (change: Edit, notice?: string | (() => string)) => void; close: () => void;
}) {
  const declared = template.layoutFamilies?.[family];
  const variants = familyLayouts(template.spreads, family);
  const dialog = useRef<HTMLDialogElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const initial = [layout, spread.definition].find((id) => id !== undefined && variants.includes(id)) ?? variants[0];
  const [draft, setDraft] = useState<unknown>(initial);
  const [opened] = useState(() => pickingContext(template, spread, family));
  const stale = pickingContext(template, spread, family) !== opened;
  const [source] = useState(() => renderOrigin + '/render/' + project + '?view=layout-picker&spread=' + encodeURIComponent(spread.id) +
    '&family=' + encodeURIComponent(family) + (initial ? '&layout=' + encodeURIComponent(initial) : '') + (readOnly ? '&readonly' : ''));
  const title = declared?.picker?.label ?? declared?.label ?? family;
  const chosen = (reported: unknown) => reported && typeof reported === 'object' ? (reported as { layout?: unknown }).layout : undefined;
  const { height, ready, error, setError, failed, flushing, flush } = useEditorFrame(frame, {
    draft: (reported) => setDraft(chosen(reported)),
    done: (reported) => done(chosen(reported)),
    cancel: () => dialog.current?.close(),
  });

  useEffect(() => {
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
  }, []);

  const valid = typeof draft === 'string' && variants.includes(draft);
  const consequence = !valid ? '' : draft === spread.definition ? 'Current layout'
    : describeLayoutChange(planLayoutChange(spread, draft, template.spreads));

  function done(next: unknown = draft) {
    if (failed || stale || blocked) return;
    if (typeof next !== 'string' || !variants.includes(next)) {
      setError('The picker chose ' + (typeof next === 'string' ? next : 'no layout') + ', which is not a layout of ' + (declared?.label ?? family) +
        '. It can choose ' + variants.join(', ') + '.');
      return;
    }
    if (readOnly || next === spread.definition) return dialog.current?.close();
    // Planned against the project the switch applies to, which may be newer than this render.
    let summary = '';
    edit(({ project: files }) => {
      const state = files.spreads.find(({ id }) => id === spread.id);
      if (!state) return;
      summary = describeLayoutChange(planLayoutChange(state, next, template.spreads));
      switchLayout(state, next, template.spreads);
    }, () => template.spreads[next].label + ' · ' + summary);
    dialog.current?.close();
  }

  function requestDone() {
    if (failed || stale || blocked) return;
    if (!flush()) done();
  }

  return <dialog ref={dialog} className="element-editor layout-picker-dialog" aria-label={title} onClose={close}>
    <header className="ee-header">
      <h2>{title}</h2>
      {readOnly && <span className="muted">Sample projects are read-only.</span>}
    </header>
    <iframe ref={frame} className="element-editor-frame" title={title} src={source} style={{ height }} />
    {!ready && !error && <p className="ee-status muted">Loading the picker…</p>}
    {stale && <p className="ee-status error-text" role="alert">
      {'The layout or the template changed while this picker was open. Cancel and open it again to continue.'}
    </p>}
    {error && !stale && <p className="ee-status error-text" role="alert">{error}</p>}
    {blocked && !stale && <p className="ee-status muted" role="status">{blocked}</p>}
    {valid && !stale && <p className="ee-status muted layout-picker-consequence" role="status">
      {template.spreads[draft].label + ' · ' + consequence}</p>}
    <footer className="ee-footer">
      <span className="muted">Esc cancels · ⌘↩ saves</span>
      <button type="button" onClick={() => dialog.current?.close()}>Cancel</button>
      <button type="button" className="primary" disabled={readOnly || failed || stale || !!blocked || flushing !== undefined} onClick={requestDone}>Done</button>
    </footer>
  </dialog>;
}
