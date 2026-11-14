import { createContext, Fragment, useContext, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { compactParameter } from './compact-controls';
import { controlLayout } from './controls';
import type { ControlItem, ControlNode } from './controls';
import type { Values } from './project';
import type { ListItem, ListParameter, Parameter, Parameters, ScalarParameter } from './parameters';
import { isParameterValue, newItemId, resolveParams, resolveValue, sameValue } from './parameters';
import { Icon } from './Icon';
import { sourcePath } from './source-locations';
import type { SourceReference, ImportMode } from './source-locations';
import { fileName } from './source-items';

type Value = Values[string];

// The project's files (ID → owned path or linked reference) for file parameters, and how to add one. Provided by the editor shell.
export const ProjectFilesContext = createContext<{
  files: Record<string, SourceReference>; importFile?: (accept: string[], mode?: ImportMode) => Promise<string | undefined>;
}>({ files: {} });

// Lists are drawn in full (rows with their fields) where there is room, and as a "Tracks (3)" button opening the same
// list in a popover where there is not, such as the inline editor's one-line toolbar.
export const CompactListsContext = createContext(false);

// One line naming an item: its file's name, its first text, its colour as a swatch, and its other short values.
function ItemSummary({ param, item, index }: { param: ListParameter; item: ListItem; index: number }) {
  const { files } = useContext(ProjectFilesContext);
  const parts: ReactNode[] = [];
  let swatch: string | undefined;
  for (const [key, field] of Object.entries(param.item)) {
    const value = item[key];
    if (field.type === 'color') swatch ??= String(value);
    else if (field.type === 'file') parts.push(value ? Object.hasOwn(files, String(value)) ? fileName(files[String(value)]) : 'Missing file' : 'No file');
    else if (field.type === 'enum') parts.push(field.labels?.[String(value)] ?? String(value));
    else if (field.type === 'string' && value) parts.push(String(value));
    else if ((field.type === 'number' || field.type === 'integer') && parts.length < 2) parts.push(String(value) + (field.unit ? ' ' + field.unit : ''));
  }
  const text = parts.slice(0, 2).join(' · ') || param.label + ' ' + (index + 1);
  return <>
    {swatch && <span className="pc-list-swatch" style={{ background: swatch }} aria-hidden="true" />}
    <span className="pc-list-name" title={text}>{text}</span>
  </>;
}

// A list parameter's control: its items as rows, collapsed to a summary and expanded to their fields on click, with
// add, duplicate, remove and reordering (drag, or the arrows). Every change applies the whole list at once, so it is
// one Undo step. New items get a stable ID, which reordering, Undo and drafts use instead of the position.
function ListControl({ param, value, apply, autoFocus }: { param: ListParameter; value: ListItem[]; apply: (value: ListItem[]) => void; autoFocus: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const atMax = param.max !== undefined && value.length >= param.max;
  const atMin = value.length <= (param.min ?? 0);
  const blank = () => Object.fromEntries(Object.entries(param.item).map(([key, field]) => [key, field.default]));
  const move = (id: string, to: number) => {
    const from = value.findIndex((item) => item.id === id);
    if (from < 0 || to < 0 || to >= value.length || from === to) return;
    const next = [...value];
    next.splice(to, 0, ...next.splice(from, 1));
    apply(next);
  };
  const add = () => {
    const id = newItemId(value);
    apply([...value, { id, ...blank() }]);
    setOpen(id);
  };
  return <div className="pc-list">
    {value.length > 0 && <ol className="pc-list-items" aria-label={param.label}>
      {value.map((item, index) => {
        const expanded = open === item.id;
        return <li key={item.id} className={'pc-list-item' + (dragging === item.id ? ' dragging' : '')} data-item={item.id}
          draggable={!expanded} onDragStart={(event) => { setDragging(item.id); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', item.id); }}
          onDragEnd={() => setDragging(null)} onDragOver={(event) => { if (dragging) event.preventDefault(); }}
          onDrop={(event) => { event.preventDefault(); if (dragging) move(dragging, index); setDragging(null); }}>
          <div className="pc-list-row">
            <button type="button" className="pc-list-summary" aria-expanded={expanded} data-autofocus={(autoFocus && index === 0) || undefined}
              onClick={() => setOpen(expanded ? null : item.id)}>
              <Icon name={expanded ? 'chevron' : 'next'} size={12} /><ItemSummary param={param} item={item} index={index} />
            </button>
            <span className="pc-list-actions">
              <button type="button" aria-label={'Move ' + param.label + ' ' + (index + 1) + ' up'} title="Move up" disabled={index === 0}
                onClick={() => move(item.id, index - 1)}><Icon name="up" size={12} /></button>
              <button type="button" aria-label={'Move ' + param.label + ' ' + (index + 1) + ' down'} title="Move down" disabled={index === value.length - 1}
                onClick={() => move(item.id, index + 1)}><Icon name="down" size={12} /></button>
              <button type="button" aria-label={'Duplicate ' + param.label + ' ' + (index + 1)} title="Duplicate" disabled={atMax}
                onClick={() => { const next = [...value]; next.splice(index + 1, 0, { ...item, id: newItemId(value) }); apply(next); }}><Icon name="duplicate" size={12} /></button>
              <button type="button" aria-label={'Remove ' + param.label + ' ' + (index + 1)} title="Remove" disabled={atMin}
                onClick={() => apply(value.filter(({ id }) => id !== item.id))}><Icon name="delete" size={12} /></button>
            </span>
          </div>
          {expanded && <div className="pc-list-fields">
            {Object.entries(param.item).map(([key, field]) => <Field key={key} param={field} value={item[key]}
              change={(next) => apply(value.map((other) => other.id === item.id ? { ...other, [key]: next as ListItem[string] } : other))} />)}
          </div>}
        </li>;
      })}
    </ol>}
    <button type="button" className="pc-list-add" disabled={atMax} onClick={add}><Icon name="add" size={12} /> Add</button>
    {param.max !== undefined && atMax && <small className="field-description">At most {param.max}.</small>}
  </div>;
}

// The list in a popover from a "Tracks (3)" button, for one-line toolbars. Escape or a click outside closes it.
function CompactList(props: { param: ListParameter; value: ListItem[]; apply: (value: ListItem[]) => void; autoFocus: boolean }) {
  const [open, setOpen] = useState(false);
  const holder = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!holder.current?.contains(event.target as Node)) setOpen(false); };
    // Escape closes the list first, not the editor around it, also when focus left the list (a button that was
    // clicked became disabled, such as moving the first item up).
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setOpen(false);
      holder.current?.querySelector<HTMLElement>('.pc-list-toggle')?.focus();
    };
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('keydown', escape, true);
    return () => { document.removeEventListener('pointerdown', outside, true); window.removeEventListener('keydown', escape, true); };
  }, [open]);
  return <div ref={holder} className="pc-list-compact">
    <button type="button" className="pc-list-toggle" aria-haspopup="dialog" aria-expanded={open} data-autofocus={props.autoFocus || undefined}
      onClick={() => setOpen(!open)}>{props.param.label} ({props.value.length})<Icon name="chevron" size={12} /></button>
    {open && <div className="pc-list-popover" role="dialog" aria-label={props.param.label}><ListControl {...props} autoFocus={false} /></div>}
  </div>;
}

