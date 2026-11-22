import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Icon } from './Icon';
import { ActionMenu, Submenu } from './ActionMenu';
import { Field } from './Fields';
import type { ProjectSummary } from './desktop';
import { boxBase } from './project';
import type { SpreadState } from './project';
import { textChoices, textMenuChoices } from './source-items';
import { photoName, sourceEntries } from './source-locations';
import { openMarkdown } from './markdown-open';
import type { SourceRef } from './source-items';
import { centered, placementIn, setPlacement } from './spread';

// The platform's part of a box editor: what fills the box. Photos and Markdown are ImageFlow's own content, so
// their assignment, crop and text flow are edited here, next to the template's box parameters, wherever the box
// is edited (its popover on the page, or the crop toolbar of a selected photo).

type Change<T = SpreadState> = (update: (spread: T) => void, notice?: string) => void;
type PhotoLayout = Pick<SpreadState, 'definition' | 'boxes'>;

// Choose, replace or remove the photo of a box from the keyboard; the canvas and photo strip are drag-only.
export function PhotoContent({ summary, spread, box, label, change, inspect, adjustCrop, values = false, compact = false, assigned: reassigned }: {
  summary: ProjectSummary; spread: PhotoLayout; box: string; label: string; change: Change<PhotoLayout>;
  // Called after the photo is replaced or removed, such as to end a selection that showed the old photo.
  assigned?: () => void;
  inspect?: (source: SourceRef) => void; adjustCrop?: () => void;
  // In the crop toolbar, where the photo itself is on screen: no thumbnail, name or crop summary.
  compact?: boolean;
  // The crop as numbers, for frames the template rotates, where dragging the photo is not available.
  values?: boolean;
}) {
  const state = spread.boxes[box];
  const assigned = state?.photo;
  const placement = placementIn(state, spread.definition);
  const ownCrop = !!state?.crops && Object.hasOwn(state.crops, spread.definition);
  const moved = placement.zoom !== 1 || placement.centerX !== centered.centerX || placement.centerY !== centered.centerY;
  function choosePhoto(photo: string) {
    if (!photo || photo === assigned) return;
    reassigned?.();
    change((item) => { item.boxes[box] = { ...boxBase(item.boxes[box]), photo }; },
      (summary.photoIndex[photo]?.title || photo) + ' placed in ' + label);
  }
  function removePhoto() {
    reassigned?.();
    change((item) => {
      if (item.boxes[box]) item.boxes[box] = boxBase(item.boxes[box]);
    }, 'Photo removed from ' + label);
  }
  const pick = <select className="box-photo-pick" aria-label={(assigned ? 'Replace photo in ' : 'Choose photo for ') + label} value=""
    onChange={(event) => choosePhoto(event.target.value)}>
    <option value={assigned ?? ''}>{assigned ? 'Replace photo…' : 'Choose photo…'}</option>
    {Object.entries(summary.photoIndex).filter(([photo]) => photo !== assigned).map(([photo, entry]) =>
      <option key={photo} value={photo} disabled={!summary.photos[photo]}>
        {photoName(summary, photo) + (summary.photos[photo] ? '' : ' (missing)')}</option>)}
  </select>;
  const remove = assigned && <button type="button" className="link" onClick={removePhoto}>Remove</button>;
  const fields = <div className="crop-values-fields">
    {([['centerX', 'Horizontal'], ['centerY', 'Vertical'], ['zoom', 'Zoom']] as const).map(([key, name]) =>
      <Field key={key}
        param={{ type: 'number', label: name, default: centered[key], min: key === 'zoom' ? 1 : 0, max: key === 'zoom' ? 20 : 1, step: .01 }}
        value={placement[key]}
        change={(value) => change((item) => {
          const state = item.boxes[box];
          if (state?.photo) setPlacement(state, item.definition, { ...placementIn(state, item.definition), [key]: value });
        })} />,
    )}
  </div>;
  const cropValues = values && assigned && <details className="crop-values"><summary>Crop values</summary>{fields}</details>;
  if (compact) return <CropPhotoActions summary={summary} assigned={assigned} label={label} choose={choosePhoto} remove={removePhoto}
    fields={values && assigned ? fields : undefined} />;
  return <div className="box-content">
    <div className="box-photo">
      {assigned && summary.photos[assigned]
        ? <button type="button" className="box-photo-thumb" title="Show photo" disabled={!inspect} onClick={() => inspect?.({ kind: 'photo', id: assigned })}>
            <img src={summary.photos[assigned]} alt="" />
          </button>
        : <span className="box-photo-empty">{assigned ? 'Missing' : 'Empty'}</span>}
      <div className="box-photo-info">
        <span className="box-photo-name">{assigned ? summary.photoIndex[assigned]?.title || assigned : 'No photo'}</span>
        {/* Choosing replaces the crop. */}
        {pick}
        {remove}
      </div>
    </div>
    {assigned && <div className="crop-controls">
      <p className="muted crop-summary">{[placement.zoom !== 1 ? 'Zoomed ' + placement.zoom.toFixed(1) + '×' : '',
        moved ? 'Moved' : '', moved && !ownCrop ? 'From another layout' : ''].filter(Boolean).join(' · ')}</p>
      <div className="box-actions">
        {adjustCrop && <button type="button" onClick={adjustCrop}>Adjust crop…</button>}
        <button type="button" disabled={!moved} onClick={() => change((item) => {
          if (item.boxes[box]?.photo) setPlacement(item.boxes[box], item.definition, centered);
        }, 'Crop reset')}>Reset crop</button>
      </div>
      {cropValues}
    </div>}
  </div>;
}

