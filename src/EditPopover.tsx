import { Icon } from './Icon';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import type { Rect, TemplateInfo } from './desktop';
import { readEdit, resolveEditPath, writeEdit } from './editing';
import type { EditTarget } from './editing';
import type { Edit } from './Inspector';
import { ParamControl } from './Fields';
import { isParameterValue, resolveParams } from './parameters';
import type { Project, SpreadState, Values } from './project';
import { controlLayout } from './controls';
import type { ControlNode } from './controls';

type Value = Values[string];
const scopeLabel = { spread: '', document: 'Book', element: '', box: '' } as const;

type Shown =
  | { kind: 'field'; target: EditTarget; label: string; description?: string }
  | { kind: 'group'; label: string; description?: string; children: Shown[] };
const shownFields = (items: Shown[]): Extract<Shown, { kind: 'field' }>[] =>
  items.flatMap((item) => item.kind === 'field' ? [item] : shownFields(item.children));

// Orders the targets for display. A box's or element's own parameters follow its `controls` (order, groups, labels,
// conditions on the current values); parameters it leaves out are not shown. Other marked parameters, such as a
// spread heading on a ctx.Text node, are explicit requests to edit them here and always show.
function arrange(targets: EditTarget[], template: TemplateInfo, spread: SpreadState, drafts: Record<string, Value>): Shown[] {
  const layout = template.spreads[spread.definition];
  const shown: Shown[] = [];
  const done = new Set<string>();
  for (const target of targets) {
    if (done.has(target.path)) continue;
    const declaration = target.scope === 'box' ? layout?.boxes[target.owner!] : target.scope === 'element' ? layout?.elements[target.owner!] : undefined;
    if (!declaration) {
      done.add(target.path);
      shown.push({ kind: 'field', target, label: target.param.label });
      continue;
    }
    const same = targets.filter((item) => item.scope === target.scope && item.owner === target.owner);
    for (const item of same) done.add(item.path);
    const saved = (target.scope === 'box' ? spread.boxes : spread.elements)[target.owner!]?.params ?? {};
    const values = { ...resolveParams(declaration.parameters, saved),
      ...Object.fromEntries(same.filter(({ path }) => path in drafts).map(({ key, path }) => [key, drafts[path]])) };
    const byKey = new Map(same.map((item) => [item.key, item]));
    const prune = (nodes: ControlNode[]): Shown[] => nodes.flatMap((node): Shown[] => {
      if (node.kind === 'field') {
        const item = byKey.get(node.key);
        return item ? [{ kind: 'field', target: item, label: node.label, ...(node.description ? { description: node.description } : {}) }] : [];
      }
      const children = prune(node.children);
      return children.length ? [{ kind: 'group', label: node.label, ...(node.description ? { description: node.description } : {}), children }] : [];
    });
    shown.push(...prune(controlLayout(declaration.parameters, declaration.controls, values)));
  }
  return shown;
}

