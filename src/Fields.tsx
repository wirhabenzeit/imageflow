import { createContext, Fragment, useContext, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { compactParameter } from './compact-controls';
import { controlLayout } from './controls';
import type { ControlItem, ControlNode } from './controls';
import type { Values } from './project';
import type { Parameter, Parameters } from './parameters';
import { isParameterValue } from './parameters';
import { sourcePath } from './source-locations';
import type { SourceReference, ImportMode } from './source-locations';
import { fileName } from './source-items';

type Value = Values[string];

// The project's files (ID → owned path or linked reference) for file parameters, and how to add one. Provided by the editor shell.
export const ProjectFilesContext = createContext<{
  files: Record<string, SourceReference>; importFile?: (accept: string[], mode?: ImportMode) => Promise<string | undefined>;
}>({ files: {} });

// Chooses among the project's files with an accepted extension, adds a new one, or clears the assignment.
function FileControl({ param, value, apply, autoFocus }: {
  param: Extract<Parameter, { type: 'file' }>; value: string; apply: (value: Value) => void; autoFocus: boolean;
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
  const shown = draft ?? value;
  const focusMark = autoFocus || undefined;
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
  // A new saved value replaces what the field shows, unless the user is typing in it.
  useEffect(() => {
    if (typing.current) return;
    setDraft(undefined);
    setInvalid(false);
  }, [value]);
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
    if (valid && next !== value) change(next);
  }
  return <div className={compact ? 'field compact-field' : 'field'} title={compact ? param.label : undefined}>
    {!compact && param.type !== 'boolean' && <span className="field-name">{param.label}</span>}
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

// The resolved value of every parameter: the saved one when it is allowed, else the default.
const resolved = (schema: Parameters, values: Values) => Object.fromEntries(Object.entries(schema).map(([id, param]) =>
  [id, isParameterValue(param, values[id]) ? values[id] : param.default]));

// Generated controls for a scope, arranged by its `controls` (all parameters when absent). `exclude` leaves out
// parameters edited elsewhere, such as by a custom editor or on the page.
export function Fields({ schema, values, update, controls, exclude, compact = false }: {
  schema: Parameters; values: Values; update: (id: string, value: Value) => void; controls?: ControlItem[]; exclude?: readonly string[]; compact?: boolean;
}) {
  const current = resolved(schema, values);
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
