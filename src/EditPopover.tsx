import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import type { Rect, TemplateInfo } from './desktop';
import { readEdit, resolveEditPath, writeEdit } from './editing';
import type { EditTarget } from './editing';
import type { Edit } from './Inspector';
import { ParamControl } from './Fields';
import { isParameterValue } from './parameters';
import type { Project, SpreadState, Values } from './project';

type Value = Values[string];
const scopeLabel = { spread: '', document: 'Book', element: '', box: '' } as const;

// Opens over a node the template marked with `ctx.edit(...)`, and edits those parameters in place.
export function EditPopover({ project, spread, template, edits, anchor, bounds, readOnly, edit, close, step, actions }: {
  project: Project; spread: SpreadState; template: TemplateInfo; edits: string[]; anchor: Rect; bounds: { width: number };
  readOnly: boolean; edit: (change: Edit, notice?: string) => void; close: () => void; step: (direction: 1 | -1) => void;
  actions?: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [drafts, setDrafts] = useState<Record<string, Value>>({});
  const [placement, setPlacement] = useState<{ left: number; top: number }>();
  // Parameters owned by a template-supplied element editor are edited there; the popover offers it as an action.
  const editors = template.spreads[spread.definition]?.elements ?? {};
  const targets = edits.map((path) => resolveEditPath(template, spread.definition, path)).filter((target): target is EditTarget =>
    !!target && !(target.scope === 'element' && editors[target.owner!]?.editor?.parameters.includes(target.key)));

  function apply(changes: Record<string, Value>) {
    const valid = targets.filter(({ path, param }) => path in changes && isParameterValue(param, changes[path]) &&
      changes[path] !== readEdit(project, spread, targets.find((target) => target.path === path)!));
    if (!valid.length || readOnly) return;
    edit(({ project: files }) => { for (const target of valid) writeEdit(files, spread.id, target, changes[target.path]); },
      valid.map(({ param }) => param.label).join(', ') + ' updated');
    setDrafts((previous) => ({ ...previous, ...Object.fromEntries(valid.map(({ path }) => [path, changes[path]])) }));
  }
  // Applied values stay shown until the saved project catches up, then the project is the source again.
  useEffect(() => {
    setDrafts((previous) => {
      const pending = Object.entries(previous).filter(([path, value]) => {
        const target = targets.find((item) => item.path === path);
        return target && readEdit(project, spread, target) !== value;
      });
      return pending.length === Object.keys(previous).length ? previous : Object.fromEntries(pending);
    });
  }, [project]);
  const commit = () => apply(drafts);
  const latest = useRef(commit);
  latest.current = commit;

  // Clicking outside applies typed values and closes.
  useEffect(() => {
    function outside(event: PointerEvent) {
      if (panel.current?.contains(event.target as Node)) return;
      latest.current();
      close();
    }
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [close]);

  // Sit below the target, or above it when there is no room, inside the stage.
  useLayoutEffect(() => {
    const element = panel.current;
    if (!element) return;
    const view = element.closest('.canvas');
    const stage = element.offsetParent as HTMLElement | null;
    const visibleBottom = view && stage ? view.scrollTop + view.clientHeight - stage.offsetTop : Infinity;
    const height = element.offsetHeight;
    const below = anchor.y + anchor.height + 10;
    const top = below + height > visibleBottom && anchor.y - height - 10 > 0 ? anchor.y - height - 10 : below;
    const left = Math.max(8, Math.min(anchor.x, bounds.width - element.offsetWidth - 8));
    setPlacement({ left, top });
  }, [anchor.x, anchor.y, anchor.width, anchor.height, bounds.width, targets.length]);

  // Focus once placed: the popover is hidden while it measures itself, and hidden fields cannot take focus.
  const focused = useRef(false);
  useEffect(() => {
    if (!placement || focused.current) return;
    focused.current = true;
    panel.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
  }, [placement]);

  function keys(event: KeyboardEvent) {
    const multiline = (event.target as HTMLElement).tagName === 'TEXTAREA';
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (event.key === 'Enter' && (!multiline || event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      commit();
      close();
    } else if (event.key === 'Tab' && targets.length === 1) {
      event.preventDefault();
      commit();
      step(event.shiftKey ? -1 : 1);
    }
  }

  // A box or element target is titled after the box or element, such as "Story" or "Calendar grid".
  function ownerLabel() {
    const owner = targets.find(({ scope }) => scope === 'element' || scope === 'box');
    const layout = template.spreads[spread.definition];
    if (!owner || !layout) return undefined;
    return (owner.scope === 'element' ? layout.elements : layout.boxes)[owner.owner!]?.label;
  }
  if (!targets.length && !actions) return null;
  const heading: ReactNode = targets.length === 1
    ? <>{targets[0].param.label}{scopeLabel[targets[0].scope] && <span className="muted"> · {scopeLabel[targets[0].scope]}</span>}</>
    : ownerLabel() ?? 'Edit';
  return <div ref={panel} className="edit-popover" role="dialog" aria-label={'Edit ' + targets.map(({ param }) => param.label).join(', ')}
    style={placement ?? { left: anchor.x, top: anchor.y + anchor.height + 10, visibility: 'hidden' }} onKeyDown={keys}
    onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
    <div className="ep-head">
      <span>{heading}</span>
      <button type="button" className="ep-close" aria-label="Close" title="Close (Esc cancels typing)" onClick={() => { commit(); close(); }}>×</button>
    </div>
    <fieldset disabled={readOnly}>
      {targets.map((target, i) => <div className="ep-field" key={target.path}>
        {targets.length > 1 && target.param.type !== 'boolean' && <span className="ep-label">{target.param.label}
          {scopeLabel[target.scope] && <span className="muted"> · {scopeLabel[target.scope]}</span>}</span>}
        <ParamControl param={target.param} value={readEdit(project, spread, target)} draft={drafts[target.path]} autoFocus={i === 0}
          setDraft={(value) => setDrafts((previous) => ({ ...previous, [target.path]: value }))}
          apply={(value) => apply({ [target.path]: value })} />
      </div>)}
    </fieldset>
    {actions && !readOnly && <div className="ep-actions">{actions}</div>}
    {readOnly && <p className="ep-hint muted">Sample projects are read-only.</p>}
  </div>;
}
