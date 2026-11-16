import type { InspectorTarget } from './inspector-targets';
import { plainFormatted } from './formatted-text';
import { assetMenuState } from './asset-menu';
import { sourceFileName } from './source-locations';
import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { Fields } from './Fields';
import { Icon } from './Icon';
import type { BookGeometry, ProjectSummary, RenderStatus, TemplateInfo } from './desktop';
import { layoutPreviewKey } from './layout-preview';
import { BookFrame } from './BookFrame';
import { revealIn } from './reveal';
import type { PageSide, ProjectFiles, SpreadState } from './project';
import { scopeSpread } from './project';
import { hasFacingPages, spanRequiredAt } from './format';
import { discardKeptContent, keptItems, layoutMime, locationLabel, shownContentTargets } from './page-editor';
import type { ContentTarget, KeptItem } from './page-editor';
import { boxLabel, describeLayoutChange, editorLayoutChoices, editorLayoutPreviews, editorLayoutTarget, keptElements, pickerFamily, planLayoutChange, switchLayout } from './layouts';
import { keptMime, photoMime, sourceTitle, textMime } from './source-items';
import { readEdit, resolveEditPath } from './editing';
import type { SourceUsage } from './editing';
import { SourceInspector } from './SourceInspector';
import type { SourceRef } from './source-items';

export type Edit = (files: ProjectFiles) => void;

// Shows the spread in each layout it can switch to, rendered by the template itself. A family is one preview, named after
// the family; its controls appear with the selected spread's parameters below the complete layout browser.
function LayoutPicker({ summary, spread, template, page, choose }: {
  summary: ProjectSummary; spread: SpreadState; template: TemplateInfo; page?: PageSide; choose: (definition?: string) => void;
}) {
  const families = template.layoutFamilies ?? {};
  const position = { index: summary.project.spreads.findIndex(({ id }) => id === spread.id), count: summary.project.spreads.length };
  const choices = editorLayoutPreviews(template.spreads, spread, families, template.format, position, page, true);
  const facing = hasFacingPages(template.format);
  const required = spanRequiredAt(position.index, position.count, template.format);
  const current = spread.split ? scopeSpread(spread, page ?? 'left')?.definition : spread.definition;
  const consequence = (id?: string) => {
    try { return describeLayoutChange(planLayoutChange(spread, editorLayoutTarget(template.spreads, id, template.format, position, page), template.spreads)); }
    catch { return ''; }
  };
  const blank = facing && required === 'spread';
  const ordered = [...choices].sort((a, b) => Number(template.spreads[b].span === 'spread') - Number(template.spreads[a].span === 'spread'));
  return <LayoutGrid summary={summary} spread={spread} template={template} page={page}
    choices={[...ordered, ...(blank ? ['__blank__'] : [])]} current={current} choose={choose} consequence={consequence} />;
}

