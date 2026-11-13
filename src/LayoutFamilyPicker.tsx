import { useEffect, useRef, useState } from 'react';
import { renderOrigin } from './desktop';
import type { TemplateInfo } from './desktop';
import type { Edit } from './Inspector';
import type { SpreadState, Values } from './project';
import { describeLayoutChange, familyLayouts, planLayoutChange, switchLayout } from './layouts';
import { useEditorFrame } from './editor-frame';

// A family keeps one frame while choices save. Its context follows the book without resetting height or focus.
export function LayoutFamilyPicker({ project, template, spread, params, family, readOnly, blocked, edit, close }: {
  project: string; template: TemplateInfo; spread: SpreadState; params: Values; family: string; readOnly: boolean; blocked?: string;
  edit: (change: Edit, notice?: string | (() => string)) => void; close: () => void;
}) {
  const declared = template.layoutFamilies?.[family];
  const variants = familyLayouts(template.spreads, family);
  const frame = useRef<HTMLIFrameElement>(null);
  const applied = useRef<string>(undefined);
  const [opened] = useState(() => JSON.stringify([declared, variants]));
  const stale = JSON.stringify([declared, variants]) !== opened;
  const [source] = useState(() => renderOrigin + '/render/' + project + '?view=layout-picker&spread=' + encodeURIComponent(spread.id) +
    '&family=' + encodeURIComponent(family) + (readOnly ? '&readonly' : ''));
  const title = declared?.picker?.label ?? declared?.label ?? family;
  const choose = (reported: unknown) => {
    const next = reported && typeof reported === 'object' ? (reported as { layout?: unknown }).layout : undefined;
    if (failed || stale || blocked || readOnly || next === spread.definition || applied.current === next) return;
    if (typeof next !== 'string' || !variants.includes(next)) {
      setError('The picker must choose a layout from ' + (declared?.label ?? family) + '.');
      return;
    }
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
  const contextKey = JSON.stringify([spread.definition, params, disabled]);
  useEffect(() => {
    if (!ready) return;
    frame.current?.contentWindow?.postMessage({ type: 'layout-picker-state', saved: spread.definition, document: params, readOnly: disabled }, renderOrigin);
    if (applied.current === spread.definition) applied.current = undefined;
  }, [ready, contextKey]);
  return <div id="inline-layout-picker" className="inline-layout-picker" role="region" aria-label={title} aria-disabled={disabled} title={blocked}>
    <iframe ref={frame} className="element-editor-frame" inert={disabled} title={title} src={source} style={{ height }} />
    {!ready && !error && <p className="muted" role="status">Loading…</p>}
    {stale && <p className="error-text" role="alert">Layouts changed. Reopen the picker.</p>}
    {error && !stale && <p className="error-text" role="alert">{error}</p>}
  </div>;
}
