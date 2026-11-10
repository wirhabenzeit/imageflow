import { useEffect, useRef, useState } from 'react';
import { Field, Fields } from './Fields';
import type { BookGeometry, Issue, ProjectSummary, RenderStatus, TemplateInfo } from './desktop';
import { BookFrame } from './BookFrame';
import { revealIn } from './reveal';
import type { ProjectFiles, SpreadState, Values } from './project';
import type { Parameter, Parameters } from './parameters';
import { isParameterValue } from './parameters';
import { centered, placementIn, setPlacement } from './spread';
import { readEdit, resolveEditPath, writeEdit } from './editing';
import { describeLayoutChange, keptOutside, layoutChoices, planLayoutChange, switchLayout } from './layouts';
import type { EditTarget } from './editing';
import type { SourceUsage } from './editing';
import { SourceInspector } from './SourceInspector';
import type { SourceRef } from './source-items';

export type Edit = (files: ProjectFiles) => void;

// Shows the spread in each layout it can switch to, rendered by the template itself. Pointing at a layout says what
// switching would carry over, keep and fall back on.
function LayoutPicker({ summary, spread, template, choose }: {
  summary: ProjectSummary; spread: SpreadState; template: TemplateInfo; choose: (definition: string) => void;
}) {
  const [geometry, setGeometry] = useState<BookGeometry>();
  const [pointed, setPointed] = useState<string>();
  const choices = layoutChoices(template.spreads, spread.definition);
  const describe = (id: string) => id === spread.definition ? 'Current layout' : describeLayoutChange(planLayoutChange(spread, id, template.spreads));
  const shown = pointed && choices.includes(pointed) ? pointed : undefined;
  return <>
    <div className={geometry ? 'layout-picker placed' : 'layout-picker'} role="radiogroup" aria-label="Layout"
      aria-describedby="layout-consequence" style={{ height: geometry?.height }} onMouseLeave={() => setPointed(undefined)}>
      {choices.map((id) => {
        const item = template.spreads[id];
        const rect = geometry?.sheets.find(({ spread: preview }) => preview === id);
        return <button key={id} type="button" role="radio" aria-checked={id === spread.definition} aria-label={item.label}
          title={item.label + (item.span === 'spread' ? '' : ' · single ' + item.span + ' page')} className="layout-option"
          style={rect ? { left: rect.x - 4, top: rect.y - 4, width: rect.width + 8, height: rect.height + 25 } : undefined}
          onMouseEnter={() => setPointed(id)} onFocus={() => setPointed(id)} onBlur={() => setPointed(undefined)}
          onClick={() => { if (id !== spread.definition) choose(id); }}>
          <span className="layout-option-label">{item.label}</span>
        </button>;
      })}
      <BookFrame project={summary.id} view="layouts" query={'spread=' + encodeURIComponent(spread.id)} title="Layout previews"
        onGeometry={setGeometry} />
    </div>
    <p id="layout-consequence" className="layout-consequence muted" aria-live="polite">
      {shown ? template.spreads[shown].label + ' · ' + describe(shown) : '\u00a0'}</p>
  </>;
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
  select, inspectSource, quickLook, focus, targets = [], adjustCrop, openEditor }: {
  summary: ProjectSummary; spread: SpreadState; source?: SourceRef; template?: TemplateInfo; render?: RenderStatus; usage: SourceUsage;
  edit: (change: Edit, notice?: string | (() => string)) => void; importText: (box: string) => void;
  highlight: (id?: string) => void; issues: string; check?: BookCheck; checking: boolean; select: (spread: string) => void;
  inspectSource: (source: SourceRef) => void; quickLook: () => void; focus?: { box: string; at: number };
  targets?: BookGeometry['targets']; adjustCrop: (box: string) => void; openEditor: (element: string) => void;
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
  function changeSpread(update: (spread: SpreadState) => void, notice?: string | (() => string)) {
    edit(({ project }) => {
      const current = project.spreads.find(({ id }) => id === spread.id);
      if (current) update(current);
    }, notice);
  }
  const writable = !summary.readOnly;
  // Content the spread keeps for other layouts; switching back, or to another layout with these boxes, shows it.
  const kept = template ? keptOutside(spread, template.spreads) : [];
  const keptLabel = [
    ['photo', 'photo', 'photos'], ['text', 'text', 'texts'],
  ].map(([kind, one, many]) => {
    const n = kept.filter((item) => item.kind === kind).length;
    return n ? n + ' ' + (n === 1 ? one : many) : '';
  }).filter(Boolean).join(', ');
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
        <LayoutPicker summary={summary} spread={spread} template={template} choose={(next) => {
          // Planned against the project the switch applies to, which may be newer than this render.
          let consequence = '';
          changeSpread((item) => {
            consequence = describeLayoutChange(planLayoutChange(item, next, template.spreads));
            switchLayout(item, next, template.spreads);
          }, () => template.spreads[next].label + ' · ' + consequence);
        }} />
        {continued.length > 0 && <p className="layout-note" role="note">
          Previews start text from the beginning; this spread shows {continued.map(({ title, part, parts }) =>
            (title ?? 'text') + ' part ' + part + ' of ' + parts).join(', ')}.</p>}
        {/* Keyed by spread: a rejected or unsaved draft must not carry over to another spread's field. */}
        {definition && <Fields key={spread.id} schema={spreadParameters} values={spread.params}
          update={(id, value) => changeSpread((item) => { item.params[id] = value; })} />}
        {keptLabel && <p className="muted">Saved outside this layout · {keptLabel}</p>}
      </details>}
      {Object.entries(definition?.boxes ?? {}).map(([id, box]) => {
        const state = spread.boxes[id];
        const photoBox = box.type === 'photo';
        const assigned = photoBox ? state?.photo : state?.text;
        const choices: [string, string | undefined][] = Object.entries(summary.project.texts).map(([id, path]) => [id, path.split('/').pop()]);
        const position = render?.state === 'ready' ? render.flow[spread.id + ':' + id] : undefined;
        // The crop this layout shows: its own, or a fill around the focus of a crop set in another layout.
        const placement = placementIn(state, spread.definition);
        const ownCrop = !!state?.crops && Object.hasOwn(state.crops, spread.definition);
        const moved = placement.zoom !== 1 || placement.centerX !== centered.centerX || placement.centerY !== centered.centerY;
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
            <p className="muted">{placement.zoom !== 1 ? 'Zoomed ' + placement.zoom.toFixed(1) + '×' : 'Fills the frame'}
              {moved ? ' · moved' : ''}{moved && !ownCrop ? ' · from another layout' : ''}</p>
            <div className="box-actions">
              <button type="button" onClick={() => adjustCrop(id)} title="Or double-click the photo">Adjust crop…</button>
              {moved && <button type="button" onClick={() => changeSpread((item) => {
                if (item.boxes[id]?.photo) setPlacement(item.boxes[id], item.definition, centered);
              }, 'Crop reset')}>Reset crop</button>}
            </div>
            <details className="crop-values"><summary>Crop values</summary>
              {([['centerX', 'Horizontal'], ['centerY', 'Vertical'], ['zoom', 'Zoom']] as const).map(([key, label]) =>
                <Field key={key}
                  param={{ type: 'number', label, default: centered[key], min: key === 'zoom' ? 1 : 0, max: key === 'zoom' ? 20 : 1, step: .01 }}
                  value={placement[key]}
                  change={(value) => changeSpread((item) => {
                    const box = item.boxes[id];
                    if (box?.photo) setPlacement(box, item.definition, { ...placementIn(box, item.definition), [key]: value });
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
          {element.editor && <div className="box-actions">
            <button type="button" onClick={() => openEditor(id)}>{(element.editor.label ?? 'Open editor') + '…'}</button>
          </div>}
          {/* Parameters a template-supplied editor owns are edited there, not with generated controls. */}
          <Fields schema={Object.fromEntries(Object.entries(element.parameters).filter(([key]) => !element.editor?.parameters.includes(key)))}
            values={spread.elements[id]?.params ?? {}} update={(key, value) => changeSpread((item) => {
            item.elements[id] ??= { params: {} };
            item.elements[id].params[key] = value;
          })} />
          {extras('elements.' + id + '.')}
        </details>
      ))}
    </fieldset>
  </aside>;
}