// Chooses among the project's files with an accepted extension, adds a new one, or clears the assignment.
function FileControl({ param, value, apply, autoFocus }: {
  param: Extract<ScalarParameter, { type: 'file' }>; value: string; apply: (value: Value) => void; autoFocus: boolean;
}) {
  const { files, importFile } = useContext(ProjectFilesContext);
  const accepted = Object.entries(files).filter(([, path]) => param.accept.some((ext) => sourcePath(path).toLowerCase().endsWith(ext)));
  const missing = !!value && !Object.hasOwn(files, value);
  return <div className="box-photo pc-file">
    <span className="box-photo-empty content-file-icon" aria-hidden="true">File</span>
    <div className="box-photo-info">
      <span className="box-photo-name" title={value && files[value] ? sourcePath(files[value]) : undefined}>
        {missing ? 'Missing file' : value ? fileName(files[value]) : 'No file'}</span>
      <select className="box-photo-pick" aria-label={param.label} value={value} data-autofocus={autoFocus || undefined}
        onChange={(event) => {
          if (event.target.value === ':choose') void importFile?.(param.accept).then((id) => { if (id) apply(id); });
          else if (event.target.value) apply(event.target.value);
        }}>
        <option value={value}>{value ? 'Replace file…' : 'Choose…'}</option>
        {importFile && <option value=":choose">Choose file…</option>}
        {accepted.filter(([id]) => id !== value).map(([id, path]) => <option key={id} value={id}>{fileName(path)}</option>)}
      </select>
      {value && <button type="button" className="link" aria-label={'Remove ' + param.label} onClick={() => apply('')}>Remove</button>}
    </div>
  </div>;
}

