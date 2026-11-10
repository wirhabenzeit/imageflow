import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { Values } from './project';
import type { Parameter, Parameters } from './parameters';
import { isParameterValue } from './parameters';
import { fileName } from './source-items';

type Value = Values[string];

// The project's files (ID → path in files/) for file parameters, and how to add one. Provided by the editor shell.
export const ProjectFilesContext = createContext<{
  files: Record<string, string>; importFile?: (accept: string[]) => Promise<string | undefined>;
}>({ files: {} });

// Chooses among the project's files with an accepted extension, adds a new one, or clears the assignment.
function FileControl({ param, value, apply, autoFocus }: {
  param: Extract<Parameter, { type: 'file' }>; value: string; apply: (value: Value) => void; autoFocus: boolean;
}) {
  const { files, importFile } = useContext(ProjectFilesContext);
  const accepted = Object.entries(files).filter(([, path]) => param.accept.some((ext) => path.toLowerCase().endsWith(ext)));
  const missing = !!value && !Object.hasOwn(files, value);
  return <div className="pc-row pc-file">
    <select aria-label={param.label} value={value} data-autofocus={autoFocus || undefined} onChange={(event) => apply(event.target.value)}>
      <option value="">None</option>
      {missing && <option value={value}>Missing file</option>}
      {value && !missing && !accepted.some(([id]) => id === value) && <option value={value}>{fileName(files[value])}</option>}
      {accepted.map(([id, path]) => <option key={id} value={id}>{fileName(path)}</option>)}
    </select>
    {importFile && <button type="button" onClick={() => {
      void importFile(param.accept).then((id) => { if (id) apply(id); });
    }}>Choose…</button>}
  </div>;
}

// One control per parameter type, shared by the Inspector and the click-to-edit popover so a parameter looks and
// behaves the same in both. Discrete choices call `apply` at once. Typed values stay in `draft` until the caller
// applies them: on blur and Enter when `commitOnBlur` is set (Inspector), or when the popover closes.
export function ParamControl({ param, value, draft, setDraft, apply, autoFocus = false, commitOnBlur = false }: {
  param: Parameter; value: Value; draft: Value | undefined; setDraft: (value: Value) => void; apply: (value: Value) => void;
  autoFocus?: boolean; commitOnBlur?: boolean;
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
        onClick={() => apply(option)}>{param.labels?.[option] ?? option}</button>)}
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
export function Field({ param, value, change }: { param: Parameter; value: Value; change: (value: Value) => void }) {
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
  return <div className="field">
    {param.type !== 'boolean' && <span className="field-name">{param.label}</span>}
    <ParamControl param={param} value={value} draft={draft} setDraft={type} apply={apply} commitOnBlur />
    {invalid && <small className="error-text">Enter a value within the field’s limits.</small>}
  </div>;
}

export function Fields({ schema, values, update }: { schema: Parameters; values: Values; update: (id: string, value: Value) => void }) {
  return Object.entries(schema).map(([id, param]) => {
    const value = isParameterValue(param, values[id]) ? values[id] : param.default;
    return <Field key={id} param={param} value={value} change={(next) => update(id, next)} />;
  });
}
