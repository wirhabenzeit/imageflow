import { sourcePath } from './source-locations';
import { useEffect, useRef, useState } from 'react';
import { Fields } from './Fields';
import type { BookGeometry, Issue, ProjectSummary, RenderStatus, TemplateInfo } from './desktop';
import { BookFrame } from './BookFrame';
import { revealIn } from './reveal';
import type { ProjectFiles, SpreadState } from './project';
import { boxLabel, describeLayoutChange, discardContent, keptElements, keptOutside, layoutPreviews, pickerFamily, planLayoutChange, switchLayout } from './layouts';
import { keptMime, photoMime, sourceTitle, textMime } from './source-items';
import { readEdit, resolveEditPath } from './editing';
import type { SourceUsage } from './editing';
import { SourceInspector } from './SourceInspector';
import type { SourceRef } from './source-items';

export type Edit = (files: ProjectFiles) => void;

// Shows the spread in each layout it can switch to, rendered by the template itself. Pointing at a layout says what
// switching would carry over, keep and fall back on. A layout family with its own picker is one preview, named after
// the family, which opens the picker; the variants of other families are listed next to each other.
function LayoutPicker({ summary, spread, template, choose, openPicker }: {
  summary: ProjectSummary; spread: SpreadState; template: TemplateInfo; choose: (definition: string) => void;
  openPicker: (family: string, layout: string) => void;
}) {
  const [geometry, setGeometry] = useState<BookGeometry>();
  const [pointed, setPointed] = useState<string>();
  const families = template.layoutFamilies ?? {};
  const choices = layoutPreviews(template.spreads, spread.definition, families);
  const familyOf = (id: string) => pickerFamily(template.spreads, id, families);
  const name = (id: string) => familyOf(id) ? families[familyOf(id)!].label : template.spreads[id].label;
  // The retained preview and its hit targets must describe the same set of layouts until the next frame is ready.
  const displayed = geometry ? geometry.sheets.map(({ spread }) => spread).filter((id) => Object.hasOwn(template.spreads, id)) : choices;
  const pending = !!geometry && (displayed.length !== choices.length || displayed.some((id, i) => id !== choices[i]));
  const describe = (id: string) => id === spread.definition ? 'Current layout · ' + template.spreads[id].label
    : familyOf(id) ? 'Choose a variant'
    : describeLayoutChange(planLayoutChange(spread, id, template.spreads));
  const shown = !pending && pointed && choices.includes(pointed) ? pointed : undefined;
  return <div className="layout-picker-shell">
    <div className={geometry ? 'layout-picker placed' : 'layout-picker'} role="radiogroup" aria-label="Layout" aria-busy={pending || undefined}
      style={{ height: geometry?.height }} onMouseLeave={() => setPointed(undefined)}>
      {displayed.map((id) => {
        const item = template.spreads[id];
        const rect = geometry?.sheets.find(({ spread: preview }) => preview === id);
        const family = familyOf(id);
        const grouped = !family && item.family !== undefined && Object.hasOwn(families, item.family) ? families[item.family].label : undefined;
        return <button key={id} type="button" role="radio" disabled={pending} aria-checked={id === spread.definition} aria-label={name(id)}
          aria-describedby={shown === id ? 'layout-consequence' : undefined} aria-haspopup={family ? 'dialog' : undefined}
          title={(grouped ? grouped + ' · ' : '') + name(id) + (item.span === 'spread' ? '' : ' · single ' + item.span + ' page')}
          className={'layout-option' + (family ? ' layout-family' : '')}
          style={rect ? { left: rect.x - 4, top: rect.y - 4, width: rect.width + 8, height: rect.height + 25 } : undefined}
          onMouseEnter={() => setPointed(id)} onFocus={() => setPointed(id)} onBlur={() => setPointed(undefined)}
          onClick={() => { if (family) openPicker(family, id); else if (id !== spread.definition) choose(id); }}>
          <span className="layout-option-label">{name(id)}{family ? '…' : ''}</span>
        </button>;
      })}
      <BookFrame project={summary.id} view="layouts" query={'spread=' + encodeURIComponent(spread.id)} title="Layout previews"
        onGeometry={setGeometry} />
    </div>
    <p id="layout-consequence" className="layout-consequence" role="tooltip" hidden={!shown}>
      {shown ? name(shown) + ' · ' + describe(shown) : '\u00a0'}</p>
  </div>;
}

