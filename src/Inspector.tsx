import { useEffect, useRef, useState } from 'react';
import { Field, Fields } from './Fields';
import type { BookGeometry, Issue, ProjectSummary, RenderStatus, TemplateInfo } from './desktop';
import { BookFrame } from './BookFrame';
import { revealIn } from './reveal';
import type { ProjectFiles, SpreadState, Values } from './project';
import type { Parameter, Parameters } from './parameters';
import { isParameterValue } from './parameters';
import { centered } from './spread';
import type { Placement } from './spread';
import { readEdit, resolveEditPath, switchDefinition, writeEdit } from './editing';
import type { EditTarget } from './editing';
import type { SourceUsage } from './editing';
import { SourceInspector } from './SourceInspector';
import type { SourceRef } from './source-items';

export type Edit = (files: ProjectFiles) => void;

// Shows the spread in every layout of the template, rendered by the template itself.
function LayoutPicker({ summary, spread, template, choose }: {
  summary: ProjectSummary; spread: SpreadState; template: TemplateInfo; choose: (definition: string) => void;
}) {
  const [geometry, setGeometry] = useState<BookGeometry>();
  return <div className={geometry ? 'layout-picker placed' : 'layout-picker'} role="radiogroup" aria-label="Layout"
    style={{ height: geometry?.height }}>
    {Object.entries(template.spreads).map(([id, item]) => {
      const rect = geometry?.sheets.find(({ spread: preview }) => preview === id);
      return <button key={id} type="button" role="radio" aria-checked={id === spread.definition} aria-label={item.label}
        title={item.label + (item.span === 'spread' ? '' : ' · single ' + item.span + ' page')} className="layout-option"
        style={rect ? { left: rect.x - 4, top: rect.y - 4, width: rect.width + 8, height: rect.height + 25 } : undefined}
        onClick={() => { if (id !== spread.definition) choose(id); }}>
        <span className="layout-option-label">{item.label}</span>
      </button>;
    })}
    <BookFrame project={summary.id} view="layouts" query={'spread=' + encodeURIComponent(spread.id)} title="Layout previews"
      onGeometry={setGeometry} />
  </div>;
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

// Shows either the selected spread or the selected source, never both.
export function Inspector({ summary, spread, source, template, render, usage, edit, importText, highlight, issues, check, checking,
  select, inspectSource, quickLook, focus, targets = [], adjustCrop }: {
  summary: ProjectSummary; spread: SpreadState; source?: SourceRef; template?: TemplateInfo; render?: RenderStatus; usage: SourceUsage;
  edit: (change: Edit, notice?: string) => void; importText: (box: string) => void;
  highlight: (id?: string) => void; issues: string; check?: BookCheck; checking: boolean; select: (spread: string) => void;
  inspectSource: (source: SourceRef) => void; quickLook: () => void; focus?: { box: string; at: number };
  targets?: BookGeometry['targets']; adjustCrop: (box: string) => void;
}) {
  const sections = useRef(new Map<string, HTMLElement>());
  const [flash, setFlash] = useState<string>();
  // A click on a box in the book scrolls to its section here.
  useEffect(() => {
    if (!focus || source) return;
    const section = sections.current.get(focus.box);
    if (!section) return;
    if (section instanceof HTMLDetailsElement) section.open = true;
    const panel = section.closest<HTMLElement>('.inspector');
    if (panel) revealIn(panel, section, true);
    setFlash(focus.box);
    const timer = setTimeout(() => setFlash(undefined), 900);
    return () => clearTimeout(timer);
  }, [focus, source]);
  const definition = template?.spreads[spread.definition];
  function changeSpread(update: (spread: SpreadState) => void, notice?: string) {
    edit(({ project }) => {
      const current = project.spreads.find(({ id }) => id === spread.id);
      if (current) update(current);
    }, notice);
  }
  const writable = !summary.readOnly;
  const archived = Object.keys(spread.archive);
  // Options a template attaches to a box or element with ctx.edit() appear in that box's or element's section,
  // matching the popover you get by clicking it. Spread options claimed this way leave the Spread section.
  const attached = new Map<string, EditTarget[]>();
  const claimed = new Set<string>();
  for (const { edits } of targets) {
    const owner = edits.map((path) => /^(boxes|elements)\.([^.]+)\./.exec(path)).find(Boolean);
    if (!owner) continue;
    const prefix = owner[0];
    const list = attached.get(prefix) ?? [];
    for (const path of edits) {
      const target = !path.startsWith(prefix) && resolveEditPath(template ?? { parameters: {}, spreads: {} }, spread.definition, path);
      if (!target || list.some((item) => item.path === path)) continue;
      list.push(target);
      if (target.scope === 'spread') claimed.add(target.key);
    }
    attached.set(prefix, list);
  }
  const extras = (prefix: string) => (attached.get(prefix) ?? []).map((target) => {
    const value = readEdit(summary.project, spread, target);
    return <Field key={target.path} param={target.param} value={value}
      change={(next) => edit(({ project }) => writeEdit(project, spread.id, target, next), target.param.label + ' updated')} />;
  });
  // Layout previews restart each text; say so when this spread shows a later part of a chained text.
  const continued = render?.state === 'ready' ? Object.entries(definition?.boxes ?? {})
    .filter(([id, box]) => box.type === 'markdown' && spread.boxes[id]?.text)
    .map(([id]) => render.flow[spread.id + ':' + id])
    .filter((position) => !!position && position.part > 1)
    .filter((position, index, all) => all.findIndex((other) => other.title === position.title) === index) : [];
  const spreadParameters = Object.fromEntries(Object.entries(definition?.parameters ?? {}).filter(([key]) => !claimed.has(key)));
  const header = <>
    <p className="eyebrow">Inspector</p>
    {issues && <div className="inspection-issues" role="alert">{issues}</div>}
    <CheckList check={check} checking={checking} spread={source ? '' : spread.id} select={select} />
  </>;
  if (source) {
    return <aside className="inspector" aria-label="Inspector">
      {header}
      <SourceInspector summary={summary} source={source} template={template} render={render} usage={usage} writable={writable}
        edit={edit} select={select} quickLook={quickLook} />
    </aside>;
  }
  return <aside className="inspector" aria-label="Inspector">
    {header}
    <fieldset disabled={!writable}>
      {template && <details open><summary>Spread</summary>
        <p className="field-label">Layout{definition ? ' · ' + definition.label : ''}</p>
        {!definition && <p className="error-text">This spread uses a layout the template no longer has: {spread.definition}.</p>}
        <LayoutPicker summary={summary} spread={spread} template={template} choose={(next) =>
          changeSpread((item) => switchDefinition(item, next, template), 'Layout changed. Previous settings are stored with the spread.')} />
        {continued.length > 0 && <p className="layout-note" role="note">
          Previews start text from the beginning; this spread shows {continued.map(({ title, part, parts }) =>
            (title ?? 'text') + ' part ' + part + ' of ' + parts).join(', ')}.</p>}
        {/* Keyed by spread: a rejected or unsaved draft must not carry over to another spread's field. */}
        {definition && <Fields key={spread.id} schema={spreadParameters} values={spread.params}
          update={(id, value) => changeSpread((item) => { item.params[id] = value; })} />}
        {archived.length > 0 && <p className="muted">Stored layouts · {archived.map((id) => template.spreads[id]?.label ?? id).join(', ')}</p>}
      </details>}
      {Object.entries(definition?.boxes ?? {}).map(([id, box]) => {
        const state = spread.boxes[id];
        const photoBox = box.type === 'photo';
        const assigned = photoBox ? state?.photo : state?.text;
        const choices: [string, string | undefined][] = Object.entries(summary.project.texts).map(([id, path]) => [id, path.split('/').pop()]);
        const position = render?.state === 'ready' ? render.flow[spread.id + ':' + id] : undefined;
        return <details key={spread.id + ':' + id} open onMouseEnter={() => highlight(id)} onMouseLeave={() => highlight()}
          ref={(element) => { if (element) sections.current.set(id, element); else sections.current.delete(id); }}
          className={flash === id ? 'flash' : undefined}>
          <summary>{box.label}</summary>
          {photoBox ? <div className="box-photo">
            {assigned && summary.photos[assigned]
              ? <button type="button" className="box-photo-thumb" title="Show photo" onClick={() => inspectSource({ kind: 'photo', id: assigned })}>
                  <img src={summary.photos[assigned]} alt="" />
                </button>
              : <span className="box-photo-empty">{assigned ? 'Missing' : 'Empty'}</span>}
            <div className="box-photo-info">
              <span className="box-photo-name">{assigned ? summary.photoIndex[assigned]?.title || assigned : 'No photo'}</span>
              <span className="muted">{assigned ? 'Drag another photo onto the box, or:' : 'Drag a photo onto the box, or:'}</span>
              {/* Keyboard path for assigning: the strip and canvas are drag-only. Choosing replaces the crop. */}
              <select className="box-photo-pick" aria-label={(assigned ? 'Replace photo in ' : 'Choose photo for ') + box.label} value=""
                onChange={(event) => {
                  const photo = event.target.value;
                  if (photo && photo !== assigned) changeSpread((item) => {
                    item.boxes[id] = { params: item.boxes[id]?.params ?? {}, photo };
                  }, (summary.photoIndex[photo]?.title || photo) + ' placed in ' + box.label);
                }}>
                <option value="">{assigned ? 'Replace photo…' : 'Choose photo…'}</option>
                {Object.entries(summary.photoIndex).filter(([photo]) => photo !== assigned).map(([photo, entry]) =>
                  <option key={photo} value={photo} disabled={!summary.photos[photo]}>
                    {(entry.title || entry.path.split('/').pop()) + (summary.photos[photo] ? '' : ' (missing)')}</option>)}
              </select>
              {assigned && <button type="button" className="link" onClick={() => changeSpread((item) => {
                if (item.boxes[id]) item.boxes[id] = { params: item.boxes[id].params };
              }, 'Photo removed from ' + box.label)}>Remove</button>}
            </div>
          </div> : <label className="field">Markdown
            <select aria-label={box.label + ' assignment'} value={assigned ?? ''} onChange={(event) => {
              const value = event.target.value;
              changeSpread((item) => {
                item.boxes[id] = { params: item.boxes[id]?.params ?? {},
                  ...(photoBox ? { photo: value || undefined } : { text: value || undefined }) };
              });
            }}>
              <option value="">Unassigned</option>
              {assigned && !choices.some(([id]) => id === assigned) && <option value={assigned}>Missing · {assigned}</option>}
              {choices.map(([id, label]) => <option value={id} key={id}>{label ?? id}</option>)}
            </select>
          </label>}
          {!photoBox && <div className="box-actions">
            {assigned && summary.project.texts[assigned] &&
              <button type="button" onClick={() => inspectSource({ kind: 'text', id: assigned })}>Show text</button>}
            <button onClick={() => importText(id)}>Import Markdown…</button>
          </div>}
          {position && <p className="muted">Flow {position.part} of {position.parts}</p>}
          {photoBox && assigned && <div className="crop-controls">
            <p className="muted">{state?.crop && state.crop.zoom !== 1 ? 'Zoomed ' + state.crop.zoom.toFixed(1) + '×' : 'Fills the frame'}
              {state?.crop ? ' · moved' : ''}</p>
            <div className="box-actions">
              <button type="button" onClick={() => adjustCrop(id)} title="Or double-click the photo">Adjust crop…</button>
              {state?.crop && <button type="button" onClick={() => changeSpread((item) => { if (item.boxes[id]) delete item.boxes[id].crop; },
                'Crop reset')}>Reset crop</button>}
            </div>
            <details className="crop-values"><summary>Crop values</summary>
              {([['centerX', 'Horizontal'], ['centerY', 'Vertical'], ['zoom', 'Zoom']] as const).map(([key, label]) =>
                <Field key={key}
                  param={{ type: 'number', label, default: centered[key], min: key === 'zoom' ? 1 : 0, max: key === 'zoom' ? 20 : 1, step: .01 }}
                  value={(state?.crop ?? centered)[key]}
                  change={(value) => changeSpread((item) => {
                    const box = item.boxes[id];
                    if (box?.photo) box.crop = { ...(box.crop ?? centered), [key]: value } as Placement;
                  })} />,
              )}
            </details>
          </div>}
          <Fields schema={box.parameters} values={state?.params ?? {}} update={(key, value) => changeSpread((item) => {
            item.boxes[id] ??= { params: {} };
            item.boxes[id].params[key] = value;
          })} />
          {extras('boxes.' + id + '.')}
        </details>;
      })}
      {Object.entries(definition?.elements ?? {}).map(([id, element]) => (
        <details key={spread.id + ':' + id} open onMouseEnter={() => highlight(id)} onMouseLeave={() => highlight()}
          ref={(element) => { if (element) sections.current.set(id, element); else sections.current.delete(id); }}
          className={flash === id ? 'flash' : undefined}>
          <summary>{element.label}</summary>
          <Fields schema={element.parameters} values={spread.elements[id]?.params ?? {}} update={(key, value) => changeSpread((item) => {
            item.elements[id] ??= { params: {} };
            item.elements[id].params[key] = value;
          })} />
          {extras('elements.' + id + '.')}
        </details>
      ))}
    </fieldset>
  </aside>;
}