// One control per parameter type, shared by the Inspector and the click-to-edit popover so a parameter looks and
// behaves the same in both. Discrete choices call `apply` at once. Typed values stay in `draft` until the caller
// applies them: on blur and Enter when `commitOnBlur` is set (Inspector), or when the popover closes.
export function ParamControl({ param, value, draft, setDraft, apply, autoFocus = false, commitOnBlur = false, compact = false }: {
  param: Parameter; value: Value; draft: Value | undefined; setDraft: (value: Value) => void; apply: (value: Value) => void;
  autoFocus?: boolean; commitOnBlur?: boolean; compact?: boolean;
}) {
  const compactLists = useContext(CompactListsContext);
  const shown = draft ?? value;
  const focusMark = autoFocus || undefined;
  if (param.type === 'list') {
    const items = resolveValue(param, shown) as ListItem[];
    return compact || compactLists ? <CompactList param={param} value={items} apply={apply} autoFocus={autoFocus} />
      : <ListControl param={param} value={items} apply={apply} autoFocus={autoFocus} />;
  }
  const commit = () => { if (draft !== undefined) apply(draft); };
  const blur = commitOnBlur ? commit : undefined;
  const enter = commitOnBlur ? (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Enter' && (event.currentTarget.tagName !== 'TEXTAREA' || event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      event.currentTarget.blur();
    }
  } : undefined;

  if (param.type === 'boolean') {
    return <label className="pc-switch"><input type="checkbox" checked={shown === true} data-autofocus={focusMark}
      onChange={(event) => apply(event.target.checked)} /> {param.label}</label>;
  }
  if (param.type === 'enum') {
    if (param.options.length > 4) {
      return <select aria-label={param.label} value={String(shown)} data-autofocus={focusMark} onChange={(event) => apply(event.target.value)}>
        {param.options.map((option) => <option key={option} value={option}>{param.labels?.[option] ?? option}</option>)}
      </select>;
    }
    return <div className="pc-segmented" role="radiogroup" aria-label={param.label}>
      {param.options.map((option, i) => <button key={option} type="button" role="radio" aria-checked={shown === option}
        data-autofocus={(autoFocus && (shown === option || (!param.options.includes(String(shown)) && i === 0))) || undefined}
        title={param.labels?.[option] ?? option} aria-label={param.labels?.[option] ?? option}
        onClick={() => apply(option)}>{compact && /^\d+$/.test(option) ? option : param.labels?.[option] ?? option}</button>)}
    </div>;
  }
  if (param.type === 'file') return <FileControl param={param} value={String(shown)} apply={apply} autoFocus={autoFocus} />;
  if (param.type === 'date') {
    const month = param.precision === 'month';
    return <input type={month ? 'month' : 'date'} aria-label={param.label} data-autofocus={focusMark}
      value={month ? String(shown).slice(0, 7) : String(shown)}
      min={param.min && (month ? param.min.slice(0, 7) : param.min)} max={param.max && (month ? param.max.slice(0, 7) : param.max)}
      onChange={(event) => { if (event.target.value) apply(month ? event.target.value + '-01' : event.target.value); }} />;
  }
  if (param.type === 'color') {
    return <div className="pc-row">
      <input type="color" aria-label={param.label} value={String(shown)} data-autofocus={focusMark}
        onChange={(event) => setDraft(event.target.value)} onBlur={commit} />
      <code>{String(shown)}</code>
    </div>;
  }
  if (param.type === 'integer' || param.type === 'number') {
    const step = param.step ?? (param.type === 'integer' ? 1 : 'any');
    const ranged = param.min !== undefined && param.max !== undefined;
    return <div className="pc-row">
      {ranged && <input type="range" aria-label={param.label + ' slider'} min={param.min} max={param.max}
        step={step === 'any' ? (param.max! - param.min!) / 100 : step} value={Number(shown)}
        onChange={(event) => setDraft(event.target.valueAsNumber)} onPointerUp={commit} onKeyUp={commit} />}
      <input type="number" className="pc-number" aria-label={param.label} value={Number.isFinite(Number(shown)) ? Number(shown) : ''}
        min={param.min} max={param.max} step={step} data-autofocus={focusMark}
        onChange={(event) => setDraft(event.target.valueAsNumber)} onBlur={blur} onKeyDown={enter} />
      {param.unit && <span className="pc-unit">{param.unit}</span>}
    </div>;
  }
  const text = String(shown);
  return <>
    {param.multiline
      ? <textarea rows={3} aria-label={param.label} value={text} maxLength={param.maxLength} placeholder={param.placeholder}
          data-autofocus={focusMark} onChange={(event) => setDraft(event.target.value)} onBlur={blur} onKeyDown={enter}
          onFocus={autoFocus ? (event) => event.target.select() : undefined} />
      : <input type="text" aria-label={param.label} value={text} maxLength={param.maxLength} placeholder={param.placeholder}
          data-autofocus={focusMark} onChange={(event) => setDraft(event.target.value)} onBlur={blur} onKeyDown={enter}
          onFocus={autoFocus ? (event) => event.target.select() : undefined} />}
    {param.maxLength !== undefined && draft !== undefined && <small className="pc-count">{text.length} / {param.maxLength}</small>}
  </>;
}