// Content the spread keeps for other layouts. Placing an item moves it into a box of this layout (swapping with what
// is there); dragging it onto a box does the same. Discard removes it from the spread; the source stays.
function KeptContent({ summary, spread, template, kept, label, settings, writable, place, discard }: {
  summary: ProjectSummary; spread: SpreadState; template: TemplateInfo; kept: ReturnType<typeof keptOutside>; label: string;
  settings: string[]; writable: boolean; place: (from: string, to: string) => void; discard: (box: string, name: string) => void;
}) {
  const layout = template.spreads[spread.definition];
  const elementName = (id: string) => Object.values(template.spreads).find((item) => Object.hasOwn(item.elements, id))?.elements[id].label ?? id;
  return <details open className="kept-content">
    <summary>Saved outside this layout{label ? ' · ' + label : ''}</summary>
    {kept.length > 0 && <p className="muted">Layouts with these boxes show them again. Drag one onto a box, or place it:</p>}
    <ul className="kept-list">
      {kept.map((item) => {
        const name = sourceTitle(summary, item.kind, item.source);
        const from = boxLabel(template.spreads, item.id);
        const targets = Object.entries(layout?.boxes ?? {}).filter(([, box]) => (box.type === 'photo') === (item.kind === 'photo'));
        const occupant = (id: string) => {
          const box = spread.boxes[id];
          const source = item.kind === 'photo' ? box?.photo : box?.text;
          return source && sourceTitle(summary, item.kind, source);
        };
        return <li key={item.id} className="kept-item" draggable={writable} onDragStart={(event) => {
          event.dataTransfer.setData(item.kind === 'photo' ? photoMime : textMime, item.source);
          event.dataTransfer.setData(keptMime, JSON.stringify({ spread: spread.id, box: item.id }));
        }}>
          {item.kind === 'photo' && summary.photos[item.source]
            ? <img className="kept-thumb" src={summary.photos[item.source]} alt="" draggable={false} />
            : <span className="kept-thumb kept-thumb-empty">{item.kind === 'photo' ? 'Missing' : 'Text'}</span>}
          <div className="kept-info">
            <span className="kept-name">{name}</span>
            <span className="muted">{from ? from.box + ' · ' + from.layout : 'Box ' + item.id}</span>
            <div className="kept-actions">
              <select aria-label={'Place ' + name + ' in'} value="" disabled={!targets.length}
                onChange={(event) => { if (event.target.value) place(item.id, event.target.value); }}>
                <option value="">{targets.length ? 'Place in…' : 'No ' + (item.kind === 'photo' ? 'photo' : 'text') + ' box in this layout'}</option>
                {targets.map(([id, box]) => <option key={id} value={id}>
                  {box.label + (occupant(id) ? ' · swap with ' + occupant(id) : '')}</option>)}
              </select>
              <button type="button" className="link" aria-label={'Discard ' + name} onClick={() => discard(item.id, name)}>Discard</button>
            </div>
          </div>
        </li>;
      })}
    </ul>
    {settings.length > 0 && <p className="muted">Settings kept for {settings.map(elementName).join(', ')}.</p>}
  </details>;
}