// Rare photo actions stay out of the crop toolbar. The small panels are its children, so clicking them keeps the
// crop session active; Escape closes the innermost panel before the canvas handles it.
function CropPhotoActions({ summary, assigned, label, choose, remove, fields }: {
  summary: ProjectSummary; assigned?: string; label: string; choose: (photo: string) => void; remove: () => void; fields?: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<'photos' | 'values'>();
  function close() {
    setOpen(undefined);
    root.current?.querySelector<HTMLElement>('.action-menu-trigger')?.focus();
  }
  useEffect(() => {
    if (!open) return;
    (panel.current?.querySelector<HTMLElement>('.crop-photo-choices button:not(:disabled), input') ?? panel.current?.querySelector('button'))?.focus();
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(undefined); };
    // Numeric fields blur after Enter; Escape must still close the panel when focus has returned to the page.
    const keys = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', keys, true);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', keys, true); };
  }, [open]);
  return <div ref={root} className="crop-actions">
    <ActionMenu className="crop-more" label={<><Icon name="cog" size={16} /><span className="visually-hidden">More photo actions</span></>}>
      <button type="button" onClick={() => setOpen('photos')}>Replace photo…</button>
      <button type="button" disabled={!assigned} onClick={remove}>Remove photo</button>
      {fields && <button type="button" onClick={() => setOpen('values')}>Crop values…</button>}
    </ActionMenu>
    {open && <div ref={panel} className="crop-action-panel" role="dialog" aria-label={open === 'photos' ? 'Replace photo in ' + label : 'Crop values'}>
      <header><strong>{open === 'photos' ? 'Replace photo' : 'Crop values'}</strong><button type="button" aria-label="Close photo actions" onClick={close}>×</button></header>
      {open === 'values' ? fields : <div className="crop-photo-choices" onKeyDown={(event) => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
        const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const step = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : event.key === 'ArrowUp' ? -2 : 2;
        buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, at + step))]?.focus();
      }}>
        {Object.entries(summary.photoIndex).filter(([photo]) => photo !== assigned).map(([photo, entry]) =>
          <button type="button" key={photo} data-photo={photo} disabled={!summary.photos[photo]} onClick={() => choose(photo)}>
            {summary.photos[photo] && <img src={summary.photos[photo]} alt="" loading="lazy" />}
            <span>{entry.title || photo}{!summary.photos[photo] && ' (missing)'}</span>
          </button>)}
        {Object.keys(summary.photoIndex).filter((photo) => photo !== assigned).length === 0 && <p className="muted">Import another photo to replace this one.</p>}
      </div>}
    </div>}
  </div>;
}

