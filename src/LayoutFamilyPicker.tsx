import { useEffect, useRef, useState } from 'react';
import { renderOrigin } from './desktop';
import type { TemplateInfo } from './desktop';
import { scopeSpread } from './project';
import type { PageSide, SpreadState, Values } from './project';
import { familyLayouts } from './layouts';
import { useEditorFrame } from './editor-frame';

// A family keeps one frame while choices save. Its context follows the book without resetting height or focus.
export function LayoutFamilyPicker({ project, template, spread, params, family, readOnly, blocked, page, chooseLayout }: {
  project: string; template: TemplateInfo; spread: SpreadState; params: Values; family: string; readOnly: boolean; blocked?: string;
  page?: PageSide; chooseLayout: (definition: string) => void;
}) {
  const declared = template.layoutFamilies?.[family];
  const selected = scopeSpread(spread, page);
  const current = spread.split && !page ? '' : selected?.definition ?? '';
  const variants = familyLayouts(template.spreads, family);
  const frame = useRef<HTMLIFrameElement>(null);
  const applied = useRef<string>(undefined);
  const [opened] = useState(() => JSON.stringify([declared, variants]));
  const stale = JSON.stringify([declared, variants]) !== opened;
  const [source] = useState(() => renderOrigin + '/render/' + project + '?view=layout-picker&spread=' + encodeURIComponent(spread.id) +
    '&family=' + encodeURIComponent(family) + (page ? '&page=' + page : '') + (readOnly ? '&readonly' : ''));
  const title = declared?.picker?.label ?? declared?.label ?? family;
  const choose = (reported: unknown) => {
    const next = reported && typeof reported === 'object' ? (reported as { layout?: unknown }).layout : undefined;
    if (failed || stale || blocked || readOnly || next === (applied.current ?? current)) return;
    if (typeof next !== 'string' || !variants.includes(next)) {
      setError('The picker must choose a layout from ' + (declared?.label ?? family) + '.');
      return;
    }
    applied.current = next;
    chooseLayout(next);
  };
  const { height, ready, error, setError, failed } = useEditorFrame(frame,
    { draft: choose, done: choose, cancel: () => frame.current?.blur() }, undefined,
    { initialHeight: 28, minimumHeight: 1, focusOnReady: false });
  const disabled = readOnly || stale || !!blocked || failed;
  const contextKey = JSON.stringify([current, page, params, disabled]);
  useEffect(() => {
    if (!ready) return;
    frame.current?.contentWindow?.postMessage({ type: 'layout-picker-state', saved: current, document: params, readOnly: disabled }, renderOrigin);
    if (applied.current === current) applied.current = undefined;
  }, [ready, contextKey]);
  return <div className="field layout-family-field" role="region" aria-label={title} aria-disabled={disabled} aria-busy={!ready || undefined} title={blocked}>
    <span className="field-name">{title}</span>
    <iframe ref={frame} className="element-editor-frame" inert={disabled} title={title} src={source} style={{ height }} />
    {stale && <p className="error-text" role="alert">Layouts changed. Reopen the picker.</p>}
    {error && !stale && <p className="error-text" role="alert">{error}</p>}
  </div>;
}