// What a spread shows, for the list of its boxes and elements: a photo's title, a text's file, an element's editor.
function contentState(summary: ProjectSummary, spread: SpreadState, id: string, kind: 'photo' | 'markdown' | 'element', template: TemplateInfo,
  flow?: { part: number; parts: number }) {
  if (kind === 'element') {
    const editor = template.spreads[spread.definition]?.elements[id]?.editor;
    return editor ? (editor.label ?? 'Custom editor') : 'Settings';
  }
  const state = spread.boxes[id];
  if (kind === 'photo') return state?.photo ? summary.photoIndex[state.photo]?.title || (summary.photos[state.photo] ? state.photo : 'Missing photo') : 'Empty';
  if (!state?.text) return 'No text';
  const name = summary.project.texts[state.text] ? sourcePath(summary.project.texts[state.text]).split('/').pop() : 'Missing text';
  return flow && flow.parts > 1 ? name + ' · ' + flow.part + ' of ' + flow.parts : name;
}

// Shows either the selected spread or the selected source, never both. For a spread: its layout, the settings the
// page does not already edit, content kept for other layouts, and a list of its boxes and elements. Boxes and
// elements are edited where they are on the page; the list opens the same editors, also for empty, hidden or
// overlapping ones, and from the keyboard.
export function Inspector({ summary, spread, source, template, render, usage, edit, highlight, issues,
  select, quickLook, focus, targets = [], open, openTarget, place, openPicker }: {
  summary: ProjectSummary; spread: SpreadState; source?: SourceRef; template?: TemplateInfo; render?: RenderStatus; usage: SourceUsage;
  edit: (change: Edit, notice?: string | (() => string)) => void;
  highlight: (id?: string) => void; issues: string; select: (spread: string) => void;
  quickLook: () => void; focus?: { box: string; at: number };
  targets?: BookGeometry['targets']; open: (owner: { type: 'photo' | 'markdown' | 'element'; id: string }) => void;
  openTarget: (target: BookGeometry['targets'][number]) => void;
  place: (from: string, to: string) => void;
  openPicker: (family: string, layout: string) => void;
}) {
  const items = useRef(new Map<string, HTMLElement>());
  const [flash, setFlash] = useState<string>();
  // A click on a box in the book points out its entry here.
  useEffect(() => {
    if (!focus || source) return;
    const item = items.current.get(focus.box);
    if (!item) return;
    const panel = item.closest<HTMLElement>('.inspector');
    if (panel) revealIn(panel, item, true);
    setFlash(focus.box);
    const timer = setTimeout(() => setFlash(undefined), 900);
    return () => clearTimeout(timer);
  }, [focus, source]);
  const definition = template?.spreads[spread.definition];
  const currentFamily = template && pickerFamily(template.spreads, spread.definition, template.layoutFamilies);
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
  const keptSettings = template ? keptElements(spread, template.spreads) : [];
  // Spread settings the page edits, through ctx.Text, ctx.edit or a box or element marked with them, are edited
  // there and left out here. An element with its own editor opens that editor, which edits only the element, so
  // settings marked on it stay here.
  // Spread parameters edited elsewhere: by a marked node on the page (other than one inside an element with its own
  // editor, which opens that editor instead), or by an element editor that declares them.
  const claimed = new Set([...targets.filter(({ owner }) => !(owner?.type === 'element' && definition?.elements[owner.id]?.editor))
    .flatMap(({ edits }) => edits.filter((path) => !path.includes('.'))),
  ...Object.values(definition?.elements ?? {}).flatMap(({ editor }) => editor?.spread ?? [])]);
  // Marked nodes that are not a box or element, such as a ctx.Text heading, in reading order: listed with the
  // boxes and elements, so every editor on the page can be opened from the keyboard.
  const marked = template ? targets.filter((target) => !target.owner)
    .filter((target, i, all) => all.findIndex((other) => other.edits.join(' ') === target.edits.join(' ')) === i)
    .sort((a, b) => Math.abs(a.y - b.y) > 4 ? a.y - b.y : a.x - b.x)
    .flatMap((target) => {
      const fields = target.edits.map((path) => resolveEditPath(template, spread.definition, path)).filter((field) => !!field);
      if (!fields.length) return [];
      const value = readEdit(summary.project, spread, fields[0]);
      return [{ target, label: fields.map(({ param }) => param.label).join(', '), value: typeof value === 'string' ? value : String(value ?? '') }];
    }) : [];
  const flow = render?.state === 'ready' ? render.flow : undefined;
  const contents = definition ? [
    ...Object.entries(definition.boxes).map(([id, box]) => ({ id, kind: box.type, label: box.label })),
    ...Object.entries(definition.elements).map(([id, element]) => ({ id, kind: 'element' as const, label: element.label })),
  ] : [];
  const header = <>
    <p className="eyebrow">Inspector</p>
    {issues && <div className="inspection-issues" role="alert">{issues}</div>}
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
        <div className="layout-heading">
          <p className="field-label">Layout{definition ? ' · ' + definition.label : ''}</p>
          {currentFamily && <button type="button" className="link" aria-haspopup="dialog"
            onClick={() => openPicker(currentFamily, spread.definition)}>
            {(template.layoutFamilies?.[currentFamily]?.picker?.label ?? 'Change') + '…'}</button>}
        </div>
        {!definition && <p className="error-text">This spread uses a layout the template no longer has: {spread.definition}.</p>}
        <LayoutPicker summary={summary} spread={spread} template={template} openPicker={openPicker} choose={(next) => {
          // Planned against the project the switch applies to, which may be newer than this render.
          let consequence = '';
          changeSpread((item) => {
            consequence = describeLayoutChange(planLayoutChange(item, next, template.spreads));
            switchLayout(item, next, template.spreads);
          }, () => template.spreads[next].label + ' · ' + consequence);
        }} />
        {/* Keyed by spread: a rejected or unsaved draft must not carry over to another spread's field. */}
        {definition && <Fields key={spread.id} schema={definition.parameters} controls={definition.controls} exclude={[...claimed]}
          values={spread.params} update={(id, value) => changeSpread((item) => { item.params[id] = value; }, definition.parameters[id].label + ' updated')} />}
      </details>}
      {template && (kept.length > 0 || keptSettings.length > 0) && <KeptContent summary={summary} spread={spread} template={template}
        kept={kept} label={keptLabel} settings={keptSettings} writable={writable} place={place}
        discard={(box, name) => changeSpread((item) => discardContent(item, box), name + ' removed from this spread')} />}
      {template && (contents.length > 0 || marked.length > 0) && <section className="spread-contents" aria-label="On this spread">
        <p className="field-label">On this spread</p>
        <ul className="content-list">
          {marked.map(({ target, label, value }) => <li key={spread.id + ':' + target.edits.join(' ')}>
            <button type="button" className="content-item" aria-label={'Edit ' + label} onClick={() => openTarget(target)}>
              <span className="content-thumb content-kind" aria-hidden="true">Aa</span>
              <span className="content-text">
                <span className="content-label">{label}</span>
                <span className="content-state muted">{value || 'Empty'}</span>
              </span>
            </button>
          </li>)}
          {contents.map(({ id, kind, label }) => {
            const photo = kind === 'photo' ? spread.boxes[id]?.photo : undefined;
            return <li key={spread.id + ':' + id}>
              <button type="button" className={'content-item' + (flash === id ? ' flash' : '')} aria-label={'Edit ' + label}
                ref={(element) => { if (element) items.current.set(id, element); else items.current.delete(id); }}
                onMouseEnter={() => highlight(id)} onMouseLeave={() => highlight()} onFocus={() => highlight(id)} onBlur={() => highlight()}
                onClick={() => open({ type: kind, id })}>
                {photo && summary.photos[photo]
                  ? <img className="content-thumb" src={summary.photos[photo]} alt="" />
                  : <span className="content-thumb content-kind" aria-hidden="true">{kind === 'photo' ? 'Photo' : kind === 'markdown' ? 'Text' : 'Item'}</span>}
                <span className="content-text">
                  <span className="content-label">{label}</span>
                  <span className="content-state muted">{contentState(summary, spread, id, kind, template, flow?.[spread.id + ':' + id])}</span>
                </span>
              </button>
            </li>;
          })}
        </ul>
      </section>}
    </fieldset>
  </aside>;
}
