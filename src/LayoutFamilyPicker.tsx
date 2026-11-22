import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { renderOrigin } from './desktop';
import type { TemplateInfo } from './desktop';
import { scopeSpread } from './project';
import type { PageSide, SpreadState, Values } from './project';
import { familyLayouts } from './layouts';
import { useEditorFrame } from './editor-frame';
import { Choice } from './choice';

// A family keeps one frame while choices save. Its context follows the book without resetting height or focus.
export function LayoutFamilyPicker({ project, template, spread, params, family, readOnly, blocked, page, chooseLayout, onShowing }: {
  project: string; template: TemplateInfo; spread: SpreadState; params: Values; family: string; readOnly: boolean; blocked?: string;
  page?: PageSide; chooseLayout: (definition: string) => void;
  // Called once the frame shows the saved choice, so a picker it replaces can stay on show until then (F-035).
  onShowing?: () => void;
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
  const showing = useRef(onShowing);
  showing.current = onShowing;
  // The field shows once its frame has drawn the saved choice: before, the frame was an empty, white box for a moment.
  // Nearly transparent, not hidden, so Chromium paints the frame meanwhile.
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    if (!ready && !failed) return;
    // The frame draws the state it was just sent in its next frame, and reports its new height after that.
    let second = 0;
    const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => { setDrawn(true); showing.current?.(); }); });
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); };
  }, [ready, failed]);
  return <div className="field layout-family-field" role="region" aria-label={title} aria-disabled={disabled} aria-busy={!ready || undefined} title={blocked}
    style={drawn ? undefined : { opacity: .01 }}>
    <span className="field-name">{title}</span>
    <iframe ref={frame} className="element-editor-frame" inert={disabled} title={title} src={source} style={{ height }} />
    {stale && <p className="error-text" role="alert">Layouts changed. Reopen the picker.</p>}
    {error && !stale && <p className="error-text" role="alert">{error}</p>}
  </div>;
}

// A family whose picker is a `choice`: the app's own segmented control, drawn at once, with no frame or template code.
export function FamilyChoice({ template, spread, family, page, readOnly, chooseLayout }: {
  template: TemplateInfo; spread: SpreadState; family: string; page?: PageSide; readOnly: boolean; chooseLayout: (definition: string) => void;
}) {
  const declared = template.layoutFamilies?.[family];
  const choice = declared?.picker?.choice;
  const selected = scopeSpread(spread, page);
  const current = spread.split && !page ? '' : selected?.definition ?? '';
  if (!choice) return null;
  const variants = familyLayouts(template.spreads, family);
  const title = declared.picker?.label ?? declared.label;
  // In the order the choice names them; the template check makes sure every variant has exactly one option.
  const options = Object.entries(choice.options).flatMap(([value, label]) => {
    const id = variants.find((variant) => String(template.spreads[variant].variant?.[choice.tag]) === value);
    return id ? [{ value: id, label }] : [];
  });
  return <div className="field layout-family-field" role="region" aria-label={title}>
    <span className="field-name">{title}</span>
    <Choice label={title} hideLabel value={current} options={options} disabled={readOnly}
      onChange={(next) => { if (next !== current) chooseLayout(next); }} />
  </div>;
}

// Keeps the picker on show until the one replacing it, for another spread, page or family, shows its choice: a new
// frame starts empty, so after a layout change the choice was blank for a moment (beta finding F-035). The previous
// picker is inert meanwhile, and the new one loads invisibly on top of it.
export function HeldPicker({ id, children }: { id: string; children: (showing: () => void) => ReactNode }) {
  const [shown, setShown] = useState(id);
  const nodes = useRef(new Map<string, ReactNode>());
  nodes.current.set(id, children(() => setShown(id)));
  for (const key of nodes.current.keys()) if (key !== id && key !== shown) nodes.current.delete(key);
  const held = shown !== id && nodes.current.has(shown);
  return <div className="held-picker">
    {held && <div key={shown} inert>{nodes.current.get(shown)}</div>}
    <div key={id} className={held ? 'held-picker-pending' : undefined} aria-hidden={held || undefined}>{nodes.current.get(id)}</div>
  </div>;
}
