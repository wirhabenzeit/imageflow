import { outOfDateNote, photoName, photoSourceName, sourceFile, sourcePath } from './source-locations';
import { SourceBadge, sourceOrigin } from './SourceBadge';
import { asidePlace, usageLabel } from './asset-usage';
import { Fragment, useMemo, useState } from 'react';
import { renderOrigin } from './desktop';
import type { ProjectSummary, RenderStatus, TemplateInfo } from './desktop';
import type { SourceUsage } from './editing';
import { sheetLayoutLabel } from './layouts';
import { Field } from './Fields';
import type { Edit } from './Inspector';
import { markdownToHtml } from './markdown';
import { fileName, metaText, words } from './source-items';
import { splitFrontmatter } from './frontmatter';
import type { SourceRef } from './source-items';
import { captureFact, photoDate } from './photo-view';
import { bookPhotoMarks } from './source-properties';
import { MarkFacts } from './SourceMarks';

const photoFields = [['title', 'Title'], ['caption', 'Caption'], ['credit', 'Credit'], ['altText', 'Alt text']] as const;

// Where a source is placed, as links that select the spread.
function Placements({ summary, template, usage, render, source, select }: {
  summary: ProjectSummary; template?: TemplateInfo; usage: SourceUsage; render?: RenderStatus;
  source: SourceRef; select: (spread: string) => void;
}) {
  const placed = usage[source.kind][source.id] ?? [];
  const aside = usage.aside?.[source.kind][source.id] ?? [];
  // Set aside is not placed, but the spread that keeps it can be gone to (UI-016).
  const kept = aside.length > 0 && <ul className="si-placements">{aside.map(({ spread, pages }) => <li key={spread}>
    <span className="muted">Set aside on </span><button type="button" className="link" onClick={() => select(spread)}>{asidePlace(pages)}</button></li>)}</ul>;
  if (!placed.length) return <><p className="muted">Not placed</p>{kept}</>;
  return <><ul className="si-placements">
    {placed.map(({ spread: id, pages, cover }) => {
      const spread = summary.project.spreads.find((item) => item.id === id);
      const layout = cover && summary.project.cover ? template?.coverLayouts?.[summary.project.cover.definition]?.label
        : spread && (sheetLayoutLabel(template?.spreads, spread) ?? spread.definition);
      const parts = source.kind === 'text' && spread && render?.state === 'ready'
        ? Object.entries(spread.boxes).filter(([, box]) => box.text === source.id)
          .map(([box]) => render.flow[id + ':' + box]).filter(Boolean) : [];
      return <li key={id}>
        <button type="button" className="link" onClick={() => select(id)}>{usageLabel(pages)}</button>
        {layout && <span className="muted"> · {layout}{parts.length ? ' · part ' + parts.map(({ part }) => part).join(', ') + ' of ' + parts[0].parts : ''}</span>}
      </li>;
    })}
  </ul>{kept}</>;
}