// Opens over what is edited on the page and edits it in place: a node the template marked with `ctx.edit(...)` or
// `ctx.Text`, or a box or element. For a box, `children` is the platform's part (its photo or text) and `title`
// names the box.
export function EditPopover({ project, spread, template, edits, anchor, bounds, readOnly, blocked, edit, close, step, actions, title, children }: {
  project: Project; spread: SpreadState; template: TemplateInfo; edits: string[]; anchor: Rect; bounds: { width: number };
  readOnly: boolean; blocked?: string; edit: (change: Edit, notice?: string) => void; close: () => void; step: (direction: 1 | -1) => void;
  actions?: ReactNode; title?: string; children?: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [drafts, setDrafts] = useState<Record<string, Value>>({});
  const [placement, setPlacement] = useState<{ left: number; top: number }>();
  // Parameters owned by a template-supplied element editor are edited there; the popover offers it as an action.
  const editors = template.spreads[spread.definition]?.elements ?? {};
  const targets = edits.map((path) => resolveEditPath(template, spread.definition, path)).filter((target): target is EditTarget =>
    !!target && !(target.scope === 'element' && editors[target.owner!]?.editor?.parameters.includes(target.key)));
  const shown = arrange(targets, template, spread, drafts);
  const visible = shownFields(shown);

  function apply(changes: Record<string, Value>) {
    const valid = targets.filter(({ path, param }) => path in changes && isParameterValue(param, changes[path]) &&
      changes[path] !== readEdit(project, spread, targets.find((target) => target.path === path)!));
    if (!valid.length || readOnly || blocked) return;
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
  const paused = useRef(blocked);
  paused.current = blocked;

  // Clicking outside applies typed values and closes.
  useEffect(() => {
    function outside(event: PointerEvent) {
      if (paused.current || panel.current?.contains(event.target as Node)) return;
      latest.current();
      close();
    }
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [close]);

  // Sit below the target, or above it, where that is on screen. A target too tall for either, such as a box filling
  // the page, gets the popover over its own top edge, kept inside the visible part of the book.
  useLayoutEffect(() => {
    const element = panel.current;
    if (!element) return;
    const view = element.closest('.canvas');
    const stage = element.offsetParent as HTMLElement | null;
    const visibleTop = view && stage ? view.scrollTop - stage.offsetTop : -Infinity;
    const visibleBottom = view && stage ? view.scrollTop + view.clientHeight - stage.offsetTop : Infinity;
    const height = element.offsetHeight;
    const below = anchor.y + anchor.height + 10;
    const above = anchor.y - height - 10;
    const top = below + height <= visibleBottom ? below
      : above >= Math.max(0, visibleTop) ? above
      : Math.max(Math.max(0, visibleTop) + 8, Math.min(anchor.y + 10, visibleBottom - height - 8));
    const left = Math.max(8, Math.min(anchor.x, bounds.width - element.offsetWidth - 8));
    setPlacement({ left, top });
  }, [anchor.x, anchor.y, anchor.width, anchor.height, bounds.width, visible.length, blocked, !!children]);

  // Focus once placed: the popover is hidden while it measures itself, and hidden fields cannot take focus.
  const focused = useRef(false);
  useEffect(() => {
    if (!placement || focused.current) return;
    focused.current = true;
    // A box editor without parameters focuses its first control, such as the photo or text choice.
    (panel.current?.querySelector<HTMLElement>('[data-autofocus]') ??
      panel.current?.querySelector<HTMLElement>('fieldset :is(select, input, textarea, button):not(:disabled)'))?.focus();
  }, [placement]);

  function keys(event: KeyboardEvent) {
    const multiline = (event.target as HTMLElement).tagName === 'TEXTAREA';
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (blocked) return;
    else if (event.key === 'Enter' && (!multiline || event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      commit();
      close();
    } else if (event.key === 'Tab' && visible.length === 1) {
      event.preventDefault();
      commit();
      step(event.shiftKey ? -1 : 1);
    }
  }

  // A box or element target is titled after the box or element, such as "Story" or "Calendar grid".
  function ownerLabel() {
    const owner = visible.map(({ target }) => target).find(({ scope }) => scope === 'element' || scope === 'box');
    const layout = template.spreads[spread.definition];
    if (!owner || !layout) return undefined;
    return (owner.scope === 'element' ? layout.elements : layout.boxes)[owner.owner!]?.label;
  }
  if (!visible.length && !actions && !children) return null;
  const [only] = visible;
  const heading: ReactNode = title ?? (visible.length === 1
    ? <>{only.label}{scopeLabel[only.target.scope] && <span className="muted"> · {scopeLabel[only.target.scope]}</span>}</>
    : ownerLabel() ?? 'Edit');
  let index = 0;
  const render = (items: Shown[]): ReactNode => items.map((item, i) => {
    if (item.kind === 'group') {
      return <fieldset key={'group ' + i + ' ' + item.label} className="control-group">
        <legend>{item.label}</legend>
        {item.description && <p className="control-description">{item.description}</p>}
        {render(item.children)}
      </fieldset>;
    }
    const { target, label, description } = item;
    const first = index++ === 0;
    return <div className="ep-field" key={target.path}>
      {visible.length > 1 && target.param.type !== 'boolean' && <span className="ep-label">{label}
        {scopeLabel[target.scope] && <span className="muted"> · {scopeLabel[target.scope]}</span>}</span>}
      <ParamControl param={label === target.param.label ? target.param : { ...target.param, label }} value={readEdit(project, spread, target)}
        draft={drafts[target.path]} autoFocus={first}
        setDraft={(value) => setDrafts((previous) => ({ ...previous, [target.path]: value }))}
        apply={(value) => apply({ [target.path]: value })} />
      {description && <small className="field-description">{description}</small>}
    </div>;
  });
  return <div ref={panel} className="edit-popover" role="dialog" aria-label={'Edit ' + (title ?? visible.map(({ label }) => label).join(', '))}
    style={placement ?? { left: anchor.x, top: anchor.y + anchor.height + 10, visibility: 'hidden' }} onKeyDown={keys}
    onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
    <div className="ep-head">
      <span>{heading}</span>
      <button type="button" className="ep-close" aria-label="Close" title="Close (Esc cancels typing)" onClick={() => { commit(); close(); }}><Icon name="close" /></button>
    </div>
    <fieldset disabled={readOnly || !!blocked}>
      {children}
      {render(shown)}
    </fieldset>
    {actions && !readOnly && !blocked && <div className="ep-actions">{actions}</div>}
    {blocked && <p className="ep-hint muted" role="status">{blocked}</p>}
    {readOnly && <p className="ep-hint muted">Sample projects are read-only.</p>}
  </div>;
}
