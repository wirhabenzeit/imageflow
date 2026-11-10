import { useState } from 'react';
import type { Issue, ProjectSummary, RenderStatus, TemplateInfo } from './desktop';
import type { ProjectFiles, SpreadState, Values } from './project';
import type { Parameter, Parameters } from './parameters';
import { isParameterValue } from './parameters';
import { centered } from './spread';
import type { Placement } from './spread';
import { switchDefinition } from './editing';

export type Edit = (files: ProjectFiles) => void;

function Field({ param, value, change }: { param: Parameter; value: Values[string]; change: (value: Values[string]) => void }) {
  const [invalid, setInvalid] = useState(false);
  function commit(next: Values[string]) {
    const valid = isParameterValue(param, next);
    setInvalid(!valid);
    if (valid && next !== value) change(next);
  }
  if (param.type === 'boolean') {
    return <label className="field checkbox"><input type="checkbox" defaultChecked={value === true}
      onChange={(event) => commit(event.target.checked)} /> {param.label}</label>;
  }
  if (param.type === 'enum') {
    return <label className="field">{param.label}<select defaultValue={String(value)} onChange={(event) => commit(event.target.value)}>
      {param.options.map((option) => <option key={option} value={option}>{param.labels?.[option] ?? option}</option>)}
    </select></label>;
  }
  const numeric = param.type === 'number' || param.type === 'integer';
  return <label className="field">
    <span>{param.label}{numeric && param.unit ? ' (' + param.unit + ')' : ''}</span>
    {param.type === 'string' && param.multiline
      ? <textarea rows={3} defaultValue={String(value)} maxLength={param.maxLength} placeholder={param.placeholder}
          onBlur={(event) => commit(event.target.value)} />
      : <input type={numeric ? 'number' : param.type === 'string' ? 'text' : param.type}
          defaultValue={String(value)} aria-invalid={invalid || undefined}
          min={numeric || param.type === 'date' ? param.min : undefined}
          max={numeric || param.type === 'date' ? param.max : undefined}
          step={numeric ? param.step ?? (param.type === 'integer' ? 1 : 'any') : undefined}
          maxLength={param.type === 'string' ? param.maxLength : undefined}
          placeholder={param.type === 'string' ? param.placeholder : undefined}
          onChange={param.type === 'color' ? (event) => commit(event.target.value) : undefined}
          onBlur={(event) => commit(numeric ? event.target.valueAsNumber : event.target.value)} />}
    {invalid && <small className="error-text">Enter a value within the field’s limits.</small>}
  </label>;
}

function Fields({ schema, values, update }: { schema: Parameters; values: Values; update: (id: string, value: Values[string]) => void }) {
  return Object.entries(schema).map(([id, param]) => {
    const value = isParameterValue(param, values[id]) ? values[id] : param.default;
    return <Field key={id + ':' + String(value)} param={param} value={value} change={(next) => update(id, next)} />;
  });
}

export type BookCheck = { id: string; errors: Issue[]; warnings: Issue[] };

function CheckList({ check, checking, spread, select }: {
  check?: BookCheck; checking: boolean; spread: string; select: (spread: string) => void;
}) {
  const items = [
    ...(check?.errors ?? []).map((issue) => ({ issue, level: 'error' })),
    ...(check?.warnings ?? []).map((issue) => ({ issue, level: 'warning' })),
  ];
  const count = (n: number, word: string) => n + ' ' + word + (n === 1 ? '' : 's');
  const label = !check ? 'Checking book…' : !items.length ? 'No issues' :
    [check.errors.length && count(check.errors.length, 'error'), check.warnings.length && count(check.warnings.length, 'warning')]
      .filter(Boolean).join(' · ');
  return <details className={'book-check-list' + (checking ? ' book-check-stale' : '')} open={!!check?.errors.length || undefined}>
    <summary>Book check · {label}{check && checking ? ' · updating…' : ''}</summary>
    {items.length > 0 && <ul>{items.map(({ issue, level }, i) => <li key={i} className={'issue-' + level +
      (issue.spread === spread ? ' issue-current' : '')}>
      {issue.spread && issue.where ? <button type="button" className="link" onClick={() => select(issue.spread!)}>{issue.where}</button> : null}
      {issue.spread && issue.where ? ' · ' : ''}{issue.message}
    </li>)}</ul>}
  </details>;
}