function LayoutGrid({ summary, spread, template, page, choices, current, choose, consequence }: {
  summary: ProjectSummary; spread: SpreadState; template: TemplateInfo; page?: PageSide;
  choices: string[]; current?: string; choose: (definition?: string) => void; consequence: (id?: string) => string;
}) {
  const key = layoutPreviewKey(summary, template, spread) + ':' + (page ?? '');
  const [preview, setPreview] = useState(() => ({ key, project: summary.id }));
  if (preview.key !== key) setPreview({ key, project: summary.id });
  const [geometry, setGeometry] = useState<BookGeometry>();
  const families = template.layoutFamilies ?? {};
  const allowed = new Set(editorLayoutChoices(template.spreads, spread, template.format,
    { index: summary.project.spreads.findIndex(item => item.id === spread.id), count: summary.project.spreads.length }, page));
  const familyOf = (id: string) => pickerFamily(template.spreads, id, families);
  const name = (id: string) => id === '__blank__' ? 'Blank page' : familyOf(id) ? families[familyOf(id)!].label : template.spreads[id].label;
  const displayed = geometry ? geometry.sheets.map(({ spread }) => spread).filter(id => id === '__blank__' || Object.hasOwn(template.spreads, id)) : choices;
  const pending = !!geometry && (displayed.length !== choices.length || displayed.some((id, i) => id !== choices[i]));
  return <div className={geometry ? 'layout-picker placed' : 'layout-picker'} role="radiogroup" aria-label="Layout"
    aria-busy={pending || undefined} style={{ height: geometry?.height }}>
    {displayed.map((id) => {
      const blank = id === '__blank__';
      const item = blank ? undefined : template.spreads[id];
      const rect = geometry?.sheets.find(({ spread: preview }) => preview === id);
      const family = blank ? undefined : familyOf(id);
      const checked = blank ? !!spread.split && !current : id === current && (item?.span === 'page' || !spread.split);
      const unavailable = !blank && !allowed.has(id);
      const description = unavailable ? 'Available on the ' + item?.sides?.join(' or ') + ' page' : consequence(blank ? undefined : id);
      return <button key={id} type="button" role="radio" disabled={pending || unavailable} aria-checked={checked} aria-label={name(id)}
        aria-description={description || undefined}
        draggable={!pending && !unavailable} onDragStart={(event) => event.dataTransfer.setData(layoutMime, id)}
        className={'layout-option' + (family ? ' layout-family' : '') + (blank ? ' layout-blank' : '') + (unavailable ? ' layout-unavailable' : '')}
        style={rect ? { left: rect.x - 4, top: rect.y - 4, width: rect.width + 8, height: rect.height + 25 }
          : { gridColumn: item?.span === 'spread' ? 'span 2' : 'span 1' }}
        onClick={() => { if (!checked) choose(blank ? undefined : id); }}>
        <span className="layout-option-label"><span className="layout-option-name">{blank ? 'Blank' : name(id)}</span>
          {family && <span className="layout-option-variants" aria-hidden="true"><Icon name="cog" size={16} /></span>}
        </span>
      </button>;
    })}
    <BookFrame project={preview.project} view="layouts"
      query={'spread=' + encodeURIComponent(spread.id) + (page ? '&page=' + page : '')}
      title="Layout previews" onGeometry={setGeometry} />
  </div>;
}

function KeptContent({ summary, spread, template, kept, label, settings, writable, place, discard, expanded, setExpanded, replaced = false }: {
  summary: ProjectSummary; spread: SpreadState; template: TemplateInfo; kept: KeptItem[]; label: string;
  expanded: boolean; setExpanded: (open: boolean) => void; replaced?: boolean;
  settings: string[]; writable: boolean; place: (from: KeptItem, to: ContentTarget) => void; discard: (item: KeptItem, name: string) => void;
}) {
  const elementName = (id: string) => Object.values(template.spreads).find((item) => Object.hasOwn(item.elements, id))?.elements[id].label ?? id;
  return <details open={expanded} className="kept-content" onToggle={(event) => setExpanded(event.currentTarget.open)}>
    <summary>{replaced ? 'Replaced' : 'Set aside'}{label ? ' · ' + label : ''}</summary>
    <ul className="kept-list">{kept.map((item) => {
      const name = sourceTitle(summary, item.kind, item.source);
      const from = boxLabel(template.spreads, item.id);
      const targets = shownContentTargets(spread, template.spreads, item.kind);
      return <li key={item.location + ':' + item.id + ':' + (item.displaced ?? '')} className="kept-item" draggable={writable}
        onDragStart={(event) => {
          event.dataTransfer.setData(item.kind === 'photo' ? photoMime : textMime, item.source);
          event.dataTransfer.setData(keptMime, JSON.stringify({ spread: spread.id, box: item.id, ...item }));
        }}>
        {item.kind === 'photo' && summary.photos[item.source] ? <img className="kept-thumb" src={summary.photos[item.source]} alt="" draggable={false} />
          : <span className="kept-thumb kept-thumb-empty">{item.kind === 'photo' ? 'Missing' : 'Text'}</span>}
        <div className="kept-info"><span className="kept-name">{name}</span>
          <span className="muted">{(from ? from.box : 'Box ' + item.id) + ' · ' + locationLabel(item.location)}</span>
          <div className="kept-actions"><select aria-label={'Place ' + name + ' in'} value="" disabled={!targets.length}
            onChange={(event) => { const target = targets[Number(event.target.value)]; if (event.target.value && target) place(item, target); }}>
            <option value="">{targets.length ? 'Place in…' : 'No ' + (item.kind === 'photo' ? 'photo' : 'text') + ' box in this layout'}</option>
            {targets.map((target, i) => <option key={(target.page ?? 'spread') + ':' + target.box} value={String(i)}>
              {(target.page ? target.page + ' page · ' : '') + target.label + (target.source ? ' · swap with ' + sourceTitle(summary, item.kind, target.source) : '')}
            </option>)}
          </select><button type="button" className="link" aria-label={'Discard ' + name} onClick={() => discard(item, name)}>Discard</button></div>
        </div>
      </li>;
    })}</ul>
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
  const name = summary.project.texts[state.text] ? sourceFileName(summary.project.texts[state.text]) : 'Missing text';
  return flow && flow.parts > 1 ? name + ' · ' + flow.part + ' of ' + flow.parts : name;
}

