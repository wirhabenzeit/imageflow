import { sourcePath } from './source-locations';
import { useMemo, useState } from 'react';
import { renderOrigin } from './desktop';
import type { ProjectSummary, RenderStatus, TemplateInfo } from './desktop';
import type { SourceUsage } from './editing';
import { Field } from './Fields';
import type { Edit } from './Inspector';
import { markdownToHtml } from './markdown';
import { fileName, words } from './source-items';
import type { SourceRef } from './source-items';
import { captureFact, photoDate } from './photo-view';

const photoFields = [['title', 'Title'], ['caption', 'Caption'], ['credit', 'Credit'], ['altText', 'Alt text']] as const;

// Where a source is placed, as links that select the spread.
function Placements({ summary, template, usage, render, source, select }: {
  summary: ProjectSummary; template?: TemplateInfo; usage: SourceUsage; render?: RenderStatus;
  source: SourceRef; select: (spread: string) => void;
}) {
  const placed = usage[source.kind][source.id] ?? [];
  if (!placed.length) return <p className="muted">Not placed</p>;
  return <ul className="si-placements">
    {placed.map(({ spread: id, pages }) => {
      const spread = summary.project.spreads.find((item) => item.id === id);
      const layout = spread && (template?.spreads[spread.definition]?.label ?? spread.definition);
      const parts = source.kind === 'text' && spread && render?.state === 'ready'
        ? Object.entries(spread.boxes).filter(([, box]) => box.text === source.id)
          .map(([box]) => render.flow[id + ':' + box]).filter(Boolean) : [];
      return <li key={id}>
        <button type="button" className="link" onClick={() => select(id)}>{(pages.includes('–') ? 'Pages ' : 'Page ') + pages}</button>
        <span className="muted"> · {layout}{parts.length ? ' · part ' + parts.map(({ part }) => part).join(', ') + ' of ' + parts[0].parts : ''}</span>
      </li>;
    })}
  </ul>;
}

// The Inspector for a photo or Markdown source selected in the source strip.
export function SourceInspector({ summary, source, template, render, usage, writable, edit, select, quickLook }: {
  summary: ProjectSummary; source: SourceRef; template?: TemplateInfo; render?: RenderStatus; usage: SourceUsage;
  writable: boolean; edit: (change: Edit, notice?: string) => void; select: (spread: string) => void; quickLook: () => void;
}) {
  const [openError, setOpenError] = useState('');
  const text = source.kind === 'text' ? summary.texts[source.id] : undefined;
  const html = useMemo(() => text === undefined ? undefined : markdownToHtml(text), [text]);

  if (source.kind === 'photo') {
    const photo = summary.photoIndex[source.id];
    if (!photo) return <p className="muted">This photo is no longer in the project.</p>;
    const size = summary.photoSizes[source.id];
    const date = captureFact(photoDate(summary, source.id));
    const ppi = template?.format.output.resolution?.target;
    const print = size && ppi && [size.width, size.height].map((px) => (px / ppi * 2.54).toFixed(1)).join(' × ');
    return <div className="source-inspector">
      <div className="si-head">
        <p className="eyebrow">Photo</p>
        <h2>{photo.title || fileName(photo.path)}</h2>
        <p className="muted">{photo.linked ? 'Linked · ' : 'In book · '}{fileName(photo.path)}</p>
        {summary.sources?.['photo:' + source.id]?.problem && <p className="error-text">{summary.sources['photo:' + source.id].problem}{summary.sources['photo:' + source.id].cached ? ' · Showing cached preview' : ''}</p>}
      </div>
      {summary.photos[source.id]
        ? <button type="button" className="si-preview" title="Quick Look (Space)" onClick={quickLook}>
            <img src={renderOrigin + '/render/' + summary.id + '/photo/' + source.id} alt={photo.altText || photo.title || ''} />
          </button>
        : <p className="error-text">The photo file is missing from photos/.</p>}
      {(date || size) && <dl className="si-facts">
        {date && <><dt className={photoDate(summary, source.id)?.capturedEstimated ? 'muted' : undefined}>{date.label}</dt><dd title={date.title} className={photoDate(summary, source.id)?.capturedEstimated ? 'muted' : undefined}>{date.value}</dd></>}
        {size && <><dt>Size</dt><dd>{size.width} × {size.height} px · {(size.width * size.height / 1e6).toFixed(1)} MP</dd></>}
        {print && <><dt>Prints up to</dt><dd>{print} cm at {ppi} ppi</dd></>}
      </dl>}
      <details open><summary>Placed on</summary>
        <Placements summary={summary} template={template} usage={usage} render={render} source={source} select={select} />
      </details>
      <details open><summary>Details</summary>
        <fieldset disabled={!writable}>
          {photoFields.map(([key, label]) => <Field key={source.id + ':' + key}
            param={{ type: 'string', label, default: '', multiline: key === 'caption' || key === 'altText' }} value={photo[key] ?? ''}
            change={(value) => edit(({ photoIndex }) => { if (photoIndex[source.id]) photoIndex[source.id][key] = String(value); }, label + ' updated')} />)}
        </fieldset>
      </details>
    </div>;
  }

  const path = summary.project.texts[source.id];
  if (!path) return <p className="muted">This text is no longer in the project.</p>;
  const headings = text?.split('\n').filter((line) => /^#{1,6}\s/.test(line)).length ?? 0;
  return <div className="source-inspector">
    <div className="si-head">
      <p className="eyebrow">Text</p>
      <h2>{fileName(path)}</h2>
      <p className="muted">{sourcePath(path)}</p>
      {summary.sources?.['markdown:' + source.id]?.problem && <p className="error-text">{summary.sources['markdown:' + source.id].problem}{summary.sources['markdown:' + source.id].cached ? ' · Showing cached text' : ''}</p>}
    </div>
    {text === undefined ? <p className="error-text">The Markdown file is missing or unreadable.</p> : <dl className="si-facts">
      <dt>Length</dt><dd>{words(text)} words · {text.length} characters</dd>
      {headings > 0 && <><dt>Headings</dt><dd>{headings}</dd></>}
    </dl>}
    <details open><summary>Placed on</summary>
      <Placements summary={summary} template={template} usage={usage} render={render} source={source} select={select} />
    </details>
    {!summary.readOnly && <button type="button" onClick={() => {
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