export function Inspector({ summary, spread, template, render, photo, edit, importText, highlight, issues, check, checking, select }: {
  summary: ProjectSummary; spread: SpreadState; template?: TemplateInfo; render?: RenderStatus;
  photo?: string; edit: (change: Edit, notice?: string) => void; importText: (box: string) => void;
  highlight: (id?: string) => void; issues: string; check?: BookCheck; checking: boolean; select: (spread: string) => void;
}) {
  const definition = template?.spreads[spread.definition];
  function changeSpread(update: (spread: SpreadState) => void, notice?: string) {
    edit(({ project }) => {
      const current = project.spreads.find(({ id }) => id === spread.id);
      if (current) update(current);
    }, notice);
  }
  const writable = !summary.readOnly;
  const archived = Object.keys(spread.archive);
  const selectedPhoto = photo ? summary.photoIndex[photo] : undefined;
  return <aside className="inspector" aria-label="Inspector">
    <p className="eyebrow">Inspector</p>
    {issues && <div className="inspection-issues" role="alert">{issues}</div>}
    <CheckList check={check} checking={checking} spread={spread.id} select={select} />
    <fieldset disabled={!writable}>
      <details open><summary>Document</summary>
        <label className="field">Book title<input key={summary.project.title} defaultValue={summary.project.title}
          onBlur={(event) => {
            const title = event.target.value.trim();
            if (title && title !== summary.project.title) edit(({ project }) => { project.title = title; });
          }} /></label>
        {template && <Fields schema={template.parameters} values={summary.project.params}
          update={(id, value) => edit(({ project }) => { project.params[id] = value; })} />}
      </details>
      {template && <details open><summary>Spread</summary>
        <label className="field">Layout<select aria-label="Layout" value={spread.definition} onChange={(event) => {
          const next = event.target.value;
          changeSpread((item) => switchDefinition(item, next, template), 'Layout changed. Previous settings are stored with the spread.');
        }}>
          {!definition && <option value={spread.definition}>{spread.definition} (missing)</option>}
          {Object.entries(template.spreads).map(([id, item]) => <option key={id} value={id}>{item.label}</option>)}
        </select></label>
        {definition && <Fields schema={definition.parameters} values={spread.params}
          update={(id, value) => changeSpread((item) => { item.params[id] = value; })} />}
        {archived.length > 0 && <p className="muted">Stored layouts · {archived.map((id) => template.spreads[id]?.label ?? id).join(', ')}</p>}
      </details>}
      {Object.entries(definition?.boxes ?? {}).map(([id, box]) => {
        const state = spread.boxes[id];
        const photoBox = box.type === 'photo';
        const assigned = photoBox ? state?.photo : state?.text;
        const choices: [string, string | undefined][] = photoBox ? Object.entries(summary.photoIndex).map(([id, entry]) => [id, entry.title || entry.path.split('/').pop()]) :
          Object.entries(summary.project.texts).map(([id, path]) => [id, path.split('/').pop()]);
        const position = render?.state === 'ready' ? render.flow[spread.id + ':' + id] : undefined;
        return <details key={spread.id + ':' + id} open onMouseEnter={() => highlight(id)} onMouseLeave={() => highlight()}>
          <summary>{box.label}</summary>
          <label className="field">{photoBox ? 'Photo' : 'Markdown'}
            <select aria-label={box.label + ' assignment'} value={assigned ?? ''} onChange={(event) => {
              const value = event.target.value;
              changeSpread((item) => {
                item.boxes[id] = { params: item.boxes[id]?.params ?? {},
                  ...(photoBox ? { photo: value || undefined } : { text: value || undefined }) };
              });
            }}>
              <option value="">Unassigned</option>
              {assigned && !choices.some(([id]) => id === assigned) && <option value={assigned}>Missing · {assigned}</option>}
              {choices.map(([id, label]) => <option value={id} key={id}>{label ?? id}{photoBox && !summary.photos[id] ? ' (missing)' : ''}</option>)}
            </select>
          </label>
          {!photoBox && <button onClick={() => importText(id)}>Import Markdown…</button>}
          {position && <p className="muted">Flow {position.part} of {position.parts}</p>}
          {photoBox && assigned && <div className="crop-controls">
            {([['centerX', 'Horizontal'], ['centerY', 'Vertical'], ['zoom', 'Zoom']] as const).map(([key, label]) =>
              <Field key={key + ':' + (state?.crop ?? centered)[key]}
                param={{ type: 'number', label, default: centered[key], min: key === 'zoom' ? 1 : 0, max: key === 'zoom' ? 20 : 1, step: .05 }}
                value={(state?.crop ?? centered)[key]}
                change={(value) => changeSpread((item) => {
                  const box = item.boxes[id];
                  if (box?.photo) box.crop = { ...(box.crop ?? centered), [key]: value } as Placement;
                })} />,
            )}
            <button onClick={() => changeSpread((item) => { if (item.boxes[id]) delete item.boxes[id].crop; })}>Reset crop</button>
          </div>}
          <Fields schema={box.parameters} values={state?.params ?? {}} update={(key, value) => changeSpread((item) => {
            item.boxes[id] ??= { params: {} };
            item.boxes[id].params[key] = value;
          })} />
        </details>;
      })}
      {Object.entries(definition?.elements ?? {}).map(([id, element]) => (
        <details key={spread.id + ':' + id} open onMouseEnter={() => highlight(id)} onMouseLeave={() => highlight()}>
          <summary>{element.label}</summary>
          <Fields schema={element.parameters} values={spread.elements[id]?.params ?? {}} update={(key, value) => changeSpread((item) => {
            item.elements[id] ??= { params: {} };
            item.elements[id].params[key] = value;
          })} />
        </details>
      ))}
      {photo && selectedPhoto && <details open>
        <summary>Photo details</summary>
        <p className="muted">{selectedPhoto.path.split('/').pop()}</p>
        {([['title', 'Photo title'], ['caption', 'Caption'], ['credit', 'Credit'], ['altText', 'Alt text']] as const).map(([key, label]) =>
          <Field key={photo + ':' + key + ':' + selectedPhoto[key]} param={{ type: 'string', label, default: '', multiline: key === 'caption' }}
            value={selectedPhoto[key] ?? ''} change={(value) => edit(({ photoIndex }) => {
              if (photoIndex[photo]) photoIndex[photo][key] = String(value);
            })} />)}
      </details>}
    </fieldset>
  </aside>;
}