// Shows either the selected spread or the selected source, never both. For a spread: its layout, the settings the
// page does not already edit, content kept for other layouts, and a list of its boxes and elements. Boxes and
// elements are edited where they are on the page; the list opens the same editors, also for empty, hidden or
// overlapping ones, and from the keyboard.
export function Inspector({ summary, spread, source, template, render, usage, edit, highlight,
  select, quickLook, focus, targets = [], open, openTarget, place, familyPicker, writable, page, chooseLayout }: {
  summary: ProjectSummary; writable: boolean; spread: SpreadState; page?: PageSide; source?: SourceRef; template?: TemplateInfo; render?: RenderStatus; usage: SourceUsage;
  edit: (change: Edit, notice?: string | (() => string)) => void;
  highlight: (id?: string) => void; select: (spread: string) => void;
  quickLook: () => void; focus?: { box: string; at: number };
  targets?: InspectorTarget[]; open: (owner: { type: 'photo' | 'markdown' | 'element'; id: string }) => void;
  openTarget: (target: InspectorTarget) => void;
  place: (from: KeptItem, to: ContentTarget) => void;
  chooseLayout?: (definition?: string) => void;
  familyPicker?: ReactNode;
}) {
  const items = useRef(new Map<string, HTMLElement>());
  const [flash, setFlash] = useState<string>();
  const [keptOpen, setKeptOpen] = useState(false);
  const [replacedOpen, setReplacedOpen] = useState(false);
  const sheet = spread;
  const selectedPage = sheet.split ? page ?? 'left' : undefined;
  spread = scopeSpread(sheet, selectedPage) ?? { id: sheet.id, definition: '', params: {}, boxes: {}, elements: {} };
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
  function changeSpread(update: (spread: SpreadState) => void, notice?: string | (() => string), allowPages = false) {
    edit(({ project }) => {
      const current = project.spreads.find(({ id }) => id === spread.id);
      if (!current) return;
      if (!allowPages && (!!current.split !== !!sheet.split || (scopeSpread(current, selectedPage)?.definition ?? '') !== spread.definition)) return;
      const selected = allowPages ? current : current.split ? scopeSpread(current, selectedPage) : current;
      if (selected) update(selected);
    }, notice);
  }
  const allKept = template ? keptItems(sheet, template.spreads) : [];
  const kept = allKept.filter((item) => !item.replaced);
  const replaced = allKept.filter((item) => item.replaced);
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
    .sort((a, b) => a.order - b.order)
    .flatMap((target) => {
      const fields = target.edits.map((path) => resolveEditPath(template, spread.definition, path, selectedPage)).filter((field) => !!field);
      if (!fields.length) return [];
      const value = readEdit(summary.project, sheet, fields[0]);
      const text = typeof value === 'string' ? value : String(value ?? '');
      const param = fields[0].param;
      // A formatted string is listed by its visible text, without markers.
      return [{ target, label: fields.map(({ param }) => param.label).join(', '), value: param.type === 'string' && param.markdown === 'inline' ? plainFormatted(text) : text }];
    }) : [];
  const flow = render?.state === 'ready' ? render.flow : undefined;
  const contents = definition ? [
    ...Object.entries(definition.boxes).map(([id, box]) => ({ id, kind: box.type, label: box.label })),
    ...Object.entries(definition.elements).map(([id, element]) => ({ id, kind: 'element' as const, label: element.label })),
  ] : [];
  const header = <>
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
      {template && <details open><summary onKeyDown={(event) => { if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
        event.preventDefault(); event.currentTarget.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
      } }} onContextMenu={async (event) => {
        event.preventDefault();
        if (!definition || !Object.keys(definition.parameters).length) return;
        const result = await window.imageflow?.showContextMenu(['reset-defaults'], assetMenuState(false));
        if (result?.command === 'reset-defaults') changeSpread((item) => { for (const id of Object.keys(definition.parameters)) delete item.params[id]; }, 'Spread settings reset');
      }}>Templates</summary>
        {!definition && spread.definition && <p className="error-text">This spread uses a layout the template no longer has: {spread.definition}.</p>}
        <LayoutPicker summary={summary} spread={sheet} template={template} page={page} choose={chooseLayout ?? ((next) => {
          let consequence = '';
          changeSpread((item) => { consequence = describeLayoutChange(switchLayout(item,
            editorLayoutTarget(template.spreads, next, template.format, { index: summary.project.spreads.findIndex(({ id }) => id === item.id), count: summary.project.spreads.length }, page), template.spreads));
          }, () => consequence, true);
        })} />
        {familyPicker}
        {/* Keyed by spread: a rejected or unsaved draft must not carry over to another spread's field. */}
        <fieldset>
          {definition && <Fields key={spread.id + ':' + (selectedPage ?? '') + ':' + spread.definition} schema={definition.parameters} controls={definition.controls} exclude={[...claimed]}
            values={spread.params} update={(id, value) => changeSpread((item) => { item.params[id] = value; }, definition.parameters[id].label + ' updated')} />}
        </fieldset>
      </details>}
      {template && (contents.length > 0 || marked.length > 0) && <section className="spread-contents" aria-label={selectedPage ? 'On this page' : 'On this spread'}>
        <p className="field-label">{selectedPage ? 'On this page' : 'On this spread'}</p>
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
                  <span className="content-state muted">{contentState(summary, spread, id, kind, template, flow?.[spread.id + ':' + (selectedPage ? selectedPage + ':' : '') + id])}</span>
                </span>
              </button>
            </li>;
          })}
        </ul>
      </section>}
      {template && (kept.length > 0 || keptSettings.length > 0) && <KeptContent summary={summary} spread={sheet} template={template}
        expanded={keptOpen} setExpanded={setKeptOpen} kept={kept} label={keptLabel} settings={keptSettings} writable={writable} place={place}
        discard={(item, name) => changeSpread((current) => discardKeptContent(current, item), name + ' removed from this spread', true)} />}
      {template && replaced.length > 0 && <KeptContent summary={summary} spread={sheet} template={template}
        expanded={replacedOpen} setExpanded={setReplacedOpen} kept={replaced} label={String(replaced.length)} settings={[]} writable={writable} place={place} replaced
        discard={(item, name) => changeSpread((current) => discardKeptContent(current, item), name + ' discarded', true)} />}

    </fieldset>
  </aside>;
}
