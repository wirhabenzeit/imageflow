import { Field } from './Fields';
import type { ProjectSummary } from './desktop';
import type { SpreadState } from './project';
import type { SourceRef } from './source-items';
import { centered, placementIn, setPlacement } from './spread';

// The platform's part of a box editor: what fills the box. Photos and Markdown are ImageFlow's own content, so
// their assignment, crop and text flow are edited here, next to the template's box parameters, wherever the box
// is edited (its popover on the page, or the crop toolbar of a selected photo).

type Change = (update: (spread: SpreadState) => void, notice?: string) => void;

// Choose, replace or remove the photo of a box from the keyboard; the canvas and photo strip are drag-only.
export function PhotoContent({ summary, spread, box, label, change, inspect, adjustCrop, values = false, compact = false, assigned: reassigned }: {
  summary: ProjectSummary; spread: SpreadState; box: string; label: string; change: Change;
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
  const pick = <select className="box-photo-pick" aria-label={(assigned ? 'Replace photo in ' : 'Choose photo for ') + label} value=""
    onChange={(event) => {
      const photo = event.target.value;
      if (!photo || photo === assigned) return;
      reassigned?.();
      change((item) => {
        item.boxes[box] = { params: item.boxes[box]?.params ?? {}, photo };
      }, (summary.photoIndex[photo]?.title || photo) + ' placed in ' + label);
    }}>
    <option value="">{assigned ? 'Replace photo…' : 'Choose photo…'}</option>
    {Object.entries(summary.photoIndex).filter(([photo]) => photo !== assigned).map(([photo, entry]) =>
      <option key={photo} value={photo} disabled={!summary.photos[photo]}>
        {(entry.title || entry.path.split('/').pop()) + (summary.photos[photo] ? '' : ' (missing)')}</option>)}
  </select>;
  const remove = assigned && <button type="button" className="link" onClick={() => {
    reassigned?.();
    change((item) => {
      if (item.boxes[box]) item.boxes[box] = { params: item.boxes[box].params };
    }, 'Photo removed from ' + label);
  }}>Remove</button>;
  const cropValues = values && assigned && <details className="crop-values"><summary>Crop values</summary><div className="crop-values-fields">
    {([['centerX', 'Horizontal'], ['centerY', 'Vertical'], ['zoom', 'Zoom']] as const).map(([key, name]) =>
      <Field key={key}
        param={{ type: 'number', label: name, default: centered[key], min: key === 'zoom' ? 1 : 0, max: key === 'zoom' ? 20 : 1, step: .01 }}
        value={placement[key]}
        change={(value) => change((item) => {
          const state = item.boxes[box];
          if (state?.photo) setPlacement(state, item.definition, { ...placementIn(state, item.definition), [key]: value });
        })} />,
    )}
  </div></details>;
  if (compact) return <div className="box-content compact">{pick}{remove}{cropValues}</div>;
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
    {assigned && (adjustCrop || moved || values) && <div className="crop-controls">
      <p className="muted">{placement.zoom !== 1 ? 'Zoomed ' + placement.zoom.toFixed(1) + '×' : 'Fills the frame'}
        {moved ? ' · moved' : ''}{moved && !ownCrop ? ' · from another layout' : ''}</p>
      <div className="box-actions">
        {adjustCrop && <button type="button" onClick={adjustCrop}>Adjust crop…</button>}
        {moved && <button type="button" onClick={() => change((item) => {
          if (item.boxes[box]?.photo) setPlacement(item.boxes[box], item.definition, centered);
        }, 'Crop reset')}>Reset crop</button>}
      </div>
      {cropValues}
    </div>}
  </div>;
}

// Assign a Markdown source to a box, import one, or show it; and where the box sits in its text's flow.
export function TextContent({ summary, spread, box, label, change, importText, inspect, flow }: {
  summary: ProjectSummary; spread: SpreadState; box: string; label: string; change: Change;
  importText: () => void; inspect?: (source: SourceRef) => void; flow?: { part: number; parts: number };
}) {
  const assigned = spread.boxes[box]?.text;
  const choices = Object.entries(summary.project.texts).map(([id, path]) => [id, path.split('/').pop()] as const);
  return <div className="box-content">
    <label className="field">Markdown
      <select aria-label={label + ' assignment'} value={assigned ?? ''} onChange={(event) => {
        const value = event.target.value;
        change((item) => {
          item.boxes[box] = { params: item.boxes[box]?.params ?? {}, text: value || undefined };
        }, (value ? (summary.project.texts[value]?.split('/').pop() ?? value) + ' placed in ' : 'Text removed from ') + label);
      }}>
        <option value="">Unassigned</option>
        {assigned && !choices.some(([id]) => id === assigned) && <option value={assigned}>Missing · {assigned}</option>}
        {choices.map(([id, name]) => <option value={id} key={id}>{name ?? id}</option>)}
      </select>
    </label>
    <div className="box-actions">
      {assigned && summary.project.texts[assigned] && inspect &&
        <button type="button" onClick={() => inspect({ kind: 'text', id: assigned })}>Show text</button>}
      <button type="button" onClick={importText}>Import Markdown…</button>
    </div>
    {flow && <p className="muted">Flow {flow.part} of {flow.parts}</p>}
  </div>;
}