// The Inspector for a photo or Markdown source selected in the source strip.
export function SourceInspector({ summary, source, template, render, usage, writable, edit, select, quickLook }: {
  summary: ProjectSummary; source: SourceRef; template?: TemplateInfo; render?: RenderStatus; usage: SourceUsage;
  writable: boolean; edit: (change: Edit, notice?: string) => void; select: (spread: string) => void; quickLook: () => void;
}) {
  const [openError, setOpenError] = useState('');
  const text = source.kind === 'text' ? summary.texts[source.id] : undefined;
  const html = useMemo(() => text === undefined ? undefined : markdownToHtml(text), [text]);
  const header = useMemo(() => text === undefined ? undefined : splitFrontmatter(text), [text]);

  if (source.kind === 'photo') {
    const photo = summary.photoIndex[source.id];
    if (!photo) return <p className="muted">This photo is no longer in the project.</p>;
    const size = summary.photoSizes[source.id];
    const profileStart = import.meta.env.IMAGEFLOW_PROFILE ? performance.now() : 0;
    const date = captureFact(photoDate(summary, source.id));
    if (import.meta.env.IMAGEFLOW_PROFILE) performance.measure('imageflow.captureFact', { start: profileStart, end: performance.now() });
    const ppi = template?.format.output.resolution?.target;
    const print = size && ppi && [size.width, size.height].map((px) => (px / ppi * 2.54).toFixed(1)).join(' × ');
    const status = summary.sources?.['photo:' + source.id];
    const file = status && sourceFile(status);
    const origin = sourceOrigin(status);
    // What the photo's provider reports for each field (ADR 0011): shown while the book has no value of its own, which
    // Revert removes again.
    const provided = summary.photoProvided?.[source.id];
    // The marks of its provider's library (ADR 0014), read-only and whatever the thumbnails show; none for an unmarked photo.
    const marks = bookPhotoMarks(summary, source.id);
    return <div className="source-inspector">
      <div className="si-head">
        <p className="eyebrow">Photo</p>
        <h2>{photoName(summary, source.id)}</h2>
        <p className="muted si-source">{origin && <SourceBadge origin={origin} labelled />}<span title={file?.path}>{photoSourceName(summary, source.id)}</span></p>
        {status?.outOfDate && <p className="muted">{outOfDateNote(status)}</p>}
        {status?.pending ? <p className="muted">{status.problem}</p> : summary.sources?.['photo:' + source.id]?.problem && <p className={status?.away ? 'muted' : 'error-text'}>{summary.sources['photo:' + source.id].problem}{summary.sources['photo:' + source.id].cached ? ' · Showing cached preview' : ''}</p>}
      </div>
      {summary.photos[source.id]
        ? <button type="button" className="si-preview" title="Quick Look (Space)" onClick={quickLook}>
            <img src={renderOrigin + '/render/' + summary.id + '/photo/' + source.id} alt={photo.altText || photo.title || ''} />
          </button>
        : status?.pending ? null : <p className="error-text">{file ? 'The photo file is missing from photos/.' : 'No preview of this photo is on this Mac.'}</p>}
      {(date || size || marks.length > 0) && <dl className="si-facts">
        {date && <><dt className={photoDate(summary, source.id)?.capturedEstimated ? 'muted' : undefined}>{date.label}</dt><dd title={date.title} className={photoDate(summary, source.id)?.capturedEstimated ? 'muted' : undefined}>{date.value}</dd></>}
        {size && <><dt>Size</dt><dd>{size.width} × {size.height} px · {(size.width * size.height / 1e6).toFixed(1)} MP</dd></>}
        {print && <><dt>Prints up to</dt><dd>{print} cm at {ppi} ppi</dd></>}
        <MarkFacts marks={marks} />
      </dl>}
      <details open><summary>Placed on</summary>
        <Placements summary={summary} template={template} usage={usage} render={render} source={source} select={select} />
      </details>
      <details open><summary>Details</summary>
        <fieldset disabled={!writable}>
          {photoFields.map(([key, label]) => {
            const overridden = provided?.[key] !== undefined && Object.hasOwn(photo, key);
            return <Fragment key={source.id + ':' + key}>
              <Field param={{ type: 'string', label: overridden ? label + ' (changed in this book)' : label, default: '', multiline: key === 'caption' || key === 'altText',
                ...(provided?.[key] ? { placeholder: provided[key] } : {}) }} value={photo[key] ?? ''}
                change={(value) => edit(({ photoIndex }) => { if (photoIndex[source.id]) photoIndex[source.id][key] = String(value); }, label + ' updated')} />
              {overridden && <button type="button" className="link si-revert" onClick={() => edit(({ photoIndex }) => { if (photoIndex[source.id]) delete photoIndex[source.id][key]; }, label + ' reverted')}>
                Revert to the source’s {label.toLocaleLowerCase()}</button>}
            </Fragment>;
          })}
        </fieldset>
      </details>
    </div>;
  }

  const path = summary.project.texts[source.id];
  if (!path) return <p className="muted">This text is no longer in the project.</p>;
  const headings = header?.body.split('\n').filter((line) => /^#{1,6}\s/.test(line)).length ?? 0;
  // A header's fields, as the template reads them (text.meta); the text itself leaves them out.
  const fields = Object.entries(header?.meta ?? {});
  return <div className="source-inspector">
    <div className="si-head">
      <p className="eyebrow">Text</p>
      <h2>{fileName(path)}</h2>
      <p className="muted si-source">{(() => { const origin = sourceOrigin(summary.sources?.['markdown:' + source.id]); return origin && <SourceBadge origin={origin} labelled />; })()}<span>{sourcePath(path)}</span></p>
      {summary.sources?.['markdown:' + source.id]?.problem && <p className="error-text">{summary.sources['markdown:' + source.id].problem}{summary.sources['markdown:' + source.id].cached ? ' · Showing cached text' : ''}</p>}
    </div>
    {text === undefined ? <p className="error-text">The Markdown file is missing or unreadable.</p> : <dl className="si-facts">
      <dt>Length</dt><dd>{words(text)} words · {text.length} characters</dd>
      {headings > 0 && <><dt>Headings</dt><dd>{headings}</dd></>}
    </dl>}
    {header?.error && <p className="error-text">Header, line {header.error.line}: {header.error.message}</p>}
    {fields.length > 0 && <details open><summary>Header</summary>
      <dl className="si-facts si-header">{fields.map(([key, value]) => <Fragment key={key}>
        <dt>{key}</dt><dd title={metaText(value)}>{metaText(value)}</dd>
      </Fragment>)}</dl>
    </details>}
    <details open><summary>Placed on</summary>
      <Placements summary={summary} template={template} usage={usage} render={render} source={source} select={select} />
    </details>
    {writable && <button type="button" onClick={() => {
      setOpenError('');
      void window.imageflow?.documentAction('text', source.id).then((result) => { if ('error' in result) setOpenError(result.error); });
    }}>Open in Editor</button>}
    {openError && <p role="alert" className="error-text">{openError}</p>}
    {html !== undefined && <details open><summary>Preview</summary>
      <button type="button" className="si-text-preview" title="Quick Look (Space)" onClick={quickLook}>
        <div className="ql-markdown" dangerouslySetInnerHTML={{ __html: html }} />
      </button>
    </details>}
  </div>;
}

