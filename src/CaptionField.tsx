import { useEffect, useId, useRef, useState } from 'react';
import type { ProjectSummary } from './desktop';
import type { SourceUsage } from './editing';
import type { Edit } from './Inspector';
import { resolveValue } from './parameters';
import type { Parameters } from './parameters';
import type { ProjectFiles, SpreadState } from './project';
import { photoName } from './source-locations';

// Editing a placed photo's caption where the photo is (UI-014). The caption is the photo's own, stored with it and shown
// wherever it is placed; whether a box prints it is the template's, through a yes/no box parameter that may say so.

/** What a photo box needs to edit the caption of its photo. */
export type CaptionEditing = { edit: (change: Edit, notice?: string) => void; usage: SourceUsage };

/** The box parameter that says whether the photo's caption shows (`p.boolean({ shows: 'caption' })`), if one does. */
export const captionSwitch = (parameters: Parameters | undefined) =>
  Object.keys(parameters ?? {}).find((key) => { const param = parameters![key]; return param.type === 'boolean' && param.shows === 'caption'; });

const shownCaption = (files: Pick<ProjectSummary, 'photoIndex' | 'photoProvided'>, photo: string) =>
  files.photoIndex[photo]?.caption ?? files.photoProvided?.[photo]?.caption ?? '';

/**
 * Saves a caption. The first caption of a photo switches on the box it was entered at, as a switch that is off prints
 * nothing; changing one that was there leaves a switch the user turned off alone. `find` is the box as it is when the
 * edit applies, or undefined when it no longer holds the photo.
 */
export function captionEdit(summary: Pick<ProjectSummary, 'photoIndex' | 'photoProvided'>, photo: string, value: string,
  toggle?: { parameters: Parameters; find: (files: ProjectFiles) => SpreadState['boxes'][string] | undefined }): Edit {
  const first = !shownCaption(summary, photo).trim() && !!value.trim();
  return (files) => {
    const entry = files.photoIndex[photo];
    if (!entry) return;
    entry.caption = value;
    const key = captionSwitch(toggle?.parameters);
    const box = first && key !== undefined ? toggle!.find(files) : undefined;
    if (box && box.photo === photo && resolveValue(toggle!.parameters[key!], box.params[key!]) !== true) box.params[key!] = true;
  };
}

// The caption as typed, saved on leaving the field, on ⌘Return, and when the field goes away, such as when a click
// elsewhere deselects the photo; Escape keeps the saved caption.
export function CaptionField({ summary, photo, label = 'Caption', usage, save, autoFocus = false, done }: {
  summary: ProjectSummary; photo: string; label?: string; usage: SourceUsage; save: (caption: string) => void; autoFocus?: boolean; done?: () => void;
}) {
  const id = useId();
  const saved = summary.photoIndex[photo]?.caption ?? '';
  const provided = summary.photoProvided?.[photo]?.caption;
  const [draft, setDraft] = useState<string>();
  // Read when the field goes away, after its last render.
  const typed = useRef<string>(undefined);
  const live = useRef({ saved, save });
  live.current = { saved, save };
  const type = (value: string | undefined) => { typed.current = value; setDraft(value); };
  const commit = () => {
    const value = typed.current;
    typed.current = undefined;
    if (value !== undefined && value !== live.current.saved) live.current.save(value);
  };
  useEffect(() => { if (typed.current === undefined) setDraft(undefined); }, [saved]);
  useEffect(() => () => commit(), []);
  const places = usage.photo[photo]?.length ?? 0;
  return <div className="field caption-field">
    <label className="field-name" htmlFor={id}>{label}</label>
    <textarea id={id} rows={3} value={draft ?? saved} placeholder={provided} aria-label={'Caption of ' + photoName(summary, photo)}
      data-autofocus={autoFocus || undefined} onFocus={autoFocus ? (event) => event.target.select() : undefined}
      onChange={(event) => type(event.target.value)} onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Escape') type(undefined);
        // ⌘Return saves; it closes the caption's own panel, or is left to the editor around the field, which closes then.
        else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          commit();
          if (done) { event.preventDefault(); event.stopPropagation(); done(); }
        }
        else if (event.key === 'Enter') event.stopPropagation();
      }} />
    <small className="field-description">{places > 1 ? 'Belongs to the photo, also in the ' + (places - 1) + (places === 2 ? ' other place' : ' other places') + ' it is placed.' : 'Belongs to the photo, wherever it is placed.'}</small>
  </div>;
}

// The crop toolbar's Caption… button, beside the box's own settings such as Show caption, and its small panel.
export function CaptionButton({ summary, photo, usage, save, request }: {
  summary: ProjectSummary; photo: string; usage: SourceUsage; save: (caption: string) => void;
  // Opens the panel at once, for Edit Caption… in a context menu; a new number asks again.
  request?: number;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(request !== undefined);
  const close = () => { setOpen(false); root.current?.querySelector('button')?.focus(); };
  useEffect(() => { if (request !== undefined) setOpen(true); }, [request]);
  useEffect(() => {
    if (!open) return;
    root.current?.querySelector('textarea')?.focus();
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    // After the field's own handler, which takes back what was typed.
    const keys = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', keys);
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', keys); };
  }, [open]);
  return <div ref={root} className="crop-actions">
    <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>Caption…</button>
    {open && <div className="crop-action-panel" role="dialog" aria-label="Photo caption">
      <header><strong>Caption</strong><button type="button" aria-label="Close caption" onClick={close}>×</button></header>
      <CaptionField key={photo} summary={summary} photo={photo} usage={usage} save={save} autoFocus done={close} label="Text" />
    </div>}
  </div>;
}