// Assign a Markdown source to a box, import one, or show it; and where the box sits in its text's flow.
export function TextContent({ summary, spread, box, label, change, importText, inspect, flow, compact = false, quickLook, failure }: {
  summary: ProjectSummary; spread: SpreadState; box: string; label: string; change: Change;
  compact?: boolean; quickLook?: (source: SourceRef) => void; importText: () => void; inspect?: (source: SourceRef) => void; flow?: { part: number; parts: number };
  failure?: (message: string) => void;
}) {
  const assigned = spread.boxes[box]?.text;
  const choices = textChoices(summary);
  const name = assigned ? choices.find(([id]) => id === assigned)?.[1] ?? 'Missing text' : 'No text';
  async function editText(id: string) {
    const api = window.imageflow;
    if (!api) return;
    try { const result = await openMarkdown(api, { id }); if ('error' in result) failure?.(result.error); }
    catch { failure?.('Could not open the Markdown editor.'); }
  }
  function assign(value?: string) {
    change((item) => {
      item.boxes[box] = { ...boxBase(item.boxes[box]), ...(value ? { text: value } : {}) };
    }, value ? (choices.find(([id]) => id === value)?.[1] ?? value) + ' placed in ' + label : 'Text removed from ' + label);
  }
  // The text's own editor first, and the book's other texts in a submenu: dragging a text onto the box is the usual way
  // to place one (F-043). Quick Look and the default app are offered only for a text linked from outside the book.
  if (compact) {
    const readable = !!assigned && summary.texts[assigned] !== undefined;
    const linked = !!assigned && sourceEntries(summary).some((entry) => entry.key === 'markdown:' + assigned && entry.kind === 'markdown' && entry.linked);
    const others = textMenuChoices(summary).filter(({ id }) => id !== assigned);
    return <ActionMenu className="text-source-menu" label={<>Aa <span>{name}</span>{flow && flow.parts > 1 && <small>{flow.part}/{flow.parts}</small>}<Icon name="chevron" /></>}>
      {assigned && <button disabled={!readable} onClick={() => void editText(assigned)}>Edit Text…</button>}
      <Submenu label={assigned ? 'Replace Text' : 'Choose Text'}>
        {others.map(({ id, title, file }) => <button key={id} title={file} onClick={() => assign(id)}>{title}</button>)}
        {others.length > 0 && <hr />}
        <button onClick={importText}>Choose Markdown File…</button>
      </Submenu>
      {linked && <>
        <hr />
        <button disabled={!readable || !quickLook} onClick={() => assigned && quickLook?.({ kind: 'text', id: assigned })}>Show in Quick Look</button>
        <button disabled={!readable} onClick={() => assigned && void window.imageflow?.sourceAction({ action: 'open', key: 'markdown:' + assigned })}>Edit in Default App</button>
      </>}
      <button disabled={!assigned} onClick={() => assigned && void window.imageflow?.sourceAction({ action: 'reveal', key: 'markdown:' + assigned })}>Show in Finder</button>
      <hr /><button disabled={!assigned} onClick={() => assign()}>Remove Text</button>
    </ActionMenu>;
  }
  return <div className="box-content">
    <div className="box-photo box-text">
      <button type="button" className="box-photo-thumb content-file-icon" title="Show text" aria-label={'Show text in ' + label}
        disabled={!assigned || !summary.project.texts[assigned] || !inspect}
        onClick={() => assigned && inspect?.({ kind: 'text', id: assigned })}>Aa</button>
      <div className="box-photo-info">
        <span className="box-photo-name" title={name}>{name}{flow && flow.parts > 1 && <small className="text-flow muted">{flow.part} of {flow.parts}</small>}</span>
        <select className="box-photo-pick" aria-label={label + ' assignment'} value={assigned ?? ''} onChange={(event) => {
          if (event.target.value === ':import') importText();
          else if (event.target.value) assign(event.target.value);
        }}>
          <option value={assigned ?? ''}>{assigned ? 'Replace text…' : 'Choose text…'}</option>
          <option value=":import">Choose Markdown file…</option>
          {choices.filter(([id]) => id !== assigned).map(([id, name]) => <option value={id} key={id}>{name}</option>)}
        </select>
        {assigned && <button type="button" className="link" onClick={() => assign()}>Remove</button>}

      </div>
    </div>
  </div>;
}
