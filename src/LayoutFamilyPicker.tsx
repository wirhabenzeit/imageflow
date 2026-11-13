import { useRef, useState } from 'react';
import { renderOrigin } from './desktop';
import type { TemplateInfo } from './desktop';
import type { Edit } from './Inspector';
import type { SpreadState } from './project';
import { describeLayoutChange, familyLayouts, planLayoutChange, switchLayout } from './layouts';
import { useEditorFrame } from './editor-frame';

// A picker is mounted for one saved revision. Each choice applies immediately; its replacement frame receives
// the newly saved layout. Messages from an obsolete or blocked frame cannot apply another edit.
export function LayoutFamilyPicker({ project, template, spread, family, layout, readOnly, blocked, edit, close }: {
  project: string; template: TemplateInfo; spread: SpreadState; family: string; layout?: string; readOnly: boolean; blocked?: string;
  edit: (change: Edit, notice?: string | (() => string)) => void; close: () => void;
}) {
  const declared = template.layoutFamilies?.[family];
  const variants = familyLayouts(template.spreads, family);
  const frame = useRef<HTMLIFrameElement>(null);
  const applied = useRef<string>(undefined);
  const [opened] = useState(() => JSON.stringify([spread.definition, declared, variants]));
  const stale = JSON.stringify([spread.definition, declared, variants]) !== opened;
  const initial = variants.includes(spread.definition) ? spread.definition : layout ?? variants[0];
  const source = renderOrigin + '/render/' + project + '?view=layout-picker&spread=' + encodeURIComponent(spread.id) +
    '&family=' + encodeURIComponent(family) + '&layout=' + encodeURIComponent(initial) + (readOnly ? '&readonly' : '');
  const title = declared?.picker?.label ?? declared?.label ?? family;
  const choose = (reported: unknown) => {
    const next = reported && typeof reported === 'object' ? (reported as { layout?: unknown }).layout : undefined;
    if (failed || stale || blocked || readOnly) return;
    if (typeof next !== 'string' || !variants.includes(next)) {
      setError('The picker must choose a layout from ' + (declared?.label ?? family) + '.');
      return;
    }
    if (next === spread.definition || applied.current === next) return;
    applied.current = next;
    let consequence = '';
    edit(({ project: files }) => {
      const state = files.spreads.find(({ id }) => id === spread.id);
      if (!state || state.definition !== spread.definition) return;
      consequence = describeLayoutChange(planLayoutChange(state, next, template.spreads));
      switchLayout(state, next, template.spreads);
    }, () => consequence ? template.spreads[next].label + ' · ' + consequence : '');
  };
  const { height, ready, error, setError, failed } = useEditorFrame(frame, { draft: choose, done: choose, cancel: close });
  const disabled = readOnly || stale || !!blocked || failed;
  return <div id="inline-layout-picker" className="inline-layout-picker" role="region" aria-label={title} aria-disabled={disabled}>
    <iframe ref={frame} className="element-editor-frame" inert={disabled} title={title} src={source} style={{ height }} />
    {!ready && !error && <p className="muted" role="status">Loading…</p>}
    {stale && <p className="error-text" role="alert">Layout changed. Reopen the picker.</p>}
    {error && !stale && <p className="error-text" role="alert">{error}</p>}
    {blocked && !stale && <p className="muted" role="status">{blocked}</p>}
  </div>;
}