// A labelled parameter in the Inspector. Typed values apply on blur or Enter; invalid values are not saved.
// The field keeps its identity when the saved value changes, so typing is never lost to a save completing.
export function Field({ param, value, change, description, compact = false }: { param: Parameter; value: Value; change: (value: Value) => void; description?: string; compact?: boolean }) {
  const [draft, setDraft] = useState<Value>();
  const [invalid, setInvalid] = useState(false);
  const typing = useRef(false);
  // A new saved value replaces what the field shows, unless the user is typing in it. Lists compare by content, as
  // each render resolves them to a new array.
  useEffect(() => {
    if (typing.current) return;
    setDraft(undefined);
    setInvalid(false);
  }, [Array.isArray(value) ? JSON.stringify(value) : value]);
  function type(next: Value) {
    typing.current = true;
    setDraft(next);
  }
  // The applied value stays shown until the saved project arrives.
  function apply(next: Value) {
    typing.current = false;
    setDraft(next);
    const valid = isParameterValue(param, next);
    setInvalid(!valid);
    if (valid && !sameValue(next, value)) change(next);
  }
  const compactLists = useContext(CompactListsContext);
  // A list in a one-line place is its own "Tracks (n)" button, which names it.
  const listButton = param.type === 'list' && (compact || compactLists);
  return <div className={compact ? 'field compact-field' : 'field' + (param.type === 'list' ? ' field-list' : '')} title={compact ? param.label : undefined}>
    {!compact && !listButton && param.type !== 'boolean' && <span className="field-name">{param.label}</span>}
    <ParamControl param={param} value={value} draft={draft} setDraft={type} apply={apply} compact={compact} commitOnBlur />
    {description && <small className="field-description">{description}</small>}
    {invalid && <small className="error-text">Enter a value within the field’s limits.</small>}
  </div>;
}

export type FieldNode = Extract<ControlNode, { kind: 'field' }>;
// A control layout: fields, and titled groups of fields. `field` draws one field; its label is already applied to
// the parameter, so controls and their accessible names use it.
export function ControlList({ nodes, field }: { nodes: ControlNode[]; field: (node: FieldNode, param: Parameter) => ReactNode }) {
  return nodes.map((node, i) => node.kind === 'field'
    ? <Fragment key={node.key}>{field(node, node.label === node.param.label ? node.param : { ...node.param, label: node.label })}</Fragment>
    : <fieldset key={'group ' + i + ' ' + node.label} className="control-group">
      <legend>{node.label}</legend>
      {node.description && <p className="control-description">{node.description}</p>}
      <ControlList nodes={node.children} field={field} />
    </fieldset>);
}

// Generated controls for a scope, arranged by its `controls` (all parameters when absent). `exclude` leaves out
// parameters edited elsewhere, such as by a custom editor or on the page.
export function Fields({ schema, values, update, controls, exclude, compact = false }: {
  schema: Parameters; values: Values; update: (id: string, value: Value) => void; controls?: ControlItem[]; exclude?: readonly string[]; compact?: boolean;
}) {
  const current = resolveParams(schema, values);
  const nodes = controlLayout(schema, controls, current, exclude);
  const field = (inline: boolean) => (node: FieldNode, param: Parameter) =>
    <Field key={node.key} compact={inline} param={param} value={current[node.key]} description={node.description} change={(next) => update(node.key, next)} />;
  if (!compact) return <ControlList nodes={nodes} field={field(false)} />;
  const inline = nodes.filter((node) => node.kind === 'field' && compactParameter(node.param)).slice(0, 4);
  const overflow = nodes.filter((node) => !inline.includes(node));
  return <div className="compact-fields">
    <ControlList nodes={inline} field={field(true)} />
    {overflow.length > 0 && <details className="compact-overflow"><summary title="More settings" aria-label="More settings">⚙</summary>
      <div><ControlList nodes={overflow} field={field(false)} /></div></details>}
  </div>;
}
